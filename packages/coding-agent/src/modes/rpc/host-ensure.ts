import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENV_AGENT_DIR, getAgentDir, isBunBinary } from "../../config.ts";
import { engineBuildIdentity } from "../../core/engine-build-identity.ts";
import {
	type DaemonPidFile,
	ProcessIdentityUnreadableError,
	parseDaemonPidFile,
	processIsLive,
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../app-server/daemon/process.ts";
import {
	CUSTOM_UNSUPPORTED_CAPABILITY,
	EXTENSION_EVENTS_CAPABILITY,
	RPC_CLIENT_CAPABILITIES_ENV,
} from "./custom-capability.ts";
import {
	decideHostAction,
	HOST_PROTOCOL_VERSION,
	type HostDecisionClient,
	HostEnsureRefusedError,
	type HostProtocolInfo,
	parseHostProtocolInfo,
	REQUIRED_HOST_CAPABILITIES,
} from "./host-decision.ts";
import {
	DEFAULT_HOST_IDLE_EXIT_MS,
	type HostColdStart,
	type HostLifecyclePolicyInput,
	INTERNAL_SUPERVISOR_FLAG,
} from "./host-lifecycle.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";
import {
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "./socket-transport.ts";

export type { HostColdStart, HostLifecyclePolicyInput };

export interface HostDaemonPaths {
	readonly dir: string;
	readonly pidFile: string;
	readonly lockFile: string;
	readonly settingsFile: string;
	readonly stderrLog: string;
}

export interface EnsureHostOptions {
	readonly socket: string;
	readonly agentDir?: string;
	/** Host lifecycle policy recorded in settings.json (env overrides win at runtime). */
	readonly policy?: HostLifecyclePolicyInput;
	readonly _test?: {
		readonly readinessTimeoutMs?: number;
		readonly stopTimeoutMs?: number;
		readonly spawn?: { readonly command: string; readonly args: readonly string[] };
		/** Extra env merged over process.env for the spawned host (hermetic test/QA wiring). */
		readonly env?: Readonly<Record<string, string>>;
		/** Extra CLI args forwarded through the supervisor to the host process. */
		readonly hostArgs?: readonly string[];
		/** Runs after endpoint ownership is locked; deterministic concurrency-test gate. */
		readonly afterLockAcquired?: () => Promise<void>;
		/**
		 * Runs after the child is spawned but before its pidfile is registered, so a
		 * test can force the startup failure a loaded runner produces without having
		 * to stall the real process-identity probe.
		 */
		readonly beforePidFileWrite?: () => Promise<void>;
		/** Overrides the process-identity probe so a test can force its failure. */
		readonly readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	};
}

export interface EnsuredHost {
	readonly pid: number;
	readonly socket: string;
	readonly reused: boolean;
}

const SPAWNED_HOST_PROBE_TIMEOUT_MS = 10_000;
const EXISTING_HOST_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const SIGKILL_GRACE_MS = 2_000;
/**
 * A lock waiter must outlast the longest critical section a holder can run:
 * probing an existing host, stopping an incompatible one (SIGTERM wait plus the
 * SIGKILL grace), then spawning the replacement and waiting for it to answer.
 * Each SQLite busy wait stays short because it blocks the event loop; this
 * cumulative budget is what covers the whole section, with headroom for a slow
 * runner. A waiter that gives up early surfaces as a raw "database is locked"
 * failure on the second of two concurrent starts.
 */
const ENSURE_LOCK_WAIT_MS =
	EXISTING_HOST_PROBE_TIMEOUT_MS + DEFAULT_STOP_TIMEOUT_MS + SIGKILL_GRACE_MS + DEFAULT_READINESS_TIMEOUT_MS + 10_000;
const LOCK_BUSY_WAIT_MS = 100;
const lockOptions = {
	retries: { retries: ENSURE_LOCK_WAIT_MS / LOCK_BUSY_WAIT_MS, minTimeout: 20, maxTimeout: LOCK_BUSY_WAIT_MS },
} as const;
/**
 * Every ensured host starts with this installation-wide profile, independent of
 * the first caller. In particular, extension_events must remain available when
 * a terminal client starts the shared host before the desktop connects.
 */
export const PINNED_HOST_CLIENT_CAPABILITIES = [EXTENSION_EVENTS_CAPABILITY, CUSTOM_UNSUPPORTED_CAPABILITY] as const;

export function createHostDaemonPaths(agentDir = getAgentDir()): HostDaemonPaths {
	const dir = join(agentDir, "rpc-host-daemon");
	return {
		dir,
		pidFile: join(dir, "host.pid"),
		lockFile: join(dir, "daemon.lock"),
		settingsFile: join(dir, "settings.json"),
		stderrLog: join(dir, "stderr.log"),
	};
}

export async function ensureHost(options: EnsureHostOptions): Promise<EnsuredHost> {
	const socket = normalizeSocketPath(options.socket);
	const paths = createHostDaemonPaths(options.agentDir);
	await mkdir(paths.dir, { recursive: true });
	// The public socket is the shared resource; agent directories are not a
	// sufficient lock scope when two installations target the same endpoint.
	const lockTarget = join(tmpdir(), "senpi-rpc-host-locks", createSocketLockName(socket));
	await mkdir(dirname(lockTarget), { recursive: true });
	await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
	// Opportunistic GC of other installs' leftovers stays OUTSIDE the endpoint lock.
	// Its cost scales with the whole tmpdir and, on win32, adds a ~1s process probe per
	// candidate; inside the critical section that inflated the hold for every concurrent
	// ensureHost until a waiter exhausted its budget and surfaced a raw "database is
	// locked". Its own guards (60s age, dead owner pid) already make it safe unlocked.
	await reapOrphanedInternalHostDirs();
	const release = await acquireOwnershipSafeLock(`${lockTarget}.lock`, lockOptions);
	try {
		await options._test?.afterLockAcquired?.();
		return await ensureHostLocked(paths, socket, options.agentDir ?? getAgentDir(), options.policy, options._test);
	} finally {
		await release();
	}
}

async function ensureHostLocked(
	paths: HostDaemonPaths,
	socket: string,
	agentDir: string,
	policy: HostLifecyclePolicyInput | undefined,
	testOptions: EnsureHostOptions["_test"],
): Promise<EnsuredHost> {
	const registered = await readPidFile(paths);
	const protocol = await probeProtocolInfo(socket, EXISTING_HOST_PROBE_TIMEOUT_MS);
	const startedByUs = await writtenByThisProcess(registered?.writer);
	const decision = decideHostAction(ensureClient(startedByUs), protocol, "never");
	switch (decision.action) {
		case "reuse":
			// A compatible socket is attachable even when another client surface
			// started it. Only hosts we spawned are eligible for lifecycle management.
			return { pid: registered?.record.pid ?? 0, socket, reused: true };
		case "refuse":
			throw new HostEnsureRefusedError(socket, decision.reason, protocol);
		case "start":
			break;
		default:
			return assertNever(decision);
	}
	const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
	const pidMatches = registered ? await matchesPidFileOrUnknown(registered.record, probe) : false;
	if (registered && pidMatches) {
		// I1: the socket is silent, but the process behind it is alive. Only the process that WROTE
		// this record may end it - anyone else refuses rather than signalling somebody else's host.
		if (!startedByUs) throw new HostEnsureRefusedError(socket, "foreign_writer", protocol);
		await stopManagedHost(registered.record, testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, probe);
	}
	await cleanupState(paths);
	return startHost(paths, socket, agentDir, policy, testOptions);
}

/** This build as a client: which protocol it speaks, what it needs from a host, and which build it is. */
function ensureClient(startedByUs: boolean): HostDecisionClient {
	return {
		protocolVersion: HOST_PROTOCOL_VERSION,
		requiredCapabilities: REQUIRED_HOST_CAPABILITIES,
		identity: engineBuildIdentity(),
		// ensureHost carries no launch spec of its own: it attaches or starts, and never upgrades.
		startedByUs,
		platform: process.platform,
	};
}

/**
 * I1 in one predicate: the pidfile names a host THIS process started. The recorded start time is what
 * survives a pid the OS recycled, and a writer that cannot be proven ours reads as foreign - so the
 * worst case of an unreadable identity is a refusal, never a signal sent to another owner's host.
 */
async function writtenByThisProcess(writer: HostPidFileWriter | undefined): Promise<boolean> {
	if (writer === undefined || writer.pid !== process.pid || writer.startTime === null) return false;
	return writer.startTime === (await thisProcessStartTime());
}

let selfStartTime: Promise<string | null> | undefined;

function thisProcessStartTime(): Promise<string | null> {
	selfStartTime ??= readProcessStartTime(process.pid).then(
		(value) => value ?? null,
		() => null,
	);
	return selfStartTime;
}

async function startHost(
	paths: HostDaemonPaths,
	socket: string,
	agentDir: string,
	policy: HostLifecyclePolicyInput | undefined,
	testOptions: EnsureHostOptions["_test"],
): Promise<EnsuredHost> {
	// The settings file must exist before the supervisor reads it at boot, so it
	// records the policy before the spawn instead of beside the pidfile.
	if (process.platform === "win32") await createSocketSecret(socketSecretPath(socket));
	await writeFile(
		paths.settingsFile,
		`${JSON.stringify({
			socket,
			capabilities: PINNED_HOST_CLIENT_CAPABILITIES,
			coldStart: policy?.coldStart ?? "transient",
			idleExitMs: policy?.idleExitMs ?? DEFAULT_HOST_IDLE_EXIT_MS,
		})}\n`,
		{ mode: 0o600 },
	);
	const stderr = await open(paths.stderrLog, "w", 0o600);
	let pidFile: DaemonPidFile | undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let exitedEarly: ChildExit | undefined;
	let childExit: Promise<ChildExit> | undefined;
	try {
		const launch = testOptions?.spawn ?? defaultHostLaunch(socket, testOptions?.hostArgs ?? []);
		child = spawn(launch.command, [...launch.args], {
			detached: true,
			windowsHide: true,
			env: {
				...process.env,
				...(testOptions?.env ?? {}),
				[ENV_AGENT_DIR]: agentDir,
				[RPC_CLIENT_CAPABILITIES_ENV]: PINNED_HOST_CLIENT_CAPABILITIES.join(","),
			},
			stdio: ["ignore", "ignore", stderr.fd],
		});
		childExit = new Promise((resolveExit) => {
			child!.once("exit", (code, signal) => {
				exitedEarly = { code, signal };
				resolveExit(exitedEarly);
			});
		});
		if (child.pid === undefined) throw new Error("failed to spawn RPC socket host");
		const probe = testOptions?.readProcessStartTime ?? readProcessStartTime;
		const observedStartTime = await Promise.race([
			waitForStartTime(child.pid, 10_000, probe),
			childExit.then(() => {
				throw new Error("RPC socket host exited before its start time could be read");
			}),
		]);
		// UNKNOWN identity on a live child: the probe was starved, not the host. Give the CIM table
		// one unhurried read (the per-attempt win32 default is 1s, which a loaded runner exceeds on
		// every attempt) before deciding.
		const unhurriedProbe = testOptions?.readProcessStartTime
			? testOptions.readProcessStartTime
			: (pid: number) => readProcessStartTime(pid, process.platform, 15_000);
		const processStartTime = observedStartTime ?? (await unhurriedProbe(child.pid).catch(() => undefined));
		// Still unreadable: the host is ours, alive, and about to prove itself on the socket, so it is
		// registered WITHOUT an ownership guard instead of being torn down for a starved probe. A
		// guard-less record never claims ownership and never authorizes a signal - every later caller
		// reads it as unknown - so the worst case is a fresh host next time, not a killed healthy one.
		pidFile = { pid: child.pid, processStartTime: processStartTime ?? null };
		await testOptions?.beforePidFileWrite?.();
		// The writer stamp is what authorizes a later stop: only the process that wrote this record
		// may signal the host it names, and the start time keeps a recycled pid from inheriting that right.
		const writer: HostPidFileWriter = { pid: process.pid, startTime: await thisProcessStartTime() };
		await writeFile(paths.pidFile, `${JSON.stringify({ ...pidFile, writer })}\n`, { mode: 0o600 });
		child.unref();
	} catch (error: unknown) {
		// Whether the child died on its own decides which diagnostic is true, and the
		// cleanup kill below records an `exitedEarly` indistinguishable from a real
		// self-exit. Latch it before killing, or the catch reports the SIGTERM it is
		// about to send and discards the actual startup failure.
		const exitedBeforeCleanup = exitedEarly;
		// Keep the ChildProcess handle owned until registration succeeds. If startup
		// fails before the pidfile is written, terminate this exact child through
		// its still-attached handle rather than leaving an unmanaged daemon behind.
		if (!exitedBeforeCleanup && child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {}
			if (childExit) await Promise.race([childExit, delay(2_000)]);
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
		}
		if (!exitedBeforeCleanup) {
			await cleanupState(paths);
			throw error;
		}
		const diagnostic = await appendStderr(
			paths,
			`RPC socket host exited with code ${exitedBeforeCleanup.code ?? "null"}${exitedBeforeCleanup.signal ? ` (${exitedBeforeCleanup.signal})` : ""} before answering get_protocol_info`,
		);
		await cleanupState(paths);
		throw new Error(diagnostic);
	} finally {
		await stderr.close();
	}
	const readinessTimeoutMs = testOptions?.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
	const result = await pollProtocolInfo(socket, readinessTimeoutMs, childExit);
	if (isCompatible(result.protocol)) return { pid: pidFile.pid, socket, reused: false };
	// Teardown runs for the diagnostic's sake, so it must never replace it: a stop
	// failure here (unreadable identity, a host that outlives SIGKILL) would other-
	// wise propagate instead of the readiness message and skip cleanupState below,
	// leaving the pidfile and socket behind. Record it and keep going.
	// This child is ours and its handle is still attached: stop it through the handle.
	// Validating ownership through the pidfile would re-run the identity probe whose
	// failure is the very thing a loaded runner produces here.
	const stopFailure = await stopSpawnedChild(
		child,
		childExit,
		testOptions?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
	).then(
		() => undefined,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	const message = result.protocol
		? `RPC socket host answered get_protocol_info with protocolVersion ${result.protocol.protocolVersion}, serverVersion ${result.protocol.serverVersion} and capabilities ${JSON.stringify(result.protocol.capabilities)}, but is incompatible with protocol version ${HOST_PROTOCOL_VERSION} and required capabilities ${JSON.stringify(REQUIRED_HOST_CAPABILITIES)}`
		: result.exited
			? `RPC socket host exited with code ${result.exited.code ?? "null"}${result.exited.signal ? ` (${result.exited.signal})` : ""} before answering get_protocol_info`
			: `spawned RPC socket host did not answer get_protocol_info within ${readinessTimeoutMs}ms`;
	const diagnostic = await appendStderr(
		paths,
		stopFailure === undefined ? message : `${message} (teardown also reported: ${stopFailure})`,
	);
	await cleanupState(paths);
	// The supervisor may have failed before binding, or another owner may have
	// appeared while readiness was being checked. Never unlink an endpoint we
	// cannot prove this start owned.
	throw new Error(diagnostic);
}

/**
 * Ownership for the reuse decision. An identity we cannot read proves nothing: it can neither
 * claim the host nor authorize a kill, so it reads as "not ours" and the caller starts fresh
 * rather than failing the whole ensure on an observation gap.
 */
async function matchesPidFileOrUnknown(
	pidFile: DaemonPidFile,
	probe: (pid: number) => Promise<string | undefined>,
): Promise<boolean> {
	try {
		return await processMatchesPidFile(pidFile, probe);
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return false;
		throw error;
	}
}

async function stopSpawnedChild(
	child: ChildProcess,
	childExit: Promise<ChildExit>,
	termTimeoutMs: number,
): Promise<void> {
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	if (exited()) return;
	const signal = (name: NodeJS.Signals) => {
		try {
			child.kill(name);
		} catch (error: unknown) {
			if (!isNodeErrorCode(error, "ESRCH")) throw error;
		}
	};
	const waitFor = (ms: number) => Promise.race([childExit.then(() => true), delay(ms).then(() => exited())]);
	signal("SIGTERM");
	if (await waitFor(termTimeoutMs)) return;
	signal("SIGKILL");
	if (!(await waitFor(SIGKILL_GRACE_MS))) {
		throw new Error(`RPC socket host pid ${child.pid ?? "?"} remained alive after SIGKILL`);
	}
}

async function stopManagedHost(
	pidFile: DaemonPidFile,
	termTimeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	await signalValidated(pidFile, "SIGTERM", readStartTime);
	if (await waitForGone(pidFile, termTimeoutMs, readStartTime)) return;
	await signalValidated(pidFile, "SIGKILL", readStartTime);
	if (!(await waitForGone(pidFile, SIGKILL_GRACE_MS, readStartTime))) {
		throw new Error(`RPC socket host pid ${pidFile.pid} remained alive after SIGKILL`);
	}
}

type PidFileOwnership = "owns" | "gone" | "unknown";

// One probe per call: the teardown loops below are themselves the retry, so the
// budget inside processMatchesPidFile would only multiply their wall time. A probe
// that fails against a LIVE pid is "unknown" — it proves nothing about ownership, so
// signalling on it would be unsafe and treating it as "gone" would abandon a host that
// may still be running. A failed probe against a dead pid is "gone".
async function resolvePidFileOwnership(
	pidFile: DaemonPidFile,
	readStartTime: (pid: number) => Promise<string | undefined>,
): Promise<PidFileOwnership> {
	try {
		return (await processMatchesPidFile(pidFile, readStartTime, processIsLive, { attempts: 1 })) ? "owns" : "gone";
	} catch (error: unknown) {
		if (error instanceof ProcessIdentityUnreadableError) return "unknown";
		throw error;
	}
}

async function signalValidated(
	pidFile: DaemonPidFile,
	signal: NodeJS.Signals,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<void> {
	if ((await resolvePidFileOwnership(pidFile, readStartTime)) !== "owns") return;
	try {
		process.kill(pidFile.pid, signal);
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ESRCH")) throw error;
	}
}

async function waitForGone(
	pidFile: DaemonPidFile,
	timeoutMs: number,
	readStartTime: (pid: number) => Promise<string | undefined> = readProcessStartTime,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if ((await resolvePidFileOwnership(pidFile, readStartTime)) === "gone") return true;
		await delay(50);
	}
	return (await resolvePidFileOwnership(pidFile, readStartTime)) === "gone";
}

type ChildExit = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

type ProtocolPollResult = { readonly protocol?: HostProtocolInfo; readonly exited?: ChildExit };

async function pollProtocolInfo(
	socket: string,
	timeoutMs: number,
	childExit?: Promise<ChildExit>,
): Promise<ProtocolPollResult> {
	const deadline = Date.now() + timeoutMs;
	let lastProtocol: HostProtocolInfo | undefined;
	while (Date.now() <= deadline) {
		const probe = probeProtocolInfo(
			socket,
			Math.min(SPAWNED_HOST_PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
		);
		const raced = childExit ? await Promise.race([probe, childExit]) : await probe;
		if (isChildExit(raced)) {
			// A supervisor exit can be triggered by the Windows identity watchdog
			// while a named-pipe client is still composing its protocol reply. Do
			// not terminate the host based solely on that exit until this probe has
			// had a chance to deliver an answer. A host that never answers still
			// resolves through probeProtocolInfo's bounded timeout/close handling.
			const info = await probe;
			if (info) {
				lastProtocol = info;
				if (isCompatible(info)) return { protocol: info };
			} else {
				return { protocol: lastProtocol, exited: raced };
			}
		} else if (raced) {
			lastProtocol = raced;
			if (isCompatible(raced)) return { protocol: raced };
		}
		await delay(50);
	}
	return { protocol: lastProtocol };
}

function isChildExit(value: HostProtocolInfo | ChildExit | undefined): value is ChildExit {
	return !!value && "code" in value && "signal" in value;
}

async function probeProtocolInfo(socketPath: string, timeoutMs: number): Promise<HostProtocolInfo | undefined> {
	let secret: Buffer | undefined;
	if (process.platform === "win32") {
		try {
			secret = await readSocketSecret(socketSecretPath(socketPath));
		} catch {
			return undefined;
		}
	}
	return new Promise((resolveProbe) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		let settled = false;
		const finish = (value?: HostProtocolInfo): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.destroy();
			resolveProbe(value);
		};
		const timeout = setTimeout(() => finish(), timeoutMs);
		socket.once("connect", () => {
			socket.write('{"id":"ensure-host-probe","type":"get_protocol_info"}\n');
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			finish(readProtocolInfo(buffer.slice(0, newline)));
		});
		socket.once("error", () => finish());
		socket.once("close", () => finish());
		// Register the error listener before sending the Windows named-pipe handshake.
		// When an idle host has already removed its pipe, the handshake write can
		// surface ENOENT immediately; without the listener this probe escapes instead
		// of becoming the expected "no existing host" result for the next ensure.
		if (secret) sendSocketHandshake(socket, secret);
	});
}

function readProtocolInfo(text: string): HostProtocolInfo | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.id !== "ensure-host-probe" || parsed.success !== true) return undefined;
	return parseHostProtocolInfo(parsed.data);
}

