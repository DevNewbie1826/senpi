// Grok 4.7 system prompt.
//
// Grok 4.7 has not been prompt-tuned in this fork. Until it is, it reuses the
// Grok 4.6 prompt VERBATIM by delegating to that builder, so the two presets
// can never drift apart. Split this into its own tuning only when a Grok 4.7
// prompting guide exists; until then any wording difference is a defect.
import type { BuildDynamicSystemPromptOptions } from "../../../dynamic-prompt/build.ts";
import { buildGrok46Prompt } from "./grok-4.6.ts";

export function buildGrok47Prompt(options: BuildDynamicSystemPromptOptions): string {
	return buildGrok46Prompt(options);
}
