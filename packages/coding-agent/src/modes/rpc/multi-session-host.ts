import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import { envValue } from "../../core/brand.ts";
import { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { startHostChildReaper } from "./child-reaper.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import { parseIdleExitMs } from "./host-lifecycle.ts";
import { HostMemorySampler } from "./host-memory-sampler.ts";
import { createEndpointReservations } from "./host-reservations.ts";
import { armHostWatchdog, readHostWatchdogConfigFromBrandEnv } from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { LoopLagWatchdog } from "./loop-lag-watchdog.ts";
import { hostGeneration, hostInstanceId } from "./protocol-identity.ts";
import { rpcCommandShapeError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { type RpcBindingFactory, SessionCommandRouter } from "./session-command-router.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { RpcSessionRegistry } from "./session-registry.ts";
import {
	PUBLIC_SOCKET_IDENTITY_FILE,
	readSocketIdentityFile,
	type SocketFileIdentity,
	shieldSocketDuringClose,
	socketEntryReplaced,
	statSocketIdentity,
	unlinkOwnedSocket,
	waitForSocketIdentityFile,
} from "./socket-ownership.ts";
import { socketSink } from "./socket-sink.ts";
import {
	authenticateSocket,
	ensureSocketSecret,
	resolveSocketTransportAddress,
	SOCKET_SECRET_FILE_ENV,
	socketSecretPath,
} from "./socket-transport.ts";
import { WorkerSessionRegistry } from "./worker-session-registry.ts";

export interface MultiSessionHostOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	workerConfiguration?: CliRuntimeConfiguration;
	cwd: string;
	permissionPreset?: string;
	creationModel?: { provider: string; modelId: string };
	initialThinkingLevel?: string;
	listen?: string;
	/** Test seam: defaults to the real shared-session binding. */
	createBinding?: RpcBindingFactory;
}

/** Environment override for the idle-session eviction window, in milliseconds. */
export const RPC_SESSION_IDLE_EVICTION_MS_ENV = "SENPI_RPC_SESSION_IDLE_EVICTION_MS";
/** Environment override for the empty-host exit window, in milliseconds. */
export const RPC_HOST_EMPTY_EXIT_MS_ENV = "SENPI_RPC_HOST_EMPTY_EXIT_MS";
/** Environment override for the graceful close_session teardown window, in milliseconds. */
export const RPC_CLOSE_GRACE_MS_ENV = "SENPI_RPC_CLOSE_GRACE_MS";
/** Default idle-eviction window: 30 minutes after a session's last routed command or settled turn. */
export const DEFAULT_SESSION_IDLE_EVICTION_MS = 30 * 60_000;
/** Default empty-host exit: 15 minutes with zero open sessions, matching the supervisor's idle window. */
export const DEFAULT_HOST_EMPTY_EXIT_MS = 15 * 60_000;
/** Win32 named-pipe close can leave libuv's server callback pending after handles are destroyed. */
const WINDOWS_SHUTDOWN_HARD_EXIT_MS = 2_000;

/** Explicit occupancy-policy overrides for createHostCore; tests inject clocks and hooks here. */
export interface HostIdleOverrides {
	now?: () => number;
	idleEvictionMs?: number;
	emptyExitMs?: number;
	closeGraceMs?: number;
	/** Shutdown hook the empty-exit window invokes; hosts pass their exit path. */
	onEmptyExit?: () => void;
	onHandoffParked?: (connections: readonly string[]) => Promise<void>;
	/** Gate consulted before the empty-exit window advances (connected clients block it). */
	canExitWhenEmpty?: () => boolean;
}

/**
 * Resolve the host's idle lifecycle policy.
 */
export function resolveHostIdlePolicy(
	env: Readonly<Record<string, string | undefined>>,
	overrides: HostIdleOverrides = {},
): { now: () => number; idleEvictionMs: number; emptyExitMs: number } {
	return {
		now: overrides.now ?? Date.now,
		idleEvictionMs:
			overrides.idleEvictionMs ??
			parseIdleExitMs(env[RPC_SESSION_IDLE_EVICTION_MS_ENV]) ??
			DEFAULT_SESSION_IDLE_EVICTION_MS,
		emptyExitMs:
			overrides.emptyExitMs ?? parseIdleExitMs(env[RPC_HOST_EMPTY_EXIT_MS_ENV]) ?? DEFAULT_HOST_EMPTY_EXIT_MS,
	};
}

/**
 * Arm the host's self-observation: event-loop stall detection with per-session
 * attribution, and RSS reporting that tightens idle parking under pressure and, above the
 * refuse watermark, declines NEW worker sessions (#1905). Both run on unref'd timers, and
 * neither aborts or kills anything the host already holds.
 */
function startHostObservers(
	router: SessionCommandRouter,
	writer: SessionEventWriter,
	options: { onIdlePressure?: (rssMb: number) => void } = {},
): { stop: () => void } {
	const loopLag = new LoopLagWatchdog({ emit: (record) => writer.broadcastHostRecord(record) });
	const memory = new HostMemorySampler({
		emit: (record) => writer.broadcastHostRecord(record),
		sessions: () => router.sessionCount,
		onPressure: (pressure) => router.setMemoryPressure(pressure),
		onCritical: (critical, rssMb) => router.setMemoryCritical(critical, rssMb),
		...(options.onIdlePressure ? { onIdlePressure: options.onIdlePressure } : {}),
	});
	loopLag.start();
	memory.start();
	return {
		stop: () => {
			loopLag.stop();
			memory.stop();
		},
	};
}

interface Connection {
	readonly id: string;
	readonly sink: RpcConnectionSink;
	readonly detach: () => void;
	readonly close: () => void;
}

/**
 * Socket agent events are delivered only to connections attached to their
 * session, tagged with its routing sessionId. Content-free session lifecycle
 * events remain visible to every connection. Responses and extension UI
 * requests remain requester-only; foreign observation uses attach-on-open.
 */
export async function runMultiSessionHost(options: MultiSessionHostOptions): Promise<never> {
	if (options.listen === undefined || options.listen === "stdio://") return runStdioHost(options);
	return runSocketHost(options, resolveSocketPath(options.listen, options.agentDir));
}

export function createHostCore(
	options: MultiSessionHostOptions,
	writer: SessionEventWriter,
	capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")),
	idle: HostIdleOverrides = {},
) {
	const policy = resolveHostIdlePolicy(process.env, idle);
	const router = new SessionCommandRouter(
		options.workerConfiguration
			? new WorkerSessionRegistry({
					configuration: options.workerConfiguration,
					now: policy.now,
					closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
				})
			: new RpcSessionRegistry({
					agentDir: options.agentDir,
					createRuntime: options.createRuntime,
					mcpRegistry: new HostMcpRegistry(),
					now: policy.now,
					closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
					// Two generations of this daemon can be alive at once during a handoff; the claims
					// they publish here are what keeps them off one session file.
					pathReservations: createEndpointReservations({
						agentDir: options.agentDir,
						socket: listenSocketPath(options),
						instanceId: hostInstanceId(),
						onFailure: hostLog,
					}),
				}),
		writer,
		options,
		options.createBinding,
		{ capabilities },
		{
			now: policy.now,
			idleEvictionMs: policy.idleEvictionMs,
			emptyExitMs: policy.emptyExitMs,
			onEmptyExit: idle.onEmptyExit,
			onHandoffParked: idle.onHandoffParked,
			canExitWhenEmpty: idle.canExitWhenEmpty,
		},
	);
	const handle = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (cause) {
			await writer.enqueueControl(parseError(`Failed to parse command: ${errorMessage(cause)}`));
			return;
		}
		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			await writer.enqueueControl(parseError(shapeError));
			return;
		}
		const response = await router.handle(parsed as RpcCommand);
		if (response) await writer.enqueueControl(response);
	};
	return { router, handle };
}

