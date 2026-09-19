/**
 * Host-scoped memo for package resolution.
 *
 * A shared host opens many sessions in one agent dir, and every open ran the
 * same package discovery: ~68 ms of loop CPU per open on the daemon, repeated
 * N-way for N concurrent opens (senpi#1844). The product depends only on the
 * agent dir, the cwd, the settings content and the CLI-supplied extension
 * sources - never on the session - so it is memoized on exactly those inputs.
 *
 * The memo stores the PROMISE, not the value: N concurrent opens with one key
 * await a single resolution instead of racing N of them. Invalidation is by
 * key - settings are reloaded before the key is computed, so a change yields
 * a new key and the stale entry ages out of the LRU.
 */

const MAX_ENTRIES = 16;
const memo = new Map<string, Promise<unknown>>();

export interface ResolvedPathsMemoKeyInput {
	readonly agentDir: string;
	readonly cwd: string;
	readonly globalSettings: unknown;
	readonly projectSettings: unknown;
	readonly additionalExtensionPaths: readonly string[];
}

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export function resolvedPathsMemoKey(input: ResolvedPathsMemoKeyInput): string {
	return stable(input);
}

export function memoizeResolvedPaths<T>(key: string, compute: () => Promise<T>): Promise<T> {
	const existing = memo.get(key);
	if (existing !== undefined) {
		memo.delete(key);
		memo.set(key, existing);
		return existing as Promise<T>;
	}
	if (memo.size >= MAX_ENTRIES) {
		const oldest = memo.keys().next().value;
		if (oldest !== undefined) memo.delete(oldest);
	}
	const pending = compute().catch((error: unknown) => {
		if (memo.get(key) === pending) memo.delete(key);
		throw error;
	});
	memo.set(key, pending);
	return pending;
}

export function clearResolvedPathsMemo(): void {
	memo.clear();
}
