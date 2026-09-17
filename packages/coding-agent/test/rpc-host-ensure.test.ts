import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../src/config.ts";
import {
	ProcessIdentityUnreadableError,
	processMatchesPidFile,
	readProcessStartTime,
	waitForStartTime,
} from "../src/modes/app-server/daemon/process.ts";
import { HostEnsureRefusedError } from "../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, defaultHostLaunch, ensureHost } from "../src/modes/rpc/host-ensure.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../src/modes/rpc/socket-transport.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
const fixture = join(import.meta.dirname, "fixtures", "rpc-host-fixture.mjs");
const incompatibleProtocolFixture = join(import.meta.dirname, "fixtures", "rpc-incompatible-protocol-host.ts");
/** What a host must advertise before any client may attach: protocol capabilities, never a version. */
const CAPABILITIES = "multi_session,extension_events,session_context,session_kind";
/** The published release whose ensure logic is replayed in the legacy fail-closed proof. */
const LEGACY_VERSION = "2026.9.16-3";

afterEach(async () => {
	for (const child of children.splice(0)) await stopChild(child);
	for (const root of roots.splice(0)) {
		await stopManagedRoot(root);
		await rm(root, { recursive: true, force: true });
	}
});

describe("ensureHost", () => {
	it("serializes concurrent starts for one socket across agent directories", async () => {
		const qa = await scratch("cross-agent-race");
		const secondAgentDir = join(qa.root, "other-agent");
		let releaseFirst!: () => void;
		let signalFirstLocked!: () => void;
		const firstLocked = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				afterLockAcquired: async () => {
					signalFirstLocked();
					await firstLocked;
				},
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		releaseFirst();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.reused).toBe(false);
		expect(secondResult).toMatchObject({ socket: qa.socket, reused: true });
	}, 45_000);

	it("waits for a holder whose critical section outlasts the previous ten-second lock budget", async () => {
		const qa = await scratch("long-critical-section");
		const secondAgentDir = join(qa.root, "other-agent");
		let signalFirstLocked!: () => void;
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				afterLockAcquired: async () => {
					signalFirstLocked();
					// Longer than the old cumulative wait (100 x 100ms): a waiter that still
					// used it gave up with a raw "database is locked" instead of reusing.
					await new Promise<void>((resolve) => setTimeout(resolve, 12_000));
				},
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
				},
			},
		});
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(firstResult.reused).toBe(false);
		expect(secondResult).toMatchObject({ socket: qa.socket, reused: true });
	}, 60_000);

	it("starts a missing host and reuses it on the second call", async () => {
		const qa = await scratch("start-reuse");
		const first = await ensureFixtureHost(qa);
		const second = await ensureFixtureHost(qa);
		expect(first).toEqual({ pid: expect.any(Number), socket: qa.socket, reused: false });
		expect(second).toEqual({ pid: first.pid, socket: qa.socket, reused: true });
		expect((await protocolInfo(qa.socket)).data).toMatchObject({ serverVersion: VERSION });
	});

	it("attaches to a compatible unmanaged host", async () => {
		const qa = await scratch("compatible-unmanaged");
		const child = spawn(process.execPath, [fixture, qa.socket, VERSION, CAPABILITIES, "answer"], {
			detached: true,
			stdio: "ignore",
		});
		children.push(child);
		if (child.pid === undefined) throw new Error("fixture did not spawn");
		await waitForProtocol(qa.socket);
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(true);
		expect(result.pid).toBe(0);
	});

	it("reuses a compatible host whose server version differs from this build", async () => {
		// I2: two builds with different version STRINGS speak the same protocol. Replacing such a
		// host - which is what an exact-version compatibility test did - kills another client's work.
		const qa = await scratch("different-version");
		const running = await startManagedFixture(qa, { serverVersion: "2026.9.16-3" });
		const result = await ensureFixtureHost(qa);
		expect(result).toEqual({ pid: running.pid, socket: qa.socket, reused: true });
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 15_000);

	it("refuses a host missing session_context instead of starting a second one", async () => {
		const qa = await scratch("missing-capability");
		const running = await startManagedFixture(qa, {
			capabilities: "multi_session,extension_events,session_kind",
		});
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("capability");
		// The host that owns the socket keeps owning it: no signal, no second host.
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 15_000);

	it("refuses to signal a live host whose pidfile another process wrote", async () => {
		// I1: the pidfile says a host is ours only if THIS process wrote it. A foreign writer's host
		// is never signalled, even when it stopped answering on the socket.
		const qa = await scratch("foreign-writer");
		const running = await startManagedProcess(qa, { writer: "foreign" });
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("refuses a pidfile written by a recycled pid that is no longer this process", async () => {
		// The adversarial half of the same rule: the writer pid matches after a reboot recycled it,
		// so only the recorded start time separates "we wrote this" from "somebody else did".
		const qa = await scratch("recycled-writer");
		const running = await startManagedProcess(qa, { writer: "recycled-pid" });
		const failure = await ensureFixtureHost(qa).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);

	it("cleans a stale dead pidfile and starts fresh", async () => {
		const qa = await scratch("stale-pidfile");
		const paths = createHostDaemonPaths(qa.agentDir);
		await mkdir(paths.dir, { recursive: true });
		await writeFile(paths.pidFile, `${JSON.stringify({ pid: 999_999_999, processStartTime: "dead" })}\n`);
		await writeFile(paths.settingsFile, "stale");
		const result = await ensureFixtureHost(qa);
		expect(result.reused).toBe(false);
		expect(result.pid).not.toBe(999_999_999);
		expect(JSON.parse(await readFile(paths.settingsFile, "utf8"))).toMatchObject({ socket: qa.socket });
	});

	it("escalates to SIGKILL when our own dead host ignores SIGTERM", async () => {
		const qa = await scratch("sigkill");
		const old = await startManagedProcess(qa, { writer: "self", ignoreTerm: true });
		const startedAt = Date.now();
		const result = await ensureFixtureHost(qa, { stopTimeoutMs: 200 });
		expect(result.pid).not.toBe(old.pid);
		expect(Date.now() - startedAt).toBeLessThan(8_000);
		await expectGone(old.pidFile);
	}, 15_000);

	it("fails within the readiness budget and includes stderr diagnostics", async () => {
		const qa = await scratch("readiness-failure");
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		const paths = createHostDaemonPaths(qa.agentDir);
		await expect(access(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("keeps the readiness diagnostic and cleans up when the identity probe fails during teardown", async () => {
		const qa = await scratch("readiness-failure-probe-error");
		// Startup succeeds (the pidfile gets a real identity); the probe starts failing only
		// once teardown begins - the exact shape of the Windows CI failure.
		let registered = false;
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				beforePidFileWrite: async () => {
					registered = true;
				},
				readProcessStartTime: (pid) =>
					registered
						? Promise.reject(new Error("Command failed: powershell.exe -NoProfile"))
						: readProcessStartTime(pid),
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		const paths = createHostDaemonPaths(qa.agentDir);
		await expect(access(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(qa.socket)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("reports the readiness diagnostic even when teardown cannot confirm the host died", async () => {
		const qa = await scratch("readiness-failure-stop-stuck");
		// After registration the probe keeps reporting the recorded identity even once the
		// host is dead, so any pidfile-based wait would never observe "gone". The readiness
		// diagnostic must still be the error the caller sees.
		let pinned: string | undefined;
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 300,
				stopTimeoutMs: 50,
				beforePidFileWrite: async () => {
					pinned = "pinned";
				},
				readProcessStartTime: async (pid) =>
					pinned ? ((await readProcessStartTime(pid)) ?? pinned) : readProcessStartTime(pid),
				spawn: {
					command: process.execPath,
					args: ["-e", "process.stderr.write('fixture readiness diagnostic\\n'); setInterval(() => {}, 1000)"],
				},
			}),
		).rejects.toThrow(/did not answer get_protocol_info.*fixture readiness diagnostic/s);
		const paths = createHostDaemonPaths(qa.agentDir);
		await expect(access(paths.pidFile)).rejects.toMatchObject({ code: "ENOENT" });
	}, 10_000);

	it("serializes concurrent starts even when the identity probe fails transiently on a live pid", async () => {
		// The Windows CI variant: Get-CimInstance exits non-zero under load for a process that is
		// very much alive. Observation failure must read as UNKNOWN (retry), never as "gone" or
		// as an error that escapes ensureHost.
		const qa = await scratch("race-flaky");
		const secondAgentDir = join(qa.root, "other-agent");
		let failuresLeft = 3;
		const flakyProbe = async (pid: number): Promise<string | undefined> => {
			if (failuresLeft > 0) {
				failuresLeft -= 1;
				throw new Error(
					`Command failed: powershell.exe -NoProfile Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
				);
			}
			return readProcessStartTime(pid);
		};
		let releaseFirst!: () => void;
		let signalFirstLocked!: () => void;
		const firstLocked = new Promise<void>((resolve) => (releaseFirst = resolve));
		const firstAcquired = new Promise<void>((resolve) => (signalFirstLocked = resolve));
		const spawnFixture = {
			command: process.execPath,
			args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
		};
		const first = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				readProcessStartTime: flakyProbe,
				afterLockAcquired: async () => {
					signalFirstLocked();
					await firstLocked;
				},
				spawn: spawnFixture,
			},
		});
		await firstAcquired;
		const second = ensureHost({
			agentDir: secondAgentDir,
			socket: qa.socket,
			_test: { readProcessStartTime: flakyProbe, spawn: spawnFixture },
		});
		releaseFirst();
		const [a, b] = await Promise.all([first, second]);
		expect(a.reused).toBe(false);
		expect(a.pid).toBeGreaterThan(0);
		expect(b).toMatchObject({ socket: qa.socket, reused: true });
		// The flaky probe was exercised to exhaustion and never escaped as an error.
		expect(failuresLeft).toBe(0);
	}, 20_000);

	it("registers a live host whose identity stays unreadable instead of tearing it down", async () => {
		// The Windows CI variant that survived the retry work: every Get-CimInstance attempt is
		// starved, so the spawned host never yields an identity. The host itself is healthy and
		// answering, so it must be registered without an ownership guard rather than killed.
		const qa = await scratch("unreadable-identity");
		const host = await ensureFixtureHost(qa, { readProcessStartTime: async () => undefined });
		expect(host).toMatchObject({ socket: qa.socket, reused: false });
		const pidFile = JSON.parse(await readFile(createHostDaemonPaths(qa.agentDir).pidFile, "utf8")) as unknown;
		expect(pidFile).toMatchObject({ pid: host.pid, processStartTime: null });
		const second = await ensureFixtureHost(qa);
		expect(second).toMatchObject({ socket: qa.socket, reused: true });
	}, 20_000);

	it("starts fresh when an unguarded pidfile's host no longer answers", async () => {
		// A pidfile written without an identity guard can never authorize a kill, so a later
		// ensure must start a new host instead of failing on the unreadable identity.
		const qa = await scratch("unguarded-pidfile");
		const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
		children.push(live);
		const paths = createHostDaemonPaths(qa.agentDir);
		await mkdir(dirname(paths.pidFile), { recursive: true });
		await writeFile(paths.pidFile, `${JSON.stringify({ pid: live.pid, processStartTime: null })}\n`);
		const host = await ensureFixtureHost(qa);
		expect(host.reused).toBe(false);
		expect(host.pid).not.toBe(live.pid);
	}, 20_000);

	it("treats a failing probe against a dead pid as gone and starts a fresh host", async () => {
		const qa = await scratch("dead-probe");
		// A real process that has already exited: liveness is genuinely false.
		const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolve) => dead.once("exit", () => resolve()));
		const paths = createHostDaemonPaths(qa.agentDir);
		await mkdir(dirname(paths.pidFile), { recursive: true });
		await writeFile(paths.pidFile, `${JSON.stringify({ pid: dead.pid, processStartTime: "stale" })}\n`);
		let probeCalls = 0;
		const host = await ensureFixtureHost(qa, {
			readProcessStartTime: async (pid) => {
				probeCalls += 1;
				if (pid === dead.pid) throw new Error("Command failed: powershell.exe -NoProfile");
				return readProcessStartTime(pid);
			},
		});
		expect(host.reused).toBe(false);
		expect(host.pid).not.toBe(dead.pid);
		expect(probeCalls).toBeGreaterThan(0);
	}, 20_000);

	it("fails fast when the spawned host exits before readiness", async () => {
		const qa = await scratch("early-exit");
		const startedAt = Date.now();
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 5_000,
				spawn: { command: process.execPath, args: ["-e", "process.exit(7)"] },
			}),
		).rejects.toThrow(/exited.*7/);
		expect(Date.now() - startedAt).toBeLessThan(2_500);
	}, 10_000);

	it("reports an incompatible protocol answer instead of a readiness timeout", async () => {
		const qa = await scratch("incompatible-answer");
		await expect(
			ensureFixtureHost(qa, {
				readinessTimeoutMs: 10_000,
				spawn: {
					command: process.execPath,
					args: ["--import", "tsx", incompatibleProtocolFixture, qa.socket],
				},
			}),
		).rejects.toThrow(/incompatible|0\\.0\\.0-wrong/);
	}, 30_000);
});

describe("legacy client against a daemon directory with no flat pidfile", () => {
	it("fails closed instead of taking the host over", async () => {
		// D11: the published v2026.9.16-3 ensure logic, replayed below, is what is deployed on user
		// machines while the new daemon rolls out. Its compatibility test is `serverVersion === VERSION`,
		// so it calls every new host incompatible - and the ONLY thing keeping it from stopping that
		// host is the absence of a pidfile it can parse. This test pins that outcome with spies in
		// place of its two side effects: neither may fire.
		expect(VERSION).not.toBe(LEGACY_VERSION);
		const qa = await scratch("legacy-client");
		const running = await startManagedFixture(qa);
		// The v2 layout: a marker file, and deliberately no flat `host.pid` for a legacy reader.
		const paths = createHostDaemonPaths(qa.agentDir);
		await rm(paths.pidFile, { force: true });
		await writeFile(join(paths.dir, "layout.json"), `${JSON.stringify({ layout: 2, dir: "deadbeefdeadbeef" })}\n`);
		const spawned: string[] = [];
		const stopped: number[] = [];

		const failure = await legacyEnsureHostLocked({
			qa,
			spawnHost: () => spawned.push(qa.socket),
			stopManagedHost: (pid) => stopped.push(pid),
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("unmanaged host");
		expect({ spawned, stopped }).toEqual({ spawned: [], stopped: [] });
		expect(await processMatchesPidFile(running.pidFile, readProcessStartTime)).toBe(true);
	}, 20_000);
});

/**
 * The decision half of `ensureHostLocked` as published in v2026.9.16-3
 * (`git show v2026.9.16-3:packages/coding-agent/src/modes/rpc/host-ensure.ts`), with its two side
 * effects replaced by spies. Copied rather than imported on purpose: this proves what the DEPLOYED
 * client does against today's directory layout, so it must not follow this branch's refactors.
 */
async function legacyEnsureHostLocked(args: {
	qa: Qa;
	spawnHost: () => void;
	stopManagedHost: (pid: number) => void;
}): Promise<void> {
	const paths = createHostDaemonPaths(args.qa.agentDir);
	const pidFile = await readFile(paths.pidFile, "utf8").then(
		(text) => JSON.parse(text) as { pid: number; processStartTime: string },
		() => undefined,
	);
	const answer = await protocolInfo(args.qa.socket).catch(() => undefined);
	const protocol = answer?.data as { serverVersion?: string; capabilities?: string[] } | undefined;
	const compatible =
		protocol?.serverVersion === LEGACY_VERSION &&
		["multi_session", "extension_events"].every((capability) => protocol.capabilities?.includes(capability));
	if (compatible) return;
	const pidMatches = pidFile ? await processMatchesPidFile(pidFile, readProcessStartTime) : false;
	if (protocol && !pidMatches) throw new Error(`RPC socket ${args.qa.socket} is owned by an unmanaged host`);
	if (pidFile && pidMatches) args.stopManagedHost(pidFile.pid);
	args.spawnHost();
}

describe("defaultHostLaunch", () => {
	it("re-enters through the internal supervisor route in compiled binaries", () => {
		expect(defaultHostLaunch("/tmp/qa.sock", ["--provider", "mock"], true)).toEqual({
			command: process.execPath,
			args: ["--internal-rpc-host-supervisor", "--socket", "/tmp/qa.sock", "--provider", "mock"],
		});
	});

	it("re-enters through the host-lifecycle script outside compiled binaries", () => {
		const launch = defaultHostLaunch("/tmp/qa.sock", ["--provider", "mock"], false);
		expect(launch.command).toBe(process.execPath);
		const args = launch.args.slice(process.execArgv.length);
		expect(args[0]).toMatch(/host-lifecycle\.(ts|js)$/);
		expect(args.slice(1)).toEqual(["--socket", "/tmp/qa.sock", "--provider", "mock"]);
	});
});

type Qa = { root: string; agentDir: string; socket: string };
/** Who the pidfile claims wrote it: this process, this process's pid after a reboot recycled it, or the host itself. */
type Writer = "self" | "recycled-pid" | "foreign";
type Managed = { pid: number; pidFile: { pid: number; processStartTime: string } };
type Overrides = {
	readinessTimeoutMs?: number;
	stopTimeoutMs?: number;
	spawn?: { command: string; args: string[] };
	readProcessStartTime?: (pid: number) => Promise<string | undefined>;
	beforePidFileWrite?: () => Promise<void>;
};

async function scratch(label: string): Promise<Qa> {
	const root = await mkdtemp(join(tmpdir(), `senpi-host-ensure-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

function ensureFixtureHost(qa: Qa, overrides: Overrides = {}) {
	return ensureHost({
		agentDir: qa.agentDir,
		socket: qa.socket,
		_test: {
			readinessTimeoutMs: overrides.readinessTimeoutMs,
			stopTimeoutMs: overrides.stopTimeoutMs,
			spawn: overrides.spawn ?? {
				command: process.execPath,
				args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"],
			},
			readProcessStartTime: overrides.readProcessStartTime,
			beforePidFileWrite: overrides.beforePidFileWrite,
		},
	});
}

async function startManagedFixture(
	qa: Qa,
	options: { serverVersion?: string; capabilities?: string; writer?: Writer } = {},
): Promise<Managed> {
	const child = spawn(
		process.execPath,
		[fixture, qa.socket, options.serverVersion ?? VERSION, options.capabilities ?? CAPABILITIES, "answer"],
		{ detached: true, stdio: "ignore" },
	);
	await waitForProtocol(qa.socket);
	return register(qa, child, options.writer ?? "self");
}

/**
 * A managed host that does NOT answer on the socket: the shape a wedged or dead host leaves behind,
 * where the only thing standing between an ensure and a signal is the pidfile's writer.
 */
async function startManagedProcess(qa: Qa, options: { writer: Writer; ignoreTerm?: boolean }): Promise<Managed> {
	const script = options.ignoreTerm
		? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
		: "setInterval(() => {}, 1000)";
	return register(qa, spawn(process.execPath, ["-e", script], { detached: true, stdio: "ignore" }), options.writer);
}

async function register(qa: Qa, child: ChildProcess, writer: Writer): Promise<Managed> {
	children.push(child);
	if (child.pid === undefined) throw new Error("managed host did not spawn");
	// The child is live, so its identity must resolve; waitForStartTime returns undefined only when
	// the probe is starved on a loaded host, which these fixtures do not exercise.
	const processStartTime = await waitForStartTime(child.pid, 2_000);
	if (processStartTime === undefined) throw new Error("managed host had no process identity");
	const paths = createHostDaemonPaths(qa.agentDir);
	await mkdir(paths.dir, { recursive: true });
	await writeFile(
		paths.pidFile,
		`${JSON.stringify({ pid: child.pid, processStartTime, writer: await writerRecord(writer, child.pid) })}\n`,
		{ mode: 0o600 },
	);
	await writeFile(paths.settingsFile, `${JSON.stringify({ socket: qa.socket })}\n`, { mode: 0o600 });
	return { pid: child.pid, pidFile: { pid: child.pid, processStartTime } };
}

async function writerRecord(writer: Writer, hostPid: number): Promise<{ pid: number; startTime: string | null }> {
	if (writer === "self") return { pid: process.pid, startTime: (await readProcessStartTime(process.pid)) ?? null };
	// A recycled pid carries this process's number with somebody else's start time.
	if (writer === "recycled-pid") return { pid: process.pid, startTime: "1970-01-01T00:00:00.000Z" };
	return { pid: hostPid, startTime: (await readProcessStartTime(hostPid)) ?? null };
}

async function protocolInfo(socketPath: string): Promise<Record<string, unknown>> {
	const secret = process.platform === "win32" ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	return new Promise((resolve, reject) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
		let buffer = "";
		const timer = setTimeout(() => finish(new Error("protocol timeout")), 1_000);
		const finish = (error?: Error, value?: Record<string, unknown>) => {
			clearTimeout(timer);
			socket.destroy();
			error ? reject(error) : resolve(value!);
		};
		socket.once("connect", () => {
			if (secret) sendSocketHandshake(socket, secret);
			socket.write('{"id":"probe","type":"get_protocol_info"}\n');
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline !== -1) finish(undefined, JSON.parse(buffer.slice(0, newline)));
		});
		socket.once("error", finish);
	});
}

async function waitForProtocol(socketPath: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() <= deadline) {
		try {
			await protocolInfo(socketPath);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	throw new Error("fixture protocol did not become ready");
}

async function expectGone(pidFile: { pid: number; processStartTime: string }): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() <= deadline) {
		if (!(await processMatchesPidFile(pidFile, readProcessStartTime))) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`pid ${pidFile.pid} remained alive`);
}

async function stopManagedRoot(root: string): Promise<void> {
	try {
		const parsed = JSON.parse(await readFile(createHostDaemonPaths(join(root, "agent")).pidFile, "utf8"));
		if (
			typeof parsed?.pid === "number" &&
			typeof parsed?.processStartTime === "string" &&
			(await processMatchesPidFile(parsed, readProcessStartTime))
		) {
			process.kill(parsed.pid, "SIGKILL");
			await expectGone(parsed);
		}
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {}
}

describe("processMatchesPidFile", () => {
	it("retries a probe that fails transiently against a live pid and then answers", async () => {
		let failures = 2;
		let calls = 0;
		const matches = await processMatchesPidFile(
			{ pid: process.pid, processStartTime: "self" },
			async () => {
				calls += 1;
				if (failures > 0) {
					failures -= 1;
					throw new Error("Command failed: powershell.exe -NoProfile");
				}
				return "self";
			},
			() => true,
			{ attempts: 5, delayMs: 5 },
		);
		expect(matches).toBe(true);
		expect(calls).toBe(3);
	});

	it("reads a pidfile without an identity guard as unreadable while the pid is live", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: process.pid, processStartTime: null },
				async () => "ignored",
				() => true,
				{
					attempts: 1,
				},
			),
		).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
	});

	it("reads a pidfile without an identity guard as gone once the pid is not live", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: 4_294_967_294, processStartTime: null },
				async () => "ignored",
				() => false,
				{
					attempts: 1,
				},
			),
		).resolves.toBe(false);
	});

	it("reads a failing probe against a dead pid as gone without retrying", async () => {
		let calls = 0;
		const matches = await processMatchesPidFile(
			{ pid: 999_999, processStartTime: "x" },
			async () => {
				calls += 1;
				throw new Error("Command failed: powershell.exe -NoProfile");
			},
			() => false,
			{ attempts: 5, delayMs: 5 },
		);
		expect(matches).toBe(false);
		expect(calls).toBe(1);
	});

	it("surfaces an exhausted probe on a live pid as ProcessIdentityUnreadableError, not the raw probe error", async () => {
		await expect(
			processMatchesPidFile(
				{ pid: process.pid, processStartTime: "self" },
				async () => {
					throw new Error("Command failed: powershell.exe -NoProfile");
				},
				() => true,
				{ attempts: 3, delayMs: 5 },
			),
		).rejects.toBeInstanceOf(ProcessIdentityUnreadableError);
	});
});
