import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels, supportsMax, supportsXhigh } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * GPT-6 Sol and GPT-6 Luna (developers.openai.com/api/docs/guides/latest-model,
 * 2026-09-23): the two non-Astra tiers of the GPT-6 family. Both document
 * `reasoning.effort` none/low/medium/high/xhigh/max, a 1,050,000-token window
 * with a 922,000-token input cap, 128,000 output tokens, text + image input,
 * and the >272k long-context multipliers (2x input/cache, 1.5x output).
 *
 * Published list prices per MTok: Sol 2 / 10 (cache read 0.2, write 2.5),
 * Luna 0.1 / 0.5 (cache read 0.01, write 0.125).
 *
 * Project defaults for the prompt budget (`contextWindow` is the prompt budget,
 * not the documented window): Luna ships the full 922,000 input cap, Sol ships
 * 400,000, Astra keeps 600,000. Like Astra, each tier's number is stamped on
 * every provider catalog so the budget does not change with the route.
 */
const SOL_CONTEXT_WINDOW = 400_000;
const LUNA_CONTEXT_WINDOW = 922_000;

const EXPECTED = {
	"gpt-6-sol": {
		name: "GPT-6 Sol",
		contextWindow: SOL_CONTEXT_WINDOW,
		cost: {
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
		},
	},
	"gpt-6-luna": {
		name: "GPT-6 Luna",
		contextWindow: LUNA_CONTEXT_WINDOW,
		cost: {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			tiers: [{ inputTokensAbove: 272000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }],
		},
	},
} as const;

type FamilyId = keyof typeof EXPECTED;
const FAMILY_IDS = Object.keys(EXPECTED) as FamilyId[];

for (const provider of ["openai", "chatgpt-subscription"] as const) {
	for (const id of FAMILY_IDS) {
		describe(`${provider}/${id}`, () => {
			it("has the published catalog metadata and long-context pricing", () => {
				const model = getModel(provider, id);
				expect(model).toMatchObject({
					id,
					name: EXPECTED[id].name,
					api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
					provider,
					baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: EXPECTED[id].contextWindow,
					maxTokens: 128000,
					cost: EXPECTED[id].cost,
				});
			});

			it("exposes the documented reasoning efforts, with off available and minimal absent", () => {
				const model = getModel(provider, id)!;
				// Unlike Astra, Sol and Luna accept `none`; like Astra, the GPT-6 ladder has no `minimal`.
				expect(model.thinkingLevelMap).toMatchObject({
					minimal: null,
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
				});
				if (provider === "openai") {
					expect(model.thinkingLevelMap?.off).toBe("none");
				}
				expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
				expect(supportsXhigh(model)).toBe(true);
				expect(supportsMax(model)).toBe(true);
			});

			it("exposes the tool-search and additional-tools metadata", () => {
				const model = getModel(provider, id)!;
				const compat = model.compat as
					| { supportsToolSearch?: boolean; supportsAdditionalTools?: boolean }
					| undefined;
				expect(compat?.supportsToolSearch).toBe(true);
				expect(compat?.supportsAdditionalTools).toBe(true);
			});

			it("has a priority fast variant", () => {
				const fast = getModel(provider, `${id}-fast`);
				expect(fast).toMatchObject({
					id: `${id}-fast`,
					upstreamModelId: id,
					serviceTier: "priority",
					contextWindow: EXPECTED[id].contextWindow,
				});
			});
		});
	}
}

// A map-less model exercises the id-based inference in models.ts
// (XHIGH_MODEL_IDS / OPENAI_MAX_MODEL_IDS / OPENAI_MAX_APIS) directly, so a
// custom provider that ships the bare id still surfaces xhigh and max, and -
// unlike Astra - keeps `off` selectable because the tier documents `none`.
function maplessModel(id: FamilyId, api: Api): Model<Api> {
	return {
		id,
		name: EXPECTED[id].name,
		api,
		provider: "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	};
}

describe("GPT-6 Sol/Luna effort inference without a thinking-level map", () => {
	for (const id of FAMILY_IDS) {
		for (const api of [
			"openai-responses",
			"openai-codex-responses",
			"azure-openai-responses",
			"openai-completions",
		] as const) {
			it(`infers xhigh and max and keeps off for a map-less ${id} on ${api}`, () => {
				const model = maplessModel(id, api);
				expect(supportsXhigh(model)).toBe(true);
				expect(supportsMax(model)).toBe(true);
				const levels = getSupportedThinkingLevels(model);
				expect(levels).toContain("off");
				expect(levels).toContain("xhigh");
				expect(levels).toContain("max");
			});
		}
	}
});

// Every catalog that ships a tier declares that tier's project default budget,
// mirroring gpt-6-astra-context-window.test.ts for the rest of the family.
const dataDirectory = fileURLToPath(new URL("../src/providers/data/", import.meta.url));

type CatalogEntry = { id?: unknown; contextWindow?: unknown };
type FamilyEntry = { file: string; api: string; id: string; contextWindow: unknown };

function collectFamilyEntries(marker: FamilyId): FamilyEntry[] {
	const entries: FamilyEntry[] = [];
	for (const file of readdirSync(dataDirectory)
		.filter((name) => name.endsWith(".json"))
		.sort()) {
		const parsed = JSON.parse(readFileSync(`${dataDirectory}${file}`, "utf8")) as Record<
			string,
			Record<string, CatalogEntry>
		>;
		for (const [api, models] of Object.entries(parsed)) {
			if (!models || typeof models !== "object") continue;
			for (const [id, model] of Object.entries(models)) {
				if (!id.includes(marker)) continue;
				entries.push({ file, api, id, contextWindow: model?.contextWindow });
			}
		}
	}
	return entries;
}

describe("GPT-6 Sol/Luna series catalog context window", () => {
	for (const id of FAMILY_IDS) {
		it(`declares ${EXPECTED[id].contextWindow} for every ${id} entry in every provider catalog`, () => {
			const entries = collectFamilyEntries(id);
			expect(entries.length, `generated catalogs should ship ${id} entries`).toBeGreaterThan(0);
			const offenders = entries
				.filter((entry) => entry.contextWindow !== EXPECTED[id].contextWindow)
				.map((entry) => `${entry.file}:${entry.api}/${entry.id}=${String(entry.contextWindow)}`)
				.sort();
			expect(offenders, `${id} entries must all declare the tier context window`).toEqual([]);
		});

		it(`ships ${id} in the first-party OpenAI catalogs`, () => {
			const files = [...new Set(collectFamilyEntries(id).map((entry) => entry.file))];
			expect(files).toEqual(expect.arrayContaining(["openai.json", "chatgpt-subscription.json"]));
		});
	}
});