/**
 * Compatibility, for the attach decision and the readiness gate alike: a host is compatible exactly
 * when a client that is forbidden to upgrade would attach to it. Never a version-string comparison (I2).
 */
function isCompatible(protocol: HostProtocolInfo | undefined): boolean {
	return decideHostAction(ensureClient(false), protocol, "never").action === "reuse";
}

/** Who wrote a host's pidfile: the process identity that a later stop must match to be allowed. */
interface HostPidFileWriter {
	readonly pid: number;
	readonly startTime: string | null;
}

interface RegisteredHost {
	readonly record: DaemonPidFile;
	readonly writer?: HostPidFileWriter;
}

async function readPidFile(paths: HostDaemonPaths): Promise<RegisteredHost | undefined> {
	let text: string;
	try {
		text = await readFile(paths.pidFile, "utf8");
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const record = parseDaemonPidFile(text);
	if (record === undefined) return undefined;
	const writer = parseWriter(text);
	return writer === undefined ? { record } : { record, writer };
}

/** A record from a host started before writer stamps existed simply has no writer: it reads as foreign. */
function parseWriter(text: string): HostPidFileWriter | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || !isRecord(parsed.writer) || typeof parsed.writer.pid !== "number") return undefined;
	const { pid, startTime } = parsed.writer;
	return { pid, startTime: typeof startTime === "string" ? startTime : null };
}

