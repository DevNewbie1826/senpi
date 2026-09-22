import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensions, loadExtensionsCached } from "../../src/core/extensions/loader.ts";

interface LoaderCounterState {
	moduleLoads: Record<string, number>;
	factoryRuns: Record<string, number>;
}

declare global {
	var __extensionLoaderUncacheableTest: LoaderCounterState | undefined;
}

function state(): LoaderCounterState {
	globalThis.__extensionLoaderUncacheableTest ??= { moduleLoads: {}, factoryRuns: {} };
	return globalThis.__extensionLoaderUncacheableTest;
}

function resetState(): void {
	globalThis.__extensionLoaderUncacheableTest = undefined;
}

function writeCountingExtension(filePath: string, label: string): void {
	writeFileSync(
		filePath,
		`
const state = (globalThis.__extensionLoaderUncacheableTest ??= { moduleLoads: {}, factoryRuns: {} });
state.moduleLoads[${JSON.stringify(label)}] = (state.moduleLoads[${JSON.stringify(label)}] ?? 0) + 1;

export default function () {
	state.factoryRuns[${JSON.stringify(label)}] = (state.factoryRuns[${JSON.stringify(label)}] ?? 0) + 1;
}
`,
		"utf-8",
	);
}

/**
 * These run on the jiti importer (vitest workers are Node), which cannot report the files it
 * compiled. That importer is deliberately never cached: freshness wins over reuse where staleness
 * cannot be detected. The Bun importer's caching contract is pinned in
 * `test/extensions/extension-module-graph-reuse.test.ts`, which drives a real Bun process.
 */
describe("extension loader on an importer that cannot report its sources", () => {
	const roots: string[] = [];

	function fixture(name: string): string {
		const root = mkdtempSync(join(tmpdir(), `pi-extension-loader-${name}-`));
		roots.push(root);
		return root;
	}

	function cwd(root: string, name: string): string {
		const cwdPath = join(root, name);
		mkdirSync(cwdPath, { recursive: true });
		return cwdPath;
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
		resetState();
		clearExtensionCache();
	});

	it("re-evaluates the source on every load rather than serving a factory it cannot verify", async () => {
		// Given: one extension loaded three times from two session cwds.
		const root = fixture("fresh");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath, "fresh");
		const cwdA = cwd(root, "cwd-a");
		const cwdB = cwd(root, "cwd-b");

		// When
		await loadExtensions([extensionPath], cwdA);
		await loadExtensions([extensionPath], cwdB);
		await loadExtensions([extensionPath], cwdA);

		// Then: no stale factory is served, and every load still produced an instance.
		expect(state().moduleLoads.fresh).toBe(3);
		expect(state().factoryRuns.fresh).toBe(3);
	});

	it("treats loadExtensionsCached as an alias of loadExtensions", async () => {
		// Given: the two entry points, which no longer differ.
		const root = fixture("alias");
		const extensionPath = join(root, "counting.ts");
		writeCountingExtension(extensionPath, "alias");
		const sessionCwd = cwd(root, "cwd");

		// When
		const direct = await loadExtensions([extensionPath], sessionCwd);
		const cached = await loadExtensionsCached([extensionPath], sessionCwd);

		// Then
		expect(direct.errors).toEqual([]);
		expect(cached.errors).toEqual([]);
		expect(state().moduleLoads.alias).toBe(2);
		expect(state().factoryRuns.alias).toBe(2);
	});
});
