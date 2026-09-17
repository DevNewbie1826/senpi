import { fauxAssistantMessage, registerFauxProvider, type Tool } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Incident 2026-09-17: a (mahoquot) z-ai/glm-5.3-flash session surfaced
 * "Compaction rejected: summarization response contained no text
 * (stopReason: stop)" repeatedly on large tool-bearing summarization
 * prompts. The gateway recorded HTTP 200 SSE responses carrying only the
 * role prelude (completion=7 tokens) — the relay completed "normally" with
 * zero text because the summarization request pins an explicit reasoning
 * effort onto the prompt.
 *
 * The summarizer deliberately sets reasoningEffort (first non-null of
 * low/medium/high) to keep compaction cheap. Some OpenAI-completions relays
 * answer that combination with a silent stop, so an empty stop response
 * earns exactly one retry of the same request WITHOUT the reasoning-effort
 * override before the terminal empty-summary error surfaces. Persistent
 * emptiness keeps the existing contract: SummaryGenerationError +
 * deterministic fallback classification.
 */

const CONTEXT_WINDOW = 200_000;

const SUMMARIZATION_TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read a file from disk",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
];

function emptyStopResponse() {
	return fauxAssistantMessage("", { stopReason: "stop" });
}

function shortHistory() {
	return [
		{ role: "user" as const, content: [{ type: "text" as const, text: "please refactor the parser" }], timestamp: 1 },
		{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done: parser refactored" }],
			timestamp: 2,
		},
	];
}

function reasoningEffortOf(entry: { options?: unknown } | undefined): unknown {
	return (entry?.options as { reasoningEffort?: unknown } | undefined)?.reasoningEffort;
}

function createModelContext(options?: { reasoning?: boolean; tools?: Tool[] }) {
	const registration = registerFauxProvider({
		api: "openai-completions",
		models: [{ id: "summarizer-faux", reasoning: options?.reasoning ?? true, contextWindow: CONTEXT_WINDOW }],
	});
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = Object.create(null) as SpeculativeCompactionContext["modelRegistry"];
	if (modelRegistry) {
		modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "test-key" }));
	}
	const context = {
		model,
		sessionManager,
		modelRegistry,
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: CONTEXT_WINDOW }),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
	} as unknown as SpeculativeCompactionContext;
	const snapshot = {
		generation: 1,
		expectedRevision: 1,
		model,
		contextWindow: CONTEXT_WINDOW,
		preparation: {
			firstKeptEntryId: "keep",
			messagesToSummarize: shortHistory(),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 12_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default" as const,
		origin: "blocking" as const,
		systemPrompt: "agent system prompt",
		...(options?.tools ? { tools: options.tools } : {}),
	} as unknown as SpeculativeCompactionSnapshot;
	return { registration, context, snapshot };
}

describe("summarization empty-stop reasoning-override retry", () => {
	it("Given a reasoning summarizer that stops with no text When compaction runs Then the request is retried once without the reasoning effort override and the retry summary is used", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([emptyStopResponse(), fauxAssistantMessage("recovered summary")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(reasoningEffortOf(calls[0])).toBe("low");
		expect(reasoningEffortOf(calls[1])).toBeUndefined();
	});

	it("Given persistent empty stop responses When compaction runs Then exactly one retry is spent before empty-summary surfaces", async () => {
		const { registration, context, snapshot } = createModelContext({ tools: SUMMARIZATION_TOOLS });
		registration.setResponses([emptyStopResponse(), emptyStopResponse()]);

		let caught: unknown;
		try {
			await runExtensionCompaction(context, snapshot);
		} catch (error) {
			caught = error;
		}

		expect((caught as Error | undefined)?.name).toBe("SummaryGenerationError");
		expect((caught as { kind?: string } | undefined)?.kind).toBe("empty-summary");
		expect((caught as Error | undefined)?.message).toContain("stopReason: stop");
		expect(registration.getCallLog()).toHaveLength(2);
	});

	it("Given a non-reasoning summarizer with a recovery on its second response When compaction runs Then the retry still applies and no effort override was ever offered", async () => {
		const { registration, context, snapshot } = createModelContext({ reasoning: false, tools: SUMMARIZATION_TOOLS });
		registration.setResponses([emptyStopResponse(), fauxAssistantMessage("recovered summary")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result?.summary).toBe("recovered summary");
		const calls = registration.getCallLog();
		expect(calls).toHaveLength(2);
		expect(reasoningEffortOf(calls[0])).toBeUndefined();
		expect(reasoningEffortOf(calls[1])).toBeUndefined();
	});
});
