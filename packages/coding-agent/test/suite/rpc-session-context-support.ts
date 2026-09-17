/**
 * Fixture for the session kind/context suite: ONE in-process multi-session host core
 * (the real registry a daemon runs, the real router, writer and fanout) with every
 * connection's inbox observable, plus the wire helpers its assertions parse with.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";

/**
 * Publishes the per-session identity the host injected into THIS extension instance.
 * One extension file is loaded once per session, so a leaked identity (a shared
 * module-level value, a host-wide default) shows up as two sessions reporting the same
 * context.
 */
export const PROBE_EXTENSION = `export default function (pi) {
	pi.rpc.handle("probe.identity", () => ({ kind: pi.sessionKind, context: pi.sessionContext }));
}`;

type WireRecord = Record<string, unknown> & { id?: string; type?: string; sessionId?: string };

export const identitySchema = z.object({ kind: z.string(), context: z.record(z.string(), z.string()) });
export const listedSchema = z.object({
	sessionId: z.string(),
	status: z.string(),
	kind: z.string(),
	context: z.record(z.string(), z.string()).optional(),
});
type ListedSession = z.infer<typeof listedSchema>;

/** Fields a client may send with `open_session`, including the two under test. */
interface OpenFields {
	readonly cwd?: string;
	readonly sessionPath?: string;
	readonly kind?: "interactive" | "worker";
	readonly context?: Record<string, string>;
	readonly auto_title?: boolean;
}

/**
 * The wire carries JSON, so a client can send values the typed command surface forbids -
 * that is exactly what the host's boundary validation exists for. This mirrors the one
 * cast the real host performs on a parsed line (`multi-session-host.ts`).
 */
function wireCommand(command: Record<string, unknown>): RpcCommand {
	return JSON.parse(JSON.stringify(command)) as RpcCommand;
}

export function responseData(record: WireRecord | undefined): Record<string, unknown> {
	const outcome = z
		.object({
			success: z.boolean(),
			error: z.string().optional(),
			data: z.record(z.string(), z.unknown()).optional(),
		})
		.parse(record);
	if (!outcome.success) throw new Error(`request failed: ${outcome.error}`);
	return outcome.data ?? {};
}

/**
 * One in-process multi-session host core: the real registry the daemon runs
 * (`RpcSessionRegistry`), the real router, the real event writer and fanout, and real
 * per-session runtimes that load the probe extension. Only the socket transport is
 * replaced, so every connection's inbox is observable per connection.
 */
