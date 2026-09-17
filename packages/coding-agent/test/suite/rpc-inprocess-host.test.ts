import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { parseArgs, resolveSessionRuntime } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { startInProcessHost, startWorkerHost } from "./rpc-worker-host-support.ts";

/** Sessions opened on one host: more than double the worker runtime's 20-worker cap. */
const DAEMON_SESSIONS = 45;

const openedSchema = z.object({
	type: z.literal("response"),
	command: z.literal("open_session"),
	success: z.literal(true),
	data: z.object({
		sessionId: z.string(),
		attached: z.boolean().optional(),
		state: z.object({ sessionId: z.string(), sessionFile: z.string() }),
	}),
});
const listedSchema = z.object({
	success: z.literal(true),
	data: z.object({ sessions: z.array(z.object({ sessionId: z.string() })) }),
});

function listedSessions(record: unknown) {
	return listedSchema.parse(record).data.sessions;
}

const outcomeSchema = z.object({ success: z.boolean(), error: z.string().optional() });

/** Names the refusal in the failure message: a capped host answers `open_failed: too_many_sessions`. */
function opened(record: unknown, index: number) {
	const outcome = outcomeSchema.parse(record);
	if (!outcome.success) throw new Error(`open_session ${index} failed: ${outcome.error}`);
	return openedSchema.parse(record).data;
}

/**
 * Threads a session may add without being an isolate. A session costs watcher
 * threads in BOTH runtimes (measured on macOS: 2.0/session in-process); a worker
 * session additionally carries its own isolate (measured 3.0/session). The bound
 * is the ceiling between those two, so an isolate creeping back onto the daemon
 * path shows up here; the hard proof stays the 20-worker cap below.
 */
const MAX_THREADS_PER_SESSION = 3;

/** Live thread count of one process: macOS exposes threads through `ps -M`, Linux through /proc. */
function threadCount(pid: number): number {
	if (process.platform === "linux") {
		return Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^Threads:\s+(\d+)$/m)?.[1]);
	}
	// `ps -M <pid> | wc -l` minus the header row.
	return (
		execFileSync("ps", ["-M", String(pid)], { encoding: "utf8" })
			.trim()
			.split("\n").length - 1
	);
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
