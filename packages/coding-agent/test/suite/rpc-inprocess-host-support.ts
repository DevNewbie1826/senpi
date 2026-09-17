import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../src/core/agent-session-runtime.ts";
import { isSessionBusySnapshot } from "../../src/core/session-activity.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { type RpcSessionIdlePolicy, SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";

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
const outcomeSchema = z.object({ success: z.boolean(), error: z.string().optional() });

export function listedSessions(record: unknown) {
	return listedSchema.parse(record).data.sessions;
}

/** Names the refusal in the failure message: a capped host answers `open_failed: too_many_sessions`. */
export function opened(record: unknown, index: number) {
	const outcome = outcomeSchema.parse(record);
	if (!outcome.success) throw new Error(`open_session ${index} failed: ${outcome.error}`);
	return openedSchema.parse(record).data;
}

/**
 * Threads a session may add without being an isolate. A session costs watcher
 * threads in BOTH runtimes (measured on macOS: 2.0/session in-process); a worker
 * session additionally carries its own isolate (measured 3.0/session). The bound
 * is the ceiling between those two, so an isolate creeping back onto the daemon
 * path shows up here; the hard proof stays the 20-worker cap.
 */
export const MAX_THREADS_PER_SESSION = 3;

/** Persisted transcript entries of one session file: one JSONL line per appended entry. */
export function transcriptLines(sessionFile: string): number {
	// A session that has persisted nothing yet has no file on disk: zero entries.
	const content = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trimEnd() : "";
	return content === "" ? 0 : content.split("\n").length;
}

/** Live thread count of one process: macOS exposes threads through `ps -M`, Linux through /proc. */
export function threadCount(pid: number): number {
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

/** The one persisted artifact of a settled turn in these tests: the assistant's message. */
export function assistantMessage(text: string): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };
type ListedRow = { sessionId: string; status: string; sessionPath?: string; attachments: number };

/** Fields these tests send on `open_session`. */
interface OpenFields {
	cwd?: string;
	sessionPath?: string;
	retain_on_disconnect?: boolean;
}

/** One session's turn, driven by the test instead of by a model. */
export interface FakeTurn {
	/** The session reports a streaming, busy turn from here on. */
	start(): void;
	/** Settle the turn, persisting the assistant message a completed turn produces. */
	finish(): void;
	/** True once the host aborted this session's run (the close path does). */
	readonly aborted: boolean;
}

/**
 * The in-process registry's runtime, faked at the seam the daemon path actually
 * uses: a REAL `SessionManager` (so the transcript on disk is the real one) with a
 * session whose turn the test starts and settles. `abort()` is honored - a turn
 * the host aborted persists nothing - so a test that expects a turn to outlive its
 * client's disconnect fails if the host tore the session down instead.
 */
function inProcessRuntimeFactory(): { createRuntime: CreateAgentSessionRuntimeFactory; turns: Map<string, FakeTurn> } {
	const turns = new Map<string, FakeTurn>();
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		new ProjectTrustStore(options.agentDir).set(options.cwd, true);
		const manager = options.sessionManager;
		const state = { isStreaming: false, aborted: false };
		turns.set(manager.getSessionFile() ?? manager.getSessionId(), {
			start: () => {
				state.isStreaming = true;
			},
			finish: () => {
				state.isStreaming = false;
				if (!state.aborted) manager.appendMessage(assistantMessage("turn result"));
			},
			get aborted() {
				return state.aborted;
			},
		});
		return {
			session: {
				sessionManager: manager,
				agentDir: options.agentDir,
				isFastModeActive: () => false,
				getContextUsage: () => undefined,
				favoriteModels: [],
				scopedModels: [],
				get sessionFile() {
					return manager.getSessionFile();
				},
				get sessionId() {
					return manager.getSessionId();
				},
				get isStreaming() {
					return state.isStreaming;
				},
				isBashRunning: false,
				isCompacting: false,
				// Composed through the production predicate so this fake cannot drift
				// from the activity contract the sweep consults.
				get isSessionBusy() {
					return isSessionBusySnapshot({
						isStreaming: state.isStreaming,
						isBashRunning: false,
						isCompacting: false,
						hasSessionWork: false,
						hasActiveWakeSource: false,
					});
				},
				extensionRunner: { hasHandlers: () => false, emit: async () => {} },
				subscribe: () => () => {},
				abort: async () => {
					state.aborted = true;
					state.isStreaming = false;
				},
				abortBash: () => {},
				waitForIdle: async () => {},
				dispose: () => {},
				messages: [],
				pendingMessageCount: 0,
			},
			services: { cwd: options.cwd, agentDir: options.agentDir },
			diagnostics: [],
		} as unknown as CreateAgentSessionRuntimeResult;
	};
	return { createRuntime, turns };
}

