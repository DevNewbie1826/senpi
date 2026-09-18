import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { readModelDataStructure } from "../scripts/model-data.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * models.dev can stop describing a provider the fork still ships. The prune keeps that provider's
 * shard because its module imports it, and the freshly written aggregator no longer mentions it -
 * which must not read as a corrupt catalog, or the release dies before it can publish.
 */
describe("readModelDataStructure with a shard the aggregator no longer lists", () => {
	function stageCatalog(): string {
		const root = mkdtempSync(join(tmpdir(), "dh-model-data-"));
		roots.push(root);
		cpSync(join(packageRoot, "src"), join(root, "src"), { recursive: true });
		return root;
	}

	it("accepts a shard whose provider module imports it", () => {
		const root = stageCatalog();
		const aggregatorPath = join(root, "src", "models.generated.ts");
		const aggregator = readFileSync(aggregatorPath, "utf8");
		const dropped = aggregator
			.split("\n")
			.filter((line) => !line.includes("kimi-coding.models.ts") && !line.includes("KIMI_CODING_MODELS"))
			.join("\n");
		expect(dropped).not.toBe(aggregator);
		writeFileSync(aggregatorPath, dropped);

		expect(() => readModelDataStructure(root)).not.toThrow();
	});
});