async function reapOrphanedInternalHostDirs(): Promise<void> {
	try {
		const entries = await readdir(tmpdir(), { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("senpi-rpc-host-internal-"))
				.map(async (entry) => {
					try {
						const owner = JSON.parse(await readFile(join(tmpdir(), entry.name, ".owner"), "utf8")) as {
							pid?: unknown;
							processStartTime?: unknown;
							createdAt?: unknown;
						};
						if (
							typeof owner.pid === "number" &&
							typeof owner.processStartTime === "string" &&
							typeof owner.createdAt === "number" &&
							owner.processStartTime.length > 0 &&
							owner.createdAt < Date.now() - 60_000 &&
							(await readdir(join(tmpdir(), entry.name))).length === 1 &&
							!(await processMatchesPidFile({ pid: owner.pid, processStartTime: owner.processStartTime }).catch(
								(error: unknown) => {
									// Unreadable but live: assume the owner is alive rather than steal its lock.
									if (error instanceof ProcessIdentityUnreadableError) return true;
									throw error;
								},
							))
						)
							await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
					} catch {}
				}),
		);
	} catch {}
}

async function cleanupState(paths: HostDaemonPaths): Promise<void> {
	await rm(paths.pidFile, { force: true });
	await rm(paths.settingsFile, { force: true });
}

