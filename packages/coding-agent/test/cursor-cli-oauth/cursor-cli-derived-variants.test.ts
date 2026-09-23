// senpi#2038
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseCursorAgentModelsListing } from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";

type CatalogEntry = ReturnType<typeof parseCursorAgentModelsListing>[number];
type CursorReasoning = NonNullable<Model<"cursor-agent">["compat"]>["cursorReasoning"];

function cursorReasoning(model: CatalogEntry | undefined): CursorReasoning | undefined {
	return (model?.compat as NonNullable<Model<"cursor-agent">["compat"]> | undefined)?.cursorReasoning;
}

describe("cursor-cli-oauth derived variant identities (senpi#2038)", () => {
	it("groups unlisted level variants into one identity with variant ids", () => {
		const listing = [
			"grok-4.7-low - Grok 4.7 Low",
			"grok-4.7-medium - Grok 4.7 Medium",
			"grok-4.7-high - Grok 4.7 High",
			"grok-4.7-xhigh - Grok 4.7 Extra High",
			"grok-4.7-xhigh-fast - Grok 4.7 Extra High Fast",
			"",
		].join("\n");
		const models = parseCursorAgentModelsListing(listing);

		const grok = models.find((model) => model.id === "grok-4.7");
		expect(grok).toBeDefined();
		expect(grok?.reasoning).toBe(true);
		expect(grok?.upstreamModelId).toBe("grok-4.7-medium");
		expect(cursorReasoning(grok)?.variantIds).toEqual({
			low: "grok-4.7-low",
			medium: "grok-4.7-medium",
			high: "grok-4.7-high",
			xhigh: "grok-4.7-xhigh",
		});

		const fast = models.find((model) => model.id === "grok-4.7-xhigh-fast");
		expect(fast).toBeDefined();
		expect(fast?.reasoning).toBe(false);
		expect(cursorReasoning(fast)).toBeUndefined();
	});
});
