import { mkdirSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import mcpExtension from "../../src/core/extensions/builtin/mcp/index.ts";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { MCP_STARTUP_TIMEOUT_ENV } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../suite/harness.ts";
import { cleanupRoots, makeRoot, setConfig, stdioServer, type TestRoot } from "./fixtures/service-lifecycle.ts";

interface CapturedTurn {
	readonly systemPrompt: string;
	readonly connectionState: string | undefined;
	readonly toolNames: readonly string[];
}

const cleanupTasks: Array<() => Promise<void>> = [];
const harnesses: Harness[] = [];
const originalAgentDir = process.env[ENV_AGENT_DIR];
const originalStartupTimeout = process.env[MCP_STARTUP_TIMEOUT_ENV];

beforeEach(() => {
	resetMcpServiceForTests();
	// A zero startup window is the production knob for "never let a connect gate
	// the first frame": every attach connect is backgrounded immediately, which
	// is what a loaded CI runner produces by missing the 250ms default race.
	process.env[MCP_STARTUP_TIMEOUT_ENV] = "0";
});

afterEach(async () => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	restoreEnv(ENV_AGENT_DIR, originalAgentDir);
	restoreEnv(MCP_STARTUP_TIMEOUT_ENV, originalStartupTimeout);
	await cleanupRoots(cleanupTasks);
});

describe("MCP deferred attach vs. system prompt assembly", () => {
	it("carries a deferred server's instructions into the first turn's system prompt", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("instructions");

		// When: the new session builds its first system prompt.
		const turn = await startSessionAndCaptureTurn(root);

		// Then: that prompt carries the server's current instructions.
		expect(instructionsFor(turn.systemPrompt, "fx")).toBe("deferred instructions");
	});

	it("registers the deferred server's tools before the first turn's payload", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("tools");

		// When: the new session sends its first turn.
		const turn = await startSessionAndCaptureTurn(root);

		// Then: the payload already carries that server's tool catalog.
		expect(turn.toolNames).toContain("mcp_fx_tool_1");
	});

	it("leaves the server connected by the time the first turn goes out", async () => {
		// Given: a server whose attach connect is deferred past session_start.
		const root = deferredAttachRoot("state");

		// When: the new session sends its first turn.
		const turn = await startSessionAndCaptureTurn(root);

		// Then: the prompt build observed the attach instead of assuming it.
		expect(turn.connectionState).toBe("connected");
	});
});

function deferredAttachRoot(slug: string): TestRoot {
	const root = makeRoot(`attach-prompt-${slug}`, cleanupTasks);
	process.env[ENV_AGENT_DIR] = root.agentDir;
	mkdirSync(root.agentDir, { recursive: true });
	setConfig(root, { fx: stdioServer(["--tools", "1", "--instructions", "deferred instructions"]) });
	return root;
}

/**
 * Drive the production ordering: session_start dispatches the attach and
 * returns without waiting for it, then the first turn builds the system prompt.
 * Nothing here awaits the attach on the prompt's behalf - that is the contract
 * under test.
 */
async function startSessionAndCaptureTurn(root: TestRoot): Promise<CapturedTurn> {
	process.env[ENV_AGENT_DIR] = root.agentDir;
	const harness = await createHarness({ extensionFactories: [mcpExtension as ExtensionFactory] });
	harnesses.push(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	let captured: CapturedTurn = { systemPrompt: "", connectionState: undefined, toolNames: [] };
	harness.setResponses([
		(context) => {
			captured = {
				systemPrompt: context.systemPrompt ?? "",
				connectionState: getMcpService().getConnection("fx")?.state,
				toolNames: (context.tools ?? []).map((tool) => tool.name),
			};
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt("capture prompt");
	return captured;
}

function instructionsFor(systemPrompt: string, server: string): string | null {
	const match = new RegExp(`<mcp_instructions server="${server}">\\n([\\s\\S]*?)\\n</mcp_instructions>`).exec(
		systemPrompt,
	);
	return match?.[1] ?? null;
}

function restoreEnv(name: string, original: string | undefined): void {
	if (original === undefined) delete process.env[name];
	else process.env[name] = original;
}
