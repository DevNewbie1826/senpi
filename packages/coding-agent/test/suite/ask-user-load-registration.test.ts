import { afterEach, expect, it } from "vitest";
import askUserExtension from "../../src/core/extensions/builtin/ask-user/index.ts";
import { renderCall } from "../../src/core/extensions/builtin/ask-user/render.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

// #1857: streaming renders can happen before session_start during reload.
it("resolves both tool renderers at extension load before any session_start", async () => {
	const harness = await createHarness({ extensionFactories: [{ factory: askUserExtension }] });
	harnesses.push(harness);
	for (const name of ["ask_user_question", "request_user_input"]) {
		expect(harness.session.getToolDefinition(name)?.renderCall).toBe(renderCall);
	}
});

it("resolves both tool renderers after registry rebuild before reload session_start", async () => {
	const delivery = await createAskUserDelivery();
	harnesses.push(delivery.harness);
	const context = delivery.context(() => new Promise(() => {}));
	await delivery.harness.session.bindExtensions({ uiContext: context.ui, mode: "tui" });
	let checked = false;
	await delivery.harness.session.reload({
		beforeSessionStart: () => {
			checked = true;
			for (const name of ["ask_user_question", "request_user_input"]) {
				expect(delivery.harness.session.getToolDefinition(name)?.renderCall).toBe(renderCall);
			}
		},
	});
	expect(checked).toBe(true);
});
