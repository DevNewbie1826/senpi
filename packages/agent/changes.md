# changes

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/agent/package.json`: Updated the test runner to Vitest 5.0.1 and V8 coverage to @vitest/coverage-v8 5.0.1.
- `packages/agent/benchmark/session/benchmark.ts`: Register session timing benchmarks through the Vitest 5 test-context fixture and pass the existing iteration and warmup settings to `bench.run`.
- `packages/agent/vitest.benchmark.config.ts`: Move the benchmark reporter to the top-level test reporter setting.

### Why

- Run this workspace on the pinned Vitest 5 release.
- `packages/agent/benchmark/session/benchmark.ts` and `packages/agent/vitest.benchmark.config.ts` use APIs removed by Vitest 5; migrating them keeps the optional session timing command usable.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.
- `packages/agent/benchmark/session/benchmark.ts` and `packages/agent/vitest.benchmark.config.ts` are consumed by the test runner, not by runtime extensions.

### Expected merge conflict zones

- The development dependency pins in `packages/agent/package.json`.
- Benchmark registration in `packages/agent/benchmark/session/benchmark.ts` and reporter configuration in `packages/agent/vitest.benchmark.config.ts`.

## 2026-09-21 - Refresh the agent dependency pins (senpi#1895)

### What changed

- `packages/agent/package.json`: `typebox` 1.3.27 -> 1.3.34, `ignore` 7.0.8 -> 7.0.9, `yaml` 2.9.0 -> 2.9.1 and `@types/node` 26.2.0 -> 26.6.2.

### Why

- These are the fork's own exact pins, refreshed to the newest release in the same minor that satisfies the repository's `min-release-age=2` window. Upstream carries different ranges, so the versions have to be re-asserted here.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## 2026-09-16 - Ship the tree-sitter grammar assets with the package (senpi#1685)

### What changed

- `packages/agent/assets/tree-sitter/javascript.wasm` and `packages/agent/assets/tree-sitter/web-tree-sitter.wasm`: the vendored grammar and runtime artifacts the structural read engine loads, recorded with their upstream package, version, license and SHA-256 in `packages/agent/assets/tree-sitter/provenance.json`.
- `packages/agent/package.json`: adds the pinned `web-tree-sitter` runtime dependency, the pinned `@vscode/tree-sitter-wasm` measurement dependency, and `assets` to the published files.
- `packages/agent/tsconfig.build.json`: includes `src/**/*.d.ts` so the packaged asset module declaration is part of the build program.

### Why

- Only a language the frozen selection binds to `wasm` loads a grammar, and that grammar has to exist in both the npm package and the compiled binary. Vendoring exactly the shipped artifacts keeps the binary delta to the measured 0.6 MB instead of installing every grammar the upstream package carries, and the provenance file is what `scripts/prepare-bun-compile-assets.mjs` verifies before a compile.

### Why an extension could not handle it

- Package files and dependencies are resolved before any extension loads; an extension cannot add an artifact to the published tarball or to a compiled binary.

### Expected merge conflict zones

- LOW: the dependency and files lists in `packages/agent/package.json`.

## 2026-09-12 - Pin the chord dependency to upstream's published version

### What changed

- packages/agent/package.json: `@earendil-works/chord` is pinned to the exact upstream `0.85.1` it resolves to, instead of a fork CalVer range.

### Why

- chord is bundled but kept on upstream's own release identity (issue #1632): the fork does not publish it, so a CalVer range was unresolvable on the registry and broke `bun add @code-yeongyu/senpi`. Pinning the exact published `0.85.1` keeps the declared edge resolvable while the bundled copy shadows it at runtime.

### Why an extension could not handle it

- packages/agent/package.json is static manifest data consumed by the package manager and the release/publish pipeline, never reachable from the runtime extension system.

### Expected merge conflict zones

- The `@earendil-works/chord` dependency range in packages/agent/package.json.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/agent/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/agent/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/agent/package.json`: keeps the fork CalVer version `2026.9.12` and `^2026.9.12` ranges for `@earendil-works/chord`, `@earendil-works/pi-ai` and `@earendil-works/pi-telemetry`, the Node `>=24.0.0` floor, `diff 9.0.0`, `@types/node 26.2.0`, `typescript 7.0.2`, `vitest`/`@vitest/coverage-v8 4.1.11` and `private: true`; upstream's new Chord runtime dependency and bench scripts were adopted.

### Why

- Every `@earendil-works/pi-*` workspace rides the fork's CalVer lockstep so the install lock can treat them as internal packages, and the fork's held tool pins must stay single-instanced across manifests.

### Why an extension could not handle it

- Package version and dependency ranges are resolved by the package manager before any code runs.

### Expected merge conflict zones

- LOW: `version`, `dependencies` and `devDependencies` lines on every upstream release bump.