/** Plain-stdio host with no eagerly-created AgentSessionRuntime. */
async function runStdioHost(options: MultiSessionHostOptions): Promise<never> {
	takeOverStdout();
	const sink: RpcConnectionSink = { writeRaw: writeRawStdout, waitForBackpressure: waitForRawStdoutBackpressure };
	const writer = new SessionEventWriter(sink.writeRaw, sink.waitForBackpressure);
	// An empty host (no session ever opened, or all closed) must not stay resident
	// forever: exit through the normal shutdown path once the window elapses.
	const { router, handle } = createHostCore(options, writer, undefined, {
		onEmptyExit: () => void shutdown(0),
	});
	const observers = startHostObservers(router, writer);
	let shuttingDown = false;
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		observers.stop();
		detach();
		await router.dispose();
		await writer.flush();
		await flushRawStdout();
		process.exit(exitCode);
	};
	const onEnd = () => void shutdown();
	process.stdin.on("end", onEnd);
	const reportInputFailure = (cause: unknown): void => {
		process.stderr.write(`senpi rpc stdio request failed: ${errorMessage(cause)}\n`);
	};
	const detachReader = attachJsonlLineReader(process.stdin, (line) => void handle(line).catch(reportInputFailure), {
		maxLineLength: MAX_RPC_LINE_CHARACTERS,
		onOversizedLine: () => void writer.enqueueControl(parseError(oversizedLineError())).catch(reportInputFailure),
	});
	const detach = () => {
		detachReader();
		process.stdin.off("end", onEnd);
	};
	registerShutdownSignals(shutdown);
	return new Promise(() => {});
}