async function appendStderr(paths: HostDaemonPaths, message: string): Promise<string> {
	try {
		const stderr = (await readFile(paths.stderrLog, "utf8")).trim();
		return stderr ? `${message}\n${stderr}` : message;
	} catch (error: unknown) {
		if (isNodeErrorCode(error, "ENOENT")) return message;
		throw error;
	}
}

function createSocketLockName(socket: string): string {
	return createHash("sha256")
		.update(resolveSocketTransportAddress(socket, process.platform), "utf8")
		.digest("hex")
		.slice(0, 32);
}

function normalizeSocketPath(value: string): string {
	if (value.startsWith("unix://")) return value.slice("unix://".length);
	return value;
}

/**
 * Default launch: the host-lifecycle supervisor owns the public socket and the
 * idle-exit policy; it spawns the committed RPC socket host itself. Any extra
 * hostArgs are forwarded verbatim to the host CLI (e.g. provider pinning).
 *
 * A compiled standalone binary cannot re-enter itself through a script path:
 * bun executables always boot their embedded entrypoint and parse the whole
 * argv as CLI arguments, so `host-lifecycle.ts --socket <path>` dies with
 * "Unknown option: --socket" before the host ever answers get_protocol_info.
 * Compiled binaries therefore re-enter through the hidden
 * `--internal-rpc-host-supervisor` route that main() dispatches before
 * argument parsing. Exported for tests.
 */
export function defaultHostLaunch(
	socket: string,
	hostArgs: readonly string[],
	compiled: boolean = isBunBinary,
): {
	command: string;
	args: string[];
} {
	if (compiled) {
		return {
			command: process.execPath,
			args: [INTERNAL_SUPERVISOR_FLAG, "--socket", socket, ...hostArgs],
		};
	}
	return {
		command: process.execPath,
		args: [...process.execArgv, resolveHostLifecycleEntryPath(), "--socket", socket, ...hostArgs],
	};
}

function resolveHostLifecycleEntryPath(): string {
	const modulePath = fileURLToPath(import.meta.url);
	const extension = modulePath.endsWith(".ts") ? ".ts" : ".js";
	return resolve(dirname(modulePath), `host-lifecycle${extension}`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function assertNever(value: never): never {
	throw new Error(`unreachable host decision: ${JSON.stringify(value)}`);
}
