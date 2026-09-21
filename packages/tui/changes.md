# changes

## 2026-09-21 - Refresh the renderer dependency pins (senpi#1895)

### What changed

- `packages/tui/package.json`: `marked` 18.0.11 -> 18.0.13 and `get-east-asian-width` 1.6.0 -> 1.7.0.

### Why

- Both are fork-owned exact pins shared with `packages/coding-agent`, and the renderer's wide-glyph measurement has to agree with the CLI's, so the two sites move together to the newest release in the same minor that satisfies `min-release-age=2`.

### Why an extension could not handle it

- Manifest dependency versions are resolved by the package manager before any extension loads.

### Expected merge conflict zones

- LOW: the dependency version block, on every upstream release bump.

## 2026-09-14 - tmux short-frame cursor source (#1645)

### What changed

- `packages/tui/src/terminal.ts` uses the extracted `packages/tui/src/tmux-cursor-query.ts` source for TMUX_PANE, with two stable CLI readings and a 750 ms total deadline. Tests inject the existing TmuxExecFile contract.

### Why

- tmux swallows private DECXCPR; regular-mode short frames need a pane-relative out-of-band anchor without bare CPR.

### Why an extension could not handle it

- Cursor queries and frame calibration are terminal-owned. The exact nearest source tracker also records the implementation.

### Expected merge conflict zones

- `packages/tui/src/terminal.ts` cursor broker and options. No renderer or default setting changes.

## 2026-09-10 - Use native TypeScript builds for omob performance

### What changed

- packages/tui/package.json: build uses tsgo for the emitted workspace build.

### Why

- The native compiler reduces omob build time without changing runtime JavaScript.

### Why this lives in the fork

- The package build manifest owns the compiler used by the fork's release pipeline.

### Expected merge conflict zones

- The `build` script in packages/tui/package.json.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/tui/package.json`: fork CalVer `2026.9.12`, `private: true`, Node `>=24.0.0`, `@xterm/headless 6.0.0`, the `test` script importing `tsx` and `./test/setup-multiplexer-env.mjs`, and a `bench:frame-cost` script; upstream's Linux native `files` globs were adopted.

### Why

- The fork's TUI tests need the multiplexer env setup and tsx loader, and the package rides the CalVer lockstep.

### Why an extension could not handle it

- Package scripts and versions are not runtime code.

### Expected merge conflict zones

- LOW: `scripts.test`, `version`, `engines` and `devDependencies` lines.
