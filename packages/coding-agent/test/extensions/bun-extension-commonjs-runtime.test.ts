import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

// CommonJS runtime semantics the extension graph must honor for real dependency graphs
// (jsdom, whatwg-url, cssom): `require.resolve`, and the partially built exports a module in
// a require cycle hands back while it is still evaluating.

const importerPath = fileURLToPath(new URL("../../src/core/extensions/bun-extension-importer.ts", import.meta.url));
const roots: string[] = [];

function fixture(source: string): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-extension-cjs-"));
	roots.push(root);
	writeFileSync(join(root, "extension.ts"), source);
	return root;
}

function commonJsPackage(root: string, name: string, files: Readonly<Record<string, string>>): string {
	const directory = join(root, "node_modules", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name, main: "index.js" }));
	for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, file), source);
	return directory;
}

function run(root: string, scenario: string): void {
	execFileSync(
		"bun",
		[
			"--eval",
			`
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createBunExtensionImporter } from ${JSON.stringify(importerPath)};
const root = ${JSON.stringify(root)};
const entry = join(root, "extension.ts");
${scenario}
`,
		],
		{ cwd: root, encoding: "utf8", timeout: 15_000 },
	);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CommonJS runtime semantics in the extension graph", () => {
	it("resolves require.resolve to the dependency file's absolute path (#1838)", () => {
		// Given: a dependency that locates a sibling worker file the way jsdom's XMLHttpRequest does.
		const root = fixture('import lib from "cjs-lib"; export default () => lib.worker;');
		const directory = commonJsPackage(root, "cjs-lib", {
			"index.js": 'module.exports = { worker: require.resolve("./worker.js") };',
			"worker.js": "module.exports = null;",
		});
		// When / Then: the path is the real absolute file path, as Node's require.resolve returns.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), realpathSync(join(${JSON.stringify(directory)}, "worker.js")));
`,
		);
	});

	it("hands a module in a require cycle the partially built exports of the module still evaluating (#1838)", () => {
		// Given: a mutual require, as @acemir/cssom's CSSStyleRule <-> CSSStyleDeclaration ships.
		const root = fixture('import lib from "cjs-lib"; export default () => [lib.fromA, lib.seenByB, lib.same];');
		commonJsPackage(root, "cjs-lib", {
			"index.js":
				'exports.fromA = "a";\nconst b = require("./b.js");\nexports.seenByB = b.sawFromA;\nexports.same = require("./b.js") === b;',
			"b.js": 'const a = require("./index.js");\nexports.sawFromA = a.fromA;',
		});
		// When / Then: b sees a's partial exports, and a second require returns the cached module.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), ["a", "a", true]);
`,
		);
	});

	it("re-throws from a CommonJS module that failed to evaluate instead of caching its partial exports", () => {
		// Given: a dependency whose evaluation throws after it has started filling exports.
		const root = fixture('import lib from "cjs-lib"; export default () => lib;');
		commonJsPackage(root, "cjs-lib", {
			"index.js": [
				"const outcomes = [];",
				'for (const attempt of [1, 2]) { try { outcomes.push(require("./boom.js")); } catch (error) { outcomes.push(error.message); } }',
				"module.exports = outcomes;",
			].join("\n"),
			"boom.js": 'exports.partial = "set"; throw new Error("boom");',
		});
		// When / Then: every require of the failed module throws, as Node evicts a module that failed to load.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.deepEqual(factory(), ["boom", "boom"]);
`,
		);
	});

	it("keeps a .mjs file with top-level await and no import or export on the ESM path", () => {
		// Given: an ES module by extension whose only module-level syntax is await.
		const root = fixture('import "./side.mjs"; export default () => globalThis.__senpiSideEffect;');
		writeFileSync(join(root, "side.mjs"), "globalThis.__senpiSideEffect = await Promise.resolve(41);");
		// When / Then: it evaluates as a module instead of failing to parse inside a CommonJS wrapper.
		run(
			root,
			`
const importer = await createBunExtensionImporter({});
const factory = await importer.import(entry, { default: true });
assert.equal(factory(), 41);
`,
		);
	});
});
