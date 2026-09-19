import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { clearResolvedPathsMemo } from "../src/core/resolved-paths-memo.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * A shared host builds one DefaultResourceLoader per session, and every one of
 * them ran package resolution over the same agent dir: ~68 ms of loop CPU per
 * open on the daemon (senpi#1844). Resolution is now memoized per host on the
 * inputs that decide it. This pins the two halves of that contract with real
 * loaders: same inputs share one resolution, and a settings change does not.
 */
describe("DefaultResourceLoader package resolution memo", () => {
	let scratch: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		clearResolvedPathsMemo();
		scratch = mkdtempSync(join(tmpdir(), "senpi-resolve-memo-"));
		cwd = join(scratch, "cwd");
		agentDir = join(scratch, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("OMO_CODING_AGENT_DIR", agentDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		rmSync(scratch, { recursive: true, force: true });
	});

	const makeLoader = () =>
		new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			extensionFactories: [],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

	it("resolves once for two loaders with the same inputs", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await makeLoader().reload();
		await makeLoader().reload();

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it("resolves again once the settings change", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await makeLoader().reload();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@example/x"] }));
		await makeLoader().reload();

		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("re-resolves on a re-load of the same loader, and a later fresh loader sees that result", async () => {
		// A package's own manifest is not part of the key, so the re-load signal has
		// to carry disk changes through the memo. This is the hole CI found.
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
		const loader = makeLoader();

		await loader.reload();
		await loader.reload();
		const afterReload = resolve.mock.calls.length;
		await makeLoader().reload();

		expect(afterReload).toBe(2);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it("resolves once through the project-trust path too", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");
		const reloadOptions = { resolveProjectTrust: () => Promise.resolve(true) };

		await makeLoader().reload(reloadOptions);
		const afterFirst = resolve.mock.calls.length;
		await makeLoader().reload(reloadOptions);

		expect(afterFirst).toBeGreaterThan(0);
		expect(resolve).toHaveBeenCalledTimes(afterFirst);
	});

	it("shares one in-flight resolution across concurrent loaders", async () => {
		const resolve = vi.spyOn(DefaultPackageManager.prototype, "resolve");

		await Promise.all([makeLoader().reload(), makeLoader().reload(), makeLoader().reload()]);

		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
