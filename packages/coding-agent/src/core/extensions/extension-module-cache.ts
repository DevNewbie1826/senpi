/**
 * Process-wide cache for compiled extension module graphs.
 *
 * A module registry has no eviction API, so every extension source evaluated under a fresh
 * importer generation stays resident for the life of the process. A daemon that loads extensions
 * per session therefore pays that cost per session forever (senpi#1948). The graph is a pure
 * function of its source files, so this cache keeps ONE live generation and hands the same factory
 * to every later load whose sources are byte-for-byte unchanged; every load still runs the factory,
 * so sessions keep their own extension instances.
 *
 * Freshness is preserved by invalidation: a changed, added or removed source file drops the
 * generation, and the next load compiles a new one. An importer that cannot report the files it
 * compiled (the Node jiti path) is never cached, because its graph cannot be checked for staleness.
 *
 * @module core/extensions/extension-module-cache
 */

import { statSync } from "node:fs";

export type ExtensionModuleImporter = {
	import(path: string, options: { default: true }): Promise<unknown>;
	/** Source files this importer compiled; absent on importers that cannot report them. */
	compiledFiles?: () => readonly string[];
	dispose?: () => void;
};

export type ExtensionModuleImporterFactory = () => Promise<ExtensionModuleImporter>;

type CachedFactory = (...args: never[]) => unknown;

interface Generation {
	readonly importer: ExtensionModuleImporter;
	readonly factories: Map<string, CachedFactory>;
	readonly fingerprints: Map<string, string>;
}

let generation: Generation | undefined;
let pendingImporter: Promise<ExtensionModuleImporter> | undefined;
let generationsCreated = 0;

function fingerprintOf(file: string): string | undefined {
	try {
		const stats = statSync(file, { bigint: true });
		return `${stats.mtimeNs}:${stats.size}`;
	} catch {
		return undefined;
	}
}

/** Stale means a file this generation already compiled changed or disappeared. */
function sourcesUnchanged(live: Generation): boolean {
	for (const [file, fingerprint] of live.fingerprints) {
		if (fingerprintOf(file) !== fingerprint) return false;
	}
	return true;
}

function dropGeneration(): void {
	generation?.importer.dispose?.();
	generation = undefined;
	pendingImporter = undefined;
}

/**
 * The compiled set GROWS during normal use - extensions import lazily long after their factory was
 * built - so newly seen files join the fingerprint instead of counting as a change.
 */
function absorbNewlyCompiled(live: Generation): void {
	for (const file of live.importer.compiledFiles?.() ?? []) {
		if (live.fingerprints.has(file)) continue;
		const fingerprint = fingerprintOf(file);
		if (fingerprint !== undefined) live.fingerprints.set(file, fingerprint);
	}
}

/**
 * The cached factory for this source, or `undefined` when it must be compiled.
 *
 * A source change invalidates the whole generation: its modules already reference each other, so
 * one stale file makes every factory in that generation suspect.
 */
export function cachedExtensionFactory(resolvedPath: string): CachedFactory | undefined {
	if (!generation) return undefined;
	if (!sourcesUnchanged(generation)) {
		dropGeneration();
		return undefined;
	}
	absorbNewlyCompiled(generation);
	return generation.factories.get(resolvedPath);
}

/** The live importer, created on demand. Callers share one generation until it is invalidated. */
export async function extensionModuleImporter(
	create: ExtensionModuleImporterFactory,
): Promise<ExtensionModuleImporter> {
	if (generation) return generation.importer;
	pendingImporter ??= create().then((importer) => {
		generation = { importer, factories: new Map(), fingerprints: new Map() };
		generationsCreated++;
		pendingImporter = undefined;
		return importer;
	});
	return pendingImporter;
}

/** Remember a freshly compiled factory and re-read the generation's source fingerprints. */
export function rememberExtensionFactory(resolvedPath: string, factory: CachedFactory): void {
	if (!generation || generation.importer.compiledFiles === undefined) return;
	generation.factories.set(resolvedPath, factory);
	absorbNewlyCompiled(generation);
}

export function clearExtensionCache(): void {
	dropGeneration();
}

/** Test seam: how many module generations this process has compiled. */
export function extensionModuleGenerationCount(): number {
	return generationsCreated;
}
