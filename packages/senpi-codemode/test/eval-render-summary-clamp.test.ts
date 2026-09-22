import { describe, expect, it } from "vitest";
import { clampEvalSummary } from "../src/tool/eval-request.ts";
import { renderEvalCall } from "../src/tool/render.ts";
import { EVAL_SUMMARY_MAX_LENGTH } from "../src/tool/types.ts";
import { callContext, renderLines } from "./eval-render-fixtures.ts";

const OVER_LIMIT_SUMMARY = "s".repeat(EVAL_SUMMARY_MAX_LENGTH + 12);

describe("eval call summary display limit", () => {
	it("truncates an over-limit summary the assistant message still carries in full", () => {
		// Given (senpi#1472: preparation no longer clamps the message, so the renderer must)
		const givenArgs = {
			language: "js",
			code: "return 1",
			summary: OVER_LIMIT_SUMMARY,
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		// The rendered line is compared to the clamped VALUE, not to a length: the renderer also
		// width-truncates, so a length assertion alone passes even when the clamp is gone.
		expect(renderLines(component)[1]).toBe(clampEvalSummary(OVER_LIMIT_SUMMARY));
	});

	it("leaves a summary at the limit untouched", () => {
		// Given
		const atLimit = "s".repeat(EVAL_SUMMARY_MAX_LENGTH);
		const givenArgs = {
			language: "js",
			code: "return 1",
			summary: atLimit,
		} satisfies Parameters<typeof renderEvalCall>[0];

		// When
		const component = renderEvalCall(givenArgs, undefined, callContext());

		// Then
		expect(renderLines(component)[1]).toBe(atLimit);
	});
});