async function runSocketHost(options: MultiSessionHostOptions, socketPath: string): Promise<never> {
	await prepareSocketPath(socketPath);
	const writer = new SessionEventWriter(() => {});
	const connections = new Map<string, Connection>();
	let draining = false;
	let handoffAnnounced = false;
	const { router, handle } = createHostCore(
		options,
		writer,
		[
			...parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")).filter(
				(capability) => capability !== "rendered_components",
			),
			// A socket host installs the SIGUSR1 drain below, so it can be handed off to a newer
			// generation instead of being killed. A host that does not advertise this is never
			// signalled - SIGUSR1 would simply terminate it, sessions and all.
			GENERATION_HANDOFF_CAPABILITY,
		],
		// Supervised hosts idle-exit via the supervisor, but a socket host that
		// outlives its supervisor (or is started bare) still self-exits when empty.
		// A connected client counts as occupancy even with no session open: exiting
		// under it would drop its socket and read as a crash to the supervisor.
		// While DRAINING the opposite is true: the successor generation owns the socket, so a
		// sessionless connection must not hold this host open.
		{
			onEmptyExit: () => void shutdown(0),
			canExitWhenEmpty: () => draining || connections.size === 0,
			onHandoffParked: async (ids) => {
				await Promise.all(
					ids.map(async (id) => {
						await writer.flushConnection(id);
						connections.get(id)?.close();
					}),
				);
			},
		},
	);
	const observers = startHostObservers(router, writer, {
		// The shape #1893 measured: gigabytes resident with `sessions.total 0`. Say it once, and when
		// this generation no longer owns the endpoint, leave - nobody can reach it to ask.
		onIdlePressure: (rssMb) => {
			hostLog(`memory pressure with no sessions: rssMb=${rssMb}`);
			void endpointSuperseded().then((superseded) => {
				if (superseded) drainForHandoff();
			}, noop);
		},
	});
	let nextConnection = 0;
	let shuttingDown = false;
	const secret =
		process.platform === "win32"
			? await ensureSocketSecret(process.env[SOCKET_SECRET_FILE_ENV] ?? socketSecretPath(socketPath))
			: undefined;
	const watchdogConfig = readHostWatchdogConfigFromBrandEnv();
	// This host's OWN copy of the crash-path cleanup list. A drain empties it: once a successor
	// generation is registered, the daemon state files under those paths describe the successor,
	// and a crash of this (already replaced) host must not take them with it.
	const crashCleanupPaths = [...(watchdogConfig?.cleanupPaths ?? [])];
	// Crash-path ownership for the supervisor's PUBLIC socket: the supervisor
	// records the identity of the entry it bound (inside its private scratch
	// directory, which no replacement supervisor writes) right after its listen,
	// and this host removes that path only while the identity still matches. A
	// blind path removal here would unlink a newer host's freshly published
	// entry after a takeover - the startup path already refuses to touch a
	// socket owned by a live server; teardown follows the same rule.
	const supervisorPublicSocketPath =
		process.platform === "win32" || socketPath.startsWith("\0") ? undefined : watchdogConfig?.publicSocket;
	const supervisorPublicOwnerFile =
		supervisorPublicSocketPath && watchdogConfig?.scratchDir
			? join(watchdogConfig.scratchDir, PUBLIC_SOCKET_IDENTITY_FILE)
			: undefined;
	let boundIdentity: SocketFileIdentity | undefined;
	let supervisorPublicIdentity: SocketFileIdentity | undefined;
	const server = createServer((socket) => {
		const accept = (): void => {
			if (draining || shuttingDown) {
				socket.destroy();
				return;
			}
			const id = `socket-${++nextConnection}`;
			const sink = socketSink(socket);
			writer.registerConnection(id, sink);
			const detachReader = attachJsonlLineReader(
				socket,
				(line) => {
					// Do not serialize awaited commands: extension_ui_response and other
					// re-entrant frames must be able to resolve a command already awaiting them.
					void writer
						.withConnection(id, () => handle(line))
						.catch((cause) => {
							process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`);
						});
				},
				{
					maxLineLength: MAX_RPC_LINE_CHARACTERS,
					onOversizedLine: () => {
						void writer
							.withConnection(id, () => writer.enqueueControl(parseError(oversizedLineError())))
							.catch((cause) =>
								process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`),
							);
					},
				},
			);
			let detached = false;
			const detach = () => {
				if (detached) return;
				detached = true;
				detachReader();
				writer.unregisterConnection(id);
				connections.delete(id);
				// A socket that dies without close_session still owns its sessions' attachments
				// and path reservations. Release them on the command chain so this runs after any
				// in-flight command for this connection settles, otherwise the path stays pinned
				// by a runtime whose client is gone and later resumes attach to that orphan.
				void router.releaseConnection(id).catch((cause) => {
					process.stderr.write(`senpi rpc connection ${id} release failed: ${errorMessage(cause)}\n`);
				});
			};
			connections.set(id, { id, sink, detach, close: () => socket.destroy() });
			socket.once("close", detach);
			socket.once("error", () => detach());
		};
		if (secret) authenticateSocket(socket, secret, accept);
		else accept();
	});
	server.on("error", (cause) => {
		if (!shuttingDown) process.stderr.write(`senpi rpc socket listener failed: ${errorMessage(cause)}\n`);
	});
	// Long-lived hosts outlive many session workers, and a terminated worker thread
	// takes its children's exit watchers with it (measured: every spawn API leaks
	// that way). The reaper claims those abandoned children; it never touches one a
	// live thread could still be waiting for.
	const stopChildReaper = await startHostChildReaper(hostLog);
	const shutdown = async (exitCode = 0, watchdogCleanup?: Promise<void>): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		observers.stop();
		stopChildReaper();
		// On Windows, destroying named-pipe sockets does not always make libuv's
		// server.close callback fire: connected pipe instances can remain in the
		// kernel after the JavaScript handles are destroyed. Keep the normal drain
		// path, but never let that platform-specific close stall orphan the host.
		try {
			// Dispose while connections are still registered so `session_closed`
			// `{ reason: "host_shutdown" }` reaches clients before the sockets die.
			await router.dispose();
			await writer.flush();
			for (const connection of connections.values()) {
				connection.detach();
				connection.close();
			}
			// libuv unlinks the bound NAME when the listening handle closes - which
			// would delete a newer host's entry renamed over this path. Shield the
			// current entry for the close, then let the ownership check decide.
			await shieldSocketDuringClose(socketPath, () =>
				process.platform === "win32"
					? Promise.race([closeServer(server), delay(WINDOWS_SHUTDOWN_HARD_EXIT_MS)])
					: closeServer(server),
			);
			// Ownership-checked: unlink only the entry THIS process bound. After a
			// takeover renamed a newer host's socket over the same path, the
			// identity no longer matches and the replacement stays published.
			await unlinkOwnedSocket(socketPath, boundIdentity, hostLog);
			if (supervisorPublicSocketPath) {
				await unlinkOwnedSocket(supervisorPublicSocketPath, supervisorPublicIdentity, hostLog);
			}
			if (watchdogCleanup) await watchdogCleanup;
		} finally {
			// Explicitly terminate after every shutdown trigger. Windows named-pipe
			// handles are not fully controllable from JS, and an unresolved cleanup
			// must not leave this daemon or its public endpoint alive.
			process.exit(exitCode);
		}
	};
	/**
	 * Announce through the record writer, never inside the supervisor's raw byte proxy. This
	 * preserves JSONL framing and FIFO before parking, including when a record spans proxy reads.
	 * Active turns/requests keep running; durable wake-source holds resume on reopen.
	 */
	const drainForHandoff = (): void => {
		if (shuttingDown) return;
		if (draining) {
			if (handoffAnnounced) router.beginDrain();
			return;
		}
		draining = true;
		crashCleanupPaths.length = 0;
		hostLog("draining for a generation handoff");
		void endpointSuperseded()
			.then((superseded) => {
				writer.broadcastHostRecord({
					type: "host_superseded",
					instanceId: hostInstanceId(),
					generation: hostGeneration(process.env),
					successor: superseded ? { socket: supervisorPublicSocketPath ?? socketPath } : null,
				});
				handoffAnnounced = true;
				router.beginDrain();
			})
			.catch((cause: unknown) => {
				hostLog(`handoff announcement failed: ${String(cause)}`);
			});
	};
	/**
	 * Whether the endpoint this host serves is held by another socket entry now. A supervised host
	 * answers for the PUBLIC path its supervisor bound - its own listener is a private hop nobody
	 * replaces - and a bare host for the path it bound itself.
	 */
	const endpointSuperseded = (): Promise<boolean> =>
		supervisorPublicSocketPath === undefined
			? socketEntryReplaced(socketPath, boundIdentity)
			: socketEntryReplaced(supervisorPublicSocketPath, supervisorPublicIdentity);
	registerShutdownSignals(shutdown);
	if (process.platform !== "win32") process.on("SIGUSR1", drainForHandoff);
	// Arm before listen: a supervisor death during the listen transition must
	// still close the child and clean its private endpoint.
	const watchdog =
		watchdogConfig && supervisorPublicOwnerFile
			? {
					...watchdogConfig,
					cleanupPaths: crashCleanupPaths,
					// The supervisor may die while this host is still waiting for the token
					// below; read it before the watchdog removes the scratch directory, or the
					// shutdown's ownership check has nothing to prove with and leaves the
					// public socket behind.
					beforeCleanup: async () => {
						supervisorPublicIdentity ??= await readSocketIdentityFile(supervisorPublicOwnerFile);
					},
				}
			: watchdogConfig && { ...watchdogConfig, cleanupPaths: crashCleanupPaths };
	armHostWatchdog(watchdog, (reason, cleanup) => {
		process.stderr.write(`senpi rpc host: ${reason}; shutting down\n`);
		// Enter shutdown before killing session-owned child processes. The Windows
		// tree killer is synchronous, while the shutdown fallback must be armed
		// before any such cleanup can delay the event loop.
		void shutdown(0, cleanup);
		setImmediate(killTrackedDetachedChildren);
	});
	boundIdentity = await listen(server, socketPath, secret);
	if (supervisorPublicOwnerFile) {
		// The supervisor publishes its public-socket token after this internal
		// listener is ready, so a short bounded wait keeps the lifecycles in step
		// without delaying unsupervised hosts.
		supervisorPublicIdentity = await waitForSocketIdentityFile(supervisorPublicOwnerFile);
	}
	process.stderr.write(`senpi rpc listening on ${formatSocketAddress(socketPath)}\n`);

	// Opt-in only: set by the lifecycle supervisor so this host can never outlive
	// it, including when the supervisor is SIGKILLed and runs no handler at all.
	return new Promise(() => {});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function noop(): void {}

