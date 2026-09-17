import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs, resolveSessionRuntime } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import {
	createInProcessRig,
	listedSessions,
	MAX_THREADS_PER_SESSION,
	opened,
	threadCount,
	transcriptLines,
} from "./rpc-inprocess-host-support.ts";
import { startInProcessHost, startWorkerHost } from "./rpc-worker-host-support.ts";

/** Sessions opened on one host: more than double the worker runtime's 20-worker cap. */
const DAEMON_SESSIONS = 45;
/** Idle-eviction window used by the retention cases; parking happens at twice this. */
const IDLE_WINDOW_MS = 1_000;
/** Empty-host exit window used by the retention cases. */
const EMPTY_EXIT_MS = 5_000;
/** Timer-only fakes plus `Date`: the registry's idle clock is `Date.now`, `setImmediate` stays real. */
const IDLE_CLOCK_FAKES = ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] as const;

const scratches: string[] = [];

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(scratches.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rigDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-inprocess-retain-"));
	scratches.push(dir);
	return dir;
}

it("opens more sessions than the worker cap on one in-process registry and reopens by path", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-inprocess-registry-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1000,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	const firstPath = join(scratch, "original.jsonl");
	try {
		const sessions = [];
		for (let session = 0; session < DAEMON_SESSIONS; session++) {
			const command = { type: "open_session" as const, cwd, ...(session === 0 ? { sessionPath: firstPath } : {}) };
			expect(await router.handle(command)).toBeUndefined();
			await writer.flush();
			sessions.push(opened(latest, session));
		}
		expect(registry.size).toBe(DAEMON_SESSIONS);
		expect(DAEMON_SESSIONS).toBeGreaterThan(SESSION_WORKER_LIMITS.workers);

		expect(listedSessions(await router.handle({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);

		const first = sessions[0];
		if (!first) throw new Error("No first session");
		expect(await router.handle({ type: "open_session", cwd, sessionPath: firstPath })).toBeUndefined();
		await writer.flush();
		expect(opened(latest, 0)).toMatchObject({ attached: true, sessionId: first.sessionId });
		expect(registry.peek(first.sessionId)?.attachments).toBe(2);

		for (let attachment = 0; attachment < 2; attachment++) {
			await router.handle({ type: "close_session", sessionId: first.sessionId });
			await writer.flush();
		}
		expect(registry.peek(first.sessionId)).toBeUndefined();
		expect(registry.size).toBe(DAEMON_SESSIONS - 1);

		expect(await router.handle({ type: "open_session", cwd, sessionPath: firstPath })).toBeUndefined();
		await writer.flush();
		// Reopen, not attach: the close released the path reservation, so the same file
		// is openable again (a leaked reservation would answer `session_path_in_use`).
		const reopened = opened(latest, 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(first.sessionId);
		expect(reopened.state.sessionFile).toBe(first.state.sessionFile);
		expect(registry.size).toBe(DAEMON_SESSIONS);
	} finally {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
}, 300_000);

it("runs every session of a --listen socket host in the host process", async () => {
	const host = await startInProcessHost();
	try {
		const pid = host.child.pid;
		if (pid === undefined) throw new Error("Host has no pid");
		const client = await host.connect();
		const firstPath = join(host.scratch, "original.jsonl");
		const sessions = [];
		let threadsAfterFirstOpen = 0;
		for (let session = 0; session < DAEMON_SESSIONS; session++) {
			const command = { type: "open_session", cwd: host.cwd, ...(session === 0 ? { sessionPath: firstPath } : {}) };
			sessions.push(opened(await client.request(command), session));
			// Read after the first open: the runtime's thread pool warms up once, and the
			// claim under test is that sessions 2..45 add no thread of their own.
			if (session === 0) threadsAfterFirstOpen = threadCount(pid);
		}
		expect(sessions).toHaveLength(DAEMON_SESSIONS);
		const threadGrowth = threadCount(pid) - threadsAfterFirstOpen;
		process.stderr.write(`in-process host ${pid}: +${threadGrowth} threads across ${DAEMON_SESSIONS - 1} opens\n`);
		expect(threadGrowth).toBeLessThan(MAX_THREADS_PER_SESSION * (DAEMON_SESSIONS - 1));
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);

		const first = sessions[0];
		if (!first) throw new Error("No first session");
		const attached = await client.request({ type: "open_session", cwd: host.cwd, sessionPath: firstPath });
		expect(opened(attached, 0)).toMatchObject({ attached: true, sessionId: first.sessionId });
		for (let attachment = 0; attachment < 2; attachment++) {
			expect(await client.request({ type: "close_session", sessionId: first.sessionId })).toMatchObject({
				success: true,
			});
		}
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS - 1);

		const reopened = opened(await client.request({ type: "open_session", cwd: host.cwd, sessionPath: firstPath }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(first.sessionId);
		expect(reopened.state.sessionFile).toBe(first.state.sessionFile);
		expect(listedSessions(await client.request({ type: "list_sessions" }))).toHaveLength(DAEMON_SESSIONS);
	} finally {
		await host.dispose();
	}
}, 600_000);

it("keeps the worker runtime and its session cap when --session-runtime worker is selected", async () => {
	const host = await startWorkerHost(undefined, { socket: true, sessionRuntime: "worker" });
	try {
		const pid = host.child.pid;
		if (pid === undefined) throw new Error("Host has no pid");
		const client = await host.connect();
		const before = threadCount(pid);
		for (let session = 0; session < SESSION_WORKER_LIMITS.workers; session++) {
			opened(await client.request({ type: "open_session", cwd: host.cwd }), session);
		}
		process.stderr.write(
			`worker host ${pid}: +${threadCount(pid) - before} threads across ${SESSION_WORKER_LIMITS.workers} opens\n`,
		);
		// The flag selects a runtime; it does not delete the worker runtime's admission bound.
		expect(await client.request({ type: "open_session", cwd: host.cwd })).toMatchObject({
			success: false,
			error: "open_failed: too_many_sessions",
		});
	} finally {
		await host.dispose();
	}
}, 600_000);

it("defaults socket hosts to the in-process runtime and keeps stdio hosts on workers", () => {
	const runtimeOf = (args: string[]) =>
		resolveSessionRuntime(parseArgs(["--mode", "rpc", "--multi-session", ...args]));
	expect(runtimeOf(["--listen", "unix:///tmp/senpi-rpc.sock"])).toBe("in-process");
	expect(runtimeOf(["--listen", "unix://"])).toBe("in-process");
	expect(runtimeOf([])).toBe("worker");
	expect(runtimeOf(["--listen", "stdio://"])).toBe("worker");
	expect(runtimeOf(["--listen", "unix:///tmp/senpi-rpc.sock", "--session-runtime", "worker"])).toBe("worker");
	expect(runtimeOf(["--session-runtime", "in-process"])).toBe("in-process");
	const invalid = parseArgs(["--mode", "rpc", "--session-runtime", "isolate"]);
	expect(invalid.sessionRuntime).toBeUndefined();
	expect(invalid.diagnostics).toEqual([{ type: "error", message: "--session-runtime must be in-process or worker" }]);
});

it("reopens a closed path while the previous session is still tearing down", async () => {
	// Given: a path opened by one connection and attached by a second, then closed by the
	// opener - the session survives on the connection that is still attached.
	const dir = await rigDir();
	await using rig = createInProcessRig(dir);
	const path = join(dir, "reopen.jsonl");
	const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path }), 0);
	expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: path }), 0)).toMatchObject({ attached: true });
	await rig.close("conn-a", session.sessionId);

	// When: the surviving connection drops with the teardown held open, and the path is
	// reopened while that teardown is still in flight.
	rig.teardown.hold();
	const dropped = rig.drop("conn-b");
	await rig.settle();
	expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, status: "closing" })]);
	const reopening = rig.open("conn-c", { cwd: dir, sessionPath: path });
	await rig.settle();
	rig.teardown.release();
	await dropped;

	// Then: the open waited out the teardown and opened the file fresh, instead of being
	// refused with `session_path_in_use` for a session that was already ending.
	const reopened = opened(await reopening, 0);
	expect(reopened.attached).toBeUndefined();
	expect(reopened.sessionId).not.toBe(session.sessionId);
	expect(reopened.state.sessionFile).toBe(session.state.sessionFile);
	expect(await rig.list()).toEqual([
		expect.objectContaining({ sessionId: reopened.sessionId, status: "open", attachments: 1 }),
	]);
});