/**
 * One in-process multi-session host: the real router, the real `RpcSessionRegistry`
 * and the real event writer with per-connection sinks, so every lifecycle decision
 * under test (attachment refcount, connection drop, idle sweep, empty-host exit)
 * runs its production code path on the runtime the daemon selects.
 */
export function createInProcessRig(dir: string, idle?: RpcSessionIdlePolicy) {
	const { createRuntime, turns } = inProcessRuntimeFactory();
	// One clock for both halves of the idle contract: the registry stamps `lastCommandAt`
	// and the router's sweep compares against it.
	const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime, now: idle?.now });
	const delivered: Array<{ connection?: string; record: WireRecord }> = [];
	const writer = new SessionEventWriter((line) => delivered.push({ record: JSON.parse(line) as WireRecord }));
	const registered = new Set<string>();
	const connect = (connection: string): string => {
		if (registered.has(connection)) return connection;
		writer.registerConnection(connection, {
			writeRaw: (line) => delivered.push({ connection, record: JSON.parse(line) as WireRecord }),
			waitForBackpressure: async () => {},
		});
		registered.add(connection);
		return connection;
	};
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd: dir },
		async () => ({ handle: async () => {}, dispose: async () => {}, cancelPendingExtensionUiRequests: () => {} }),
		{},
		idle,
	);
	let requests = 0;
	/** Drains the host's microtask-driven lifecycle chains, then its record queues. */
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
		await writer.flush();
	};
	const send = async (connection: string, command: RpcCommand, id: string): Promise<WireRecord | undefined> => {
		const direct = await writer.withConnection(connect(connection), () => router.handle(command));
		await settle();
		return (direct as WireRecord | undefined) ?? delivered.findLast((entry) => entry.record.id === id)?.record;
	};
	return {
		registry,
		router,
		turns,
		settle,
		async open(connection: string, fields: OpenFields): Promise<WireRecord | undefined> {
			const id = `open-${++requests}`;
			return send(connection, { type: "open_session", id, ...fields }, id);
		},
		async close(connection: string, sessionId: string): Promise<WireRecord | undefined> {
			const id = `close-${++requests}`;
			return send(connection, { type: "close_session", id, sessionId }, id);
		},
		/** The socket host's own drop order: unregister the transport, then release its sessions. */
		async drop(connection: string): Promise<void> {
			writer.unregisterConnection(connection);
			registered.delete(connection);
			await router.releaseConnection(connection);
			await settle();
		},
		async list(): Promise<ListedRow[]> {
			const response = await router.handle({ type: "list_sessions", id: `list-${++requests}` });
			return (response as { data?: { sessions?: ListedRow[] } } | undefined)?.data?.sessions ?? [];
		},
		/** Records this connection's socket received, in delivery order. */
		recordsFor(connection: string): WireRecord[] {
			return delivered.filter((entry) => entry.connection === connection).map((entry) => entry.record);
		},
		/** Every record the host wrote, on any destination. */
		records(): WireRecord[] {
			return delivered.map((entry) => entry.record);
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
		},
	};
}