export async function contextHost(
	options: { idleEvictionMs?: number; autoTitleSessions?: boolean; titleModel?: boolean } = {},
) {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-session-context-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const probe = join(scratch, "probe.mjs");
	await writeFile(probe, PROBE_EXTENSION);
	const faux = options.titleModel === true ? fauxProvider({ api: "fauxtitle", provider: "fauxtitle" }) : undefined;
	const model = faux?.getModel();
	if (faux) {
		faux.setResponses([
			fauxAssistantMessage("turn complete"),
			fauxAssistantMessage("<title>Generated Title</title>"),
		]);
	}
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--extension",
		probe,
		...(options.autoTitleSessions === true ? ["--auto-title-sessions"] : []),
		...(model ? ["--provider", model.provider, "--model", model.id, "--api-key", "faux-key"] : []),
	]);
	const clock = { now: 0 };
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory(
			{ parsed, cwd, agentDir, appMode: "rpc" },
			faux ? { extensionFactories: [(pi) => pi.registerProvider(faux.provider)] } : {},
		),
		closeGraceMs: 1_000,
		now: () => clock.now,
	});
	const stdio: WireRecord[] = [];
	const inboxes = new Map<string, WireRecord[]>();
	const listeners = new Set<(record: WireRecord) => void>();
	const observe = (sink: WireRecord[], line: string): void => {
		const record = JSON.parse(line) as WireRecord;
		sink.push(record);
		for (const listener of [...listeners]) listener(record);
	};
	/** Event-bounded wait over every destination the host writes to; never a sleep or a poll. */
	const waitFor = (predicate: (record: WireRecord) => boolean, ms = 30_000): Promise<WireRecord> => {
		const seen = [stdio, ...inboxes.values()].flat().find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			const listener = (record: WireRecord): void => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				listeners.delete(listener);
				resolve(record);
			};
			timer = setTimeout(() => {
				listeners.delete(listener);
				reject(new Error(`Deadline waiting for ${String(predicate).replace(/\s+/g, " ").slice(0, 160)}`));
			}, ms);
			listeners.add(listener);
		});
	};
	const writer = new SessionEventWriter((line) => observe(stdio, line));
	const connect = (connection: string): string => {
		const existing = inboxes.get(connection);
		if (existing) return connection;
		const inbox: WireRecord[] = [];
		inboxes.set(connection, inbox);
		writer.registerConnection(connection, {
			writeRaw: (line) => observe(inbox, line),
			waitForBackpressure: async () => {},
		});
		return connection;
	};
	const router = new SessionCommandRouter(
		registry,
		writer,
		{ cwd },
		undefined,
		{},
		{
			now: () => clock.now,
			idleEvictionMs: options.idleEvictionMs,
		},
	);
	let serial = 0;
	const settle = async (): Promise<void> => {
		for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
		await writer.flush();
	};
	const send = async (connection: string, command: RpcCommand): Promise<WireRecord | undefined> => {
		const id = `req-${++serial}`;
		const direct = await writer.withConnection(connect(connection), () => router.handle({ ...command, id }));
		await settle();
		return (direct as WireRecord | undefined) ?? inboxes.get(connection)?.find((record) => record.id === id);
	};
	return {
		cwd,
		scratch,
		clock,
		router,
		faux,
		inbox: (connection: string): readonly WireRecord[] => inboxes.get(connect(connection)) ?? [],
		connect,
		send,
		async prompt(connection: string, sessionId: string, message: string): Promise<void> {
			const idle = waitFor((record) => record.type === "agent_idle" && record.sessionId === sessionId);
			const record = await send(connection, { type: "prompt", sessionId, message });
			if (record?.success === false) throw new Error(`prompt failed: ${String(record.error)}`);
			await idle;
			await settle();
			await registry.peek(sessionId)?.runtime?.session.waitForSettledSessionWork();
		},
		async open(connection: string, fields: OpenFields): Promise<Record<string, unknown>> {
			return responseData(await send(connection, { type: "open_session", cwd, ...fields }));
		},
		/** Opens with raw wire fields: a refusal path is reached by values the types forbid. */
		async openFailure(connection: string, fields: Record<string, unknown>): Promise<string> {
			const record = await send(connection, wireCommand({ type: "open_session", cwd, ...fields }));
			const outcome = z.object({ success: z.boolean(), error: z.string().optional() }).parse(record);
			if (outcome.success) throw new Error("open_session unexpectedly succeeded");
			return outcome.error ?? "";
		},
		/** The identity the session's own extension instance saw at registration time. */
		async probe(connection: string, sessionId: string): Promise<z.infer<typeof identitySchema>> {
			const record = await send(connection, { type: "extension_request", name: "probe.identity", sessionId });
			return identitySchema.parse(responseData(record));
		},
		async list(connection: string, includeWorkers?: boolean): Promise<ListedSession[]> {
			const record = await send(connection, {
				type: "list_sessions",
				...(includeWorkers === undefined ? {} : { include_workers: includeWorkers }),
			});
			return z.array(listedSchema).parse(responseData(record).sessions);
		},
		/**
		 * Closes an idle session through the host's OWN occupancy sweep - the lifecycle
		 * path a daemon uses - and waits for that session's terminal close response
		 * instead of a timer, so the assertions run after the records were written.
		 */
		async evictIdle(sessionId: string): Promise<void> {
			clock.now += 3_600_000;
			const closed = waitFor(
				(record) =>
					record.type === "response" && record.command === "close_session" && record.sessionId === sessionId,
			);
			router.sweepIdleSessions();
			await closed;
			await settle();
		},
		async [Symbol.asyncDispose]() {
			await router.dispose();
			await rm(scratch, { recursive: true, force: true });
		},
	};
}