describe("session retention on the in-process runtime", () => {
	it("keeps a retained session listed and re-attachable after its only connection drops", async () => {
		// Given: a retained idle session owned by exactly one connection.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		await using rig = createInProcessRig(dir, { idleEvictionMs: 60_000 });
		const path = join(dir, "retained.jsonl");
		const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path, retain_on_disconnect: true }), 0);

		// When: that connection drops and two seconds of host time pass.
		await rig.drop("conn-a");
		await vi.advanceTimersByTimeAsync(2_000);

		// Then: the session is still listed, detached, and a later open attaches to it.
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 0 }),
		]);
		const reattached = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reattached).toMatchObject({ sessionId: session.sessionId, attached: true });
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 1 })]);
	});

	it("runs a retained session's turn to settlement after its client drops", async () => {
		// Given: a retained session with one settled turn on disk and a second in flight.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "midturn.jsonl"), retain_on_disconnect: true }),
			0,
		);
		const turn = rig.turns.get(session.state.sessionFile);
		if (!turn) throw new Error("No turn control for the opened session");
		turn.start();
		turn.finish();
		const before = transcriptLines(session.state.sessionFile);
		turn.start();

		// When: the only connection drops mid-turn and the turn settles afterwards.
		await rig.drop("conn-a");
		turn.finish();
		await rig.settle();

		// Then: the run was never aborted, its assistant message reached the transcript,
		// and the session outlived the client that started it.
		expect(turn.aborted).toBe(false);
		expect(transcriptLines(session.state.sessionFile)).toBe(before + 1);
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 0 }),
		]);
	});

	it("closes a session opened without the flag when its connection drops", async () => {
		// Given: a session opened with today's defaults.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const path = join(dir, "default.jsonl");
		const session = opened(await rig.open("conn-a", { cwd: dir, sessionPath: path }), 0);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 1 })]);

		// When: its only connection drops.
		await rig.drop("conn-a");

		// Then: it is torn down exactly as before the flag existed - gone from the listing,
		// its path released (the reopen creates a new handle instead of attaching), and the
		// host never reports it as parked.
		expect(await rig.list()).toEqual([]);
		const reopened = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(session.sessionId);
		expect(rig.records().filter((record) => record.type === "session_parked")).toEqual([]);
	});

	it("closes a retained detached session on an explicit close_session", async () => {
		// Given: a retained session that survived its owner's drop and was re-attached.
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "explicit.jsonl"), retain_on_disconnect: true }),
			0,
		);
		await rig.drop("conn-a");
		expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0)).toMatchObject({
			attached: true,
		});

		// When: the attached connection closes it explicitly.
		await rig.close("conn-b", session.sessionId);

		// Then: retention never outranks an explicit close.
		expect(await rig.list()).toEqual([]);
		expect(rig.records()).toContainEqual(
			expect.objectContaining({ type: "session_closed", sessionId: session.sessionId }),
		);
	});

	it("parks a retained session at the idle window and tells the connection that stayed attached", async () => {
		// Given: a retained session opened by one connection and attached by a second.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		await using rig = createInProcessRig(dir, { idleEvictionMs: IDLE_WINDOW_MS });
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "parked.jsonl"), retain_on_disconnect: true }),
			0,
		);
		expect(opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0)).toMatchObject({
			attached: true,
		});
		await rig.drop("conn-a");

		// When: the idle window elapses with the session detached from its opener.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		await rig.settle();

		// Then: the still-attached connection is told the session was PARKED - never closed -
		// and its path reopens as a fresh session.
		expect(rig.recordsFor("conn-b")).toContainEqual({
			type: "session_parked",
			sessionId: session.sessionId,
			sessionPath: session.state.sessionFile,
		});
		expect(rig.records().filter((record) => record.type === "session_closed")).toEqual([]);
		expect(await rig.list()).toEqual([]);
		const reopened = opened(await rig.open("conn-b", { cwd: dir, sessionPath: session.state.sessionFile }), 0);
		expect(reopened.attached).toBeUndefined();
		expect(reopened.sessionId).not.toBe(session.sessionId);
	});

	it("exits the empty host once its only retained session has been parked", async () => {
		// Given: a retained session whose only connection dropped, on a host with both windows armed.
		vi.useFakeTimers({ toFake: [...IDLE_CLOCK_FAKES] });
		const dir = await rigDir();
		const onEmptyExit = vi.fn();
		await using rig = createInProcessRig(dir, {
			idleEvictionMs: IDLE_WINDOW_MS,
			emptyExitMs: EMPTY_EXIT_MS,
			onEmptyExit,
		});
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "exit.jsonl"), retain_on_disconnect: true }),
			0,
		);
		await rig.drop("conn-a");

		// A live retained session is occupancy: the empty-host window does not start.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS / 2);
		expect(await rig.list()).toEqual([expect.objectContaining({ sessionId: session.sessionId, attachments: 0 })]);

		// When: it is parked by the idle sweep and the empty-host window then elapses.
		await vi.advanceTimersByTimeAsync(IDLE_WINDOW_MS * 2);
		expect(await rig.list()).toEqual([]);
		expect(onEmptyExit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(EMPTY_EXIT_MS * 2);

		// Then: a parked session holds nothing open - the host exits exactly once.
		expect(onEmptyExit).toHaveBeenCalledTimes(1);
	});

	it("refuses close_session from a connection that never attached to the session", async () => {
		// Given: a retained session owned by one connection, and a second connection that
		// only ever listed it (routing handles are public on a shared host).
		const dir = await rigDir();
		await using rig = createInProcessRig(dir);
		const session = opened(
			await rig.open("conn-a", { cwd: dir, sessionPath: join(dir, "owned.jsonl"), retain_on_disconnect: true }),
			0,
		);

		// When: the never-attached connection closes it by that handle.
		const refusal = await rig.close("conn-b", session.sessionId);

		// Then: the close is refused and the session keeps its owner's attachment.
		expect(refusal).toMatchObject({ command: "close_session", success: false, error: "unknown_session" });
		expect(await rig.list()).toEqual([
			expect.objectContaining({ sessionId: session.sessionId, status: "open", attachments: 1 }),
		]);
		expect(rig.records().filter((record) => record.type === "session_closed")).toEqual([]);
	});
});
