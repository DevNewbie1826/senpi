import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverEnvSlots, primaryEnvVar } from "../src/core/credential-pool/env-slots.ts";
import { ModelConfig } from "../src/core/model-config.ts";

// Read boundaries (e) and (i) of senpi#1989.
const dirs: string[] = [];
function modelsJson(body: unknown): string {
	const d = mkdtempSync(join(tmpdir(), "t8-models-"));
	dirs.push(d);
	const p = join(d, "models.json");
	writeFileSync(p, JSON.stringify(body, null, 2));
	return p;
}
const overlay = (baseUrl: string) => ({ baseUrl, models: [] });
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("read boundary (e): models.json overlay keys (senpi#1989)", () => {
	it("attaches an overlay written under the legacy provider id to the canonical id", () => {
		const cfg = ModelConfig.loadSync(modelsJson({ providers: { "claude-sdk-oauth": overlay("https://legacy") } }));
		expect(cfg.getProvider("anthropic-subscription")).toMatchObject({ baseUrl: "https://legacy" });
		expect(cfg.getError()).toBeUndefined(); // never hard-errors
	});

	it("emits ONE warning naming the rename, and none when the file is already canonical", () => {
		const legacy = ModelConfig.loadSync(
			modelsJson({ providers: { "claude-sdk-oauth": overlay("https://a"), "openai-codex": overlay("https://b") } }),
		);
		expect(legacy.getWarnings()).toHaveLength(1);
		expect(legacy.getWarnings()[0]).toContain("claude-sdk-oauth -> anthropic-subscription");
		expect(legacy.getWarnings()[0]).toContain("openai-codex -> chatgpt-subscription");

		const canonical = ModelConfig.loadSync(
			modelsJson({ providers: { "anthropic-subscription": overlay("https://a") } }),
		);
		expect(canonical.getWarnings()).toHaveLength(0);
	});

	it("lets an explicit canonical entry win over a legacy one", () => {
		const cfg = ModelConfig.loadSync(
			modelsJson({
				providers: {
					"anthropic-subscription": overlay("https://canonical"),
					"claude-sdk-oauth": overlay("https://legacy"),
				},
			}),
		);
		expect(cfg.getProvider("anthropic-subscription")).toMatchObject({ baseUrl: "https://canonical" });
	});

	it("normalizes disabledProviders written with a legacy id", () => {
		const cfg = ModelConfig.loadSync(modelsJson({ providers: {}, disabledProviders: ["claude-sdk-oauth"] }));
		expect(cfg.isProviderDisabled("anthropic-subscription")).toBe(true);
	});

	it("leaves an untouched provider's overlay exactly where it was", () => {
		const cfg = ModelConfig.loadSync(modelsJson({ providers: { anthropic: overlay("https://api-key-lane") } }));
		expect(cfg.getProvider("anthropic")).toMatchObject({ baseUrl: "https://api-key-lane" });
		expect(cfg.getWarnings()).toHaveLength(0);
	});
});

describe("read boundary (i): credential-pool env slots (senpi#1989)", () => {
	it("maps the legacy provider id to the frozen CLAUDE_CODE_OAUTH_TOKEN env var", () => {
		expect(primaryEnvVar("claude-sdk-oauth")).toBe("CLAUDE_CODE_OAUTH_TOKEN");
		expect(primaryEnvVar("anthropic-subscription")).toBe("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("discovers an env slot for a caller still passing the legacy id", () => {
		const env = (name: string) => (name === "CLAUDE_CODE_OAUTH_TOKEN" ? "tok" : undefined);
		expect(discoverEnvSlots("claude-sdk-oauth", env)).toHaveLength(1);
		expect(discoverEnvSlots("anthropic-subscription", env)).toHaveLength(1);
	});
});
