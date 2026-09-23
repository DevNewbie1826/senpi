import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { findInitialModel } from "../src/core/model-resolver.ts";

type InitialModelRuntime = Parameters<typeof findInitialModel>[0]["modelRuntime"];

function runtimeFor(availableModels: Model<Api>[]): InitialModelRuntime {
	return {
		getAvailableSnapshot: () => availableModels,
		getModel: (provider: string, modelId: string) =>
			availableModels.find((model) => model.provider === provider && model.id === modelId),
		hasConfiguredAuth: () => true,
	} as unknown as InitialModelRuntime;
}

describe("OpenAI provider defaults", () => {
	test("prefers GPT-6 Sol automatically while preserving explicit GPT-5.5", async () => {
		const openAiModels = getModels("openai");
		const codexModels = getModels("chatgpt-subscription");
		const availableModels: Model<Api>[] = [
			openAiModels.find((model) => model.id === "gpt-6-sol"),
			codexModels.find((model) => model.id === "gpt-6-sol"),
			openAiModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.5"),
		].filter((model) => model !== undefined);
		const runtime = runtimeFor(availableModels);

		const automatic = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		const explicit = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "chatgpt-subscription",
			defaultModelId: "gpt-5.5",
			modelRuntime: runtime,
		});

		expect(automatic.model?.id).toBe("gpt-6-sol");
		expect(automatic.provenance).toBe("provider-default");
		expect(explicit.model?.id).toBe("gpt-5.5");
		expect(explicit.provenance).toBe("settings");
	});

	test("falls through to first-available when the registry carries GPT-5.6 Sol but not GPT-6 Sol", async () => {
		const openAiModels = getModels("openai");
		const availableModels: Model<Api>[] = [openAiModels.find((model) => model.id === "gpt-5.6-sol")].filter(
			(model) => model !== undefined,
		);

		const automatic = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtimeFor(availableModels),
		});

		expect(automatic.model?.id).toBe("gpt-5.6-sol");
		expect(automatic.provenance).toBe("first-available");
	});
});