function parseError(error: string): RpcResponse {
	return { type: "response", command: "parse", success: false, error };
}

function oversizedLineError(): string {
	return `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** The endpoint this host listens on, or nothing when it speaks stdio and shares no socket. */
function listenSocketPath(options: MultiSessionHostOptions): string | undefined {
	if (options.listen === undefined || options.listen === "stdio://") return undefined;
	return resolveSocketPath(options.listen, options.agentDir);
}

function resolveSocketPath(value: string, agentDir: string): string {
	if (value === "unix://") return join(agentDir, "rpc", "rpc.sock");
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		if (path.length === 0) return join(agentDir, "rpc", "rpc.sock");
		if (path.startsWith("@") && process.platform === "linux") return `\0${path.slice(1)}`;
		return path;
	}
	return value;
}

function formatSocketAddress(socketPath: string): string {
	return socketPath.startsWith("\0") ? `unix://@${socketPath.slice(1)}` : `unix://${socketPath}`;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await access(socketPath);
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return;
		throw cause;
	}
	if (await probeSocket(socketPath)) throw new Error(`${socketPath}: address already in use by a live server.`);
	await unlink(socketPath);
}

function probeSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform));
		const settle = (live: boolean) => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
		socket.setTimeout(1_000, () => settle(false));
	});
}

function listen(server: Server, socketPath: string, secret?: Uint8Array): Promise<SocketFileIdentity | undefined> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(resolveSocketTransportAddress(socketPath, process.platform, secret), async () => {
			server.off("error", reject);
			try {
				if (process.platform !== "win32" && !socketPath.startsWith("\0")) {
					await chmod(socketPath, 0o600);
					// Record which filesystem entry THIS listener created; shutdown
					// removes the path only while this identity still matches.
					return resolve(await statSocketIdentity(socketPath));
				}
				resolve(undefined);
			} catch (cause) {
				reject(cause);
			}
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((cause) => (cause ? reject(cause) : resolve()));
	});
}

function hostLog(message: string): void {
	process.stderr.write(`senpi rpc host: ${message}\n`);
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function registerShutdownSignals(shutdown: (exitCode?: number) => Promise<never>): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143);
		});
	}
}
