// senpi#2038
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseCursorAgentModelsListing,
	resolveCursorCliModelCatalog,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import { resolveCursorCliSpawnModel } from "../../src/core/extensions/builtin/cursor-cli-oauth/spawn-model.ts";

type CatalogEntry = ReturnType<typeof parseCursorAgentModelsListing>[number];
type CursorReasoning = NonNullable<Model<"cursor-agent">["compat"]>["cursorReasoning"];

function cursorReasoning(model: CatalogEntry | undefined): CursorReasoning | undefined {
	return (model?.compat as NonNullable<Model<"cursor-agent">["compat"]> | undefined)?.cursorReasoning;
}

const listing = [
	"grok-4.7-low - Grok 4.7 Low",
	"grok-4.7-medium - Grok 4.7 Medium",
	"grok-4.7-high - Grok 4.7 High",
	"grok-4.7-xhigh - Grok 4.7 Extra High",
	"grok-4.7-xhigh-fast - Grok 4.7 Extra High Fast",
	"",
].join("\n");
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("cursor-cli-oauth derived variant identities (senpi#2038)", () => {
	it("groups unlisted level variants into one identity with variant ids", () => {
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

	it("retains the observed wire ids through probe, cache reload, and rejects incomplete grouped cache metadata", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "cursor-derived-cache-"));
		directories.push(agentDir);
		const runProbe = vi.fn(async (_executable: string, stdoutPath: string) => {
			await writeFile(stdoutPath, listing, "utf8");
		});
		const options = {
			agentDir,
			deps: { now: () => 1_000_000, resolveExecutable: () => "cursor-agent", runProbe },
		};
		const first = await resolveCursorCliModelCatalog(options);
		const second = await resolveCursorCliModelCatalog(options);
		expect(runProbe).toHaveBeenCalledTimes(1);
		const original = first.find((model) => model.id === "grok-4.7");
		const cached = second.find((model) => model.id === "grok-4.7");
		expect(cached).toEqual(original);
		expect(cached?.thinkingLevelMap).toEqual(original?.thinkingLevelMap);
		if (!cached) throw new Error("missing cached grouped model");
		const model: Model<"cursor-agent"> = {
			...cached,
			api: "cursor-agent",
			provider: "cursor-cli-oauth",
			baseUrl: "cursor-cli-oauth",
			compat: { cursorReasoning: cursorReasoning(cached) },
		};
		expect(resolveCursorCliSpawnModel(model, { level: "xhigh", source: "explicit" })).toBe("grok-4.7-xhigh");

		const cachePath = join(agentDir, "cursor-cli-oauth", "models.json");
		const contents = JSON.parse(await readFile(cachePath, "utf8")) as {
			models: Array<{ id: string; compat?: { cursorReasoning?: { variantIds?: Record<string, string> } } }>;
		};
		const grouped = contents.models.find((entry) => entry.id === "grok-4.7");
		if (!grouped) throw new Error("missing grouped cache entry");
		delete grouped.compat?.cursorReasoning?.variantIds;
		await writeFile(cachePath, JSON.stringify(contents), "utf8");
		const refreshed = await resolveCursorCliModelCatalog(options);
		expect(runProbe).toHaveBeenCalledTimes(2);
		expect(refreshed.find((entry) => entry.id === "grok-4.7")).toEqual(original);
	});
});
