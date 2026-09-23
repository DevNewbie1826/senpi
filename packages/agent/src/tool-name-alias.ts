/**
 * Some provider wire paths show the model non-native tools as
 * `mcp__<id>__<Name>` (recased, under a namespace senpi never defined), and a
 * model can carry that shape into a call for a tool it learned by its bare
 * name. Resolve such a call only when exactly one available tool matches after
 * stripping the namespace and folding case and `-`/`_` separators; never guess
 * between two candidates.
 */
const GATEWAY_TOOL_NAMESPACE = /^mcp__[^_]+__(.+)$/;

function foldToolName(name: string): string {
	return name.toLowerCase().replaceAll(/[-_]/g, "");
}

export function resolveToolNameAlias(requested: string, available: Iterable<string>): string | undefined {
	const names = [...new Set(available)];
	if (names.includes(requested)) return requested;
	const unnamespaced = GATEWAY_TOOL_NAMESPACE.exec(requested)?.[1] ?? requested;
	if (names.includes(unnamespaced)) return unnamespaced;
	const key = foldToolName(unnamespaced);
	const matches = names.filter((name) => foldToolName(name) === key);
	return matches.length === 1 ? matches[0] : undefined;
}

export function toolNameCorrectionNotice(requested: string, resolved: string): string {
	return `[auto-corrected] no tool is named "${requested}"; ran "${resolved}". Call tools by their exact listed name.`;
}
