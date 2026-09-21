# changes

## 2026-09-21 - Migrate the test runner to Vitest 5 (senpi#1895)

### What changed

- `packages/chord/package.json`: Updated the test runner to Vitest 5.0.1.

### Why

- Run this workspace on the pinned Vitest 5 release.

### Why an extension could not handle it

- The package manager resolves development tools before extensions load.

### Expected merge conflict zones

- The development dependency pins in `packages/chord/package.json`.
