import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "large live context ".repeat(30_000) }],
		timestamp: timestamp - 3,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "earlier response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 150_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 151_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: timestamp - 2,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

async function createDeferralHarness(): Promise<Harness> {
	return await createHarness({
		models: [
			{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
			{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
		],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "compact summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
}

describe("#1873 deferred model switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accepts a switch that one compaction makes usable instead of refusing it", async () => {
		// given a transcript the target cannot hold yet
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing deferred switch target fixture");

		// when
		await harness.session.setModel(target);

		// then the switch is recorded as pending rather than thrown away
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		expect(harness.eventsOfType("model_change_pending")).toHaveLength(1);
	});

	it("writes nothing durable while the switch is pending", async () => {
		// given
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing pending-write fixture");

		// when
		await harness.session.setModel(target);

		// then the session is still on the model that can serve it, and the switch
		// has left no entry and no global default behind (#1526's ordering).
		expect(harness.session.model?.id).toBe("million");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(harness.settingsManager.getDefaultModel()).not.toBe("372k");
	});

	it("compacts with the original model on the next send, then applies the switch", async () => {
		// given
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing deferred repair fixture");
		await harness.session.setModel(target);
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		// when the user sends the next message
		await harness.session.prompt("continue");

		// then the transcript was reduced first and the switch landed
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(1);
	});

	it("keeps refusing a model whose fixed overhead leaves no room for any transcript", async () => {
		// given a window that cannot hold the system prompt, schemas and reserves
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "overhead-bound", contextWindow: 16_000, maxTokens: 4_000 },
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("overhead-bound");
		if (!target) throw new Error("missing impossible-target fixture");

		// when / then: no amount of compaction helps, so the refusal stands
		await expect(harness.session.setModel(target)).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: { verdict: "impossible" },
		});
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(harness.session.model?.id).toBe("million");
	});
});
