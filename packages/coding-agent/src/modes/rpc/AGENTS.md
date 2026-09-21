# packages/coding-agent/src/modes/rpc

JSONL-over-stdio RPC mode for driving Senpi sessions programmatically (TUI-less). One UTF-8 JSON object per LF-delimited line; requests in, events out. The public protocol reference is `packages/coding-agent/docs/rpc.md`.

## STRUCTURE

```text
rpc-mode.ts               Mode entry: session binding, main loop
connection-handler.ts     Connection lifecycle; owns the command-digest baseline,
                          get_commands responses, commands_changed emission
jsonl.ts                  Strict LF framing; MAX_RPC_LINE_CHARACTERS (16 MiB)
                          ceiling with oversized-record resynchronization
rpc-input-validation.ts   Inbound bounds: MAX_RPC_MESSAGE_CHARACTERS (1,000,000)
rpc-command-surface.ts    RpcSlashCommand snapshot, digest, baseline comparison
rpc-command-invocation.ts command_invocation / skill_invocation event types
multi-session-host.ts     Multi-session RPC host; selects the session runtime
session-registry.ts       IN-PROCESS runtime (default for `--listen`): every session on the
                          host loop, NO session cap of any kind
worker-session-registry.ts WORKER runtime (stdio hosts, embedders): one isolate per session,
                          20-worker capacity, the ONLY source of `too_many_sessions`
session-binding.ts, session-command-router.ts,
session-event-writer.ts, session-event-fanout.ts,
session-extension-ui-requests.ts                            Session wiring
session-attribution.ts    AsyncLocalStorage {sessionId, tool} the stall watchdog blames by
loop-lag-watchdog.ts      200 ms drift probe -> stderr line + `host_stalled` record
host-memory-sampler.ts    30 s RSS sampler -> `host_memory_pressure`; halves the idle window
child-reaper.ts           Reaps exited children no live thread is left to wait on
host-ensure.ts            ensureHost(): probe, decide, spawn through the lifecycle supervisor
host-decision.ts          decideHostAction(): start|reuse|handoff|refuse|fallback (I1, I2)
host-protocol-info.ts     get_protocol_info boundary parse (identity, ordinal, launch profile)
host-handoff.ts, host-successor.ts, host-stop.ts, host-probe.ts, host-launch.ts
                          Generation handoff: bring the successor up, drain the predecessor
host-daemon-paths.ts, host-daemon-state.ts, host-daemon-registration.ts
                          Per-socket daemon directory, pointer pidfile, generations (I3)
host-launch-spec.ts       `--launch-spec` parse + trust proof; host-daemon-env.ts = env allowlist
host-runner.ts            The four `senpi host` requests -> { payload, exitCode }
host-status.ts, host-process-metrics.ts   status report: identity, sessions, generations, tree
host-lifecycle.ts, supervisor-route.ts    Supervisor that owns the public socket + idle exit
rpc-client.ts, rpc-types.ts, custom-capability.ts, event-output-buffer.ts
changes.md                Fork-specific RPC behavior record
```

## COMMAND-SURFACE LIFECYCLE

- On bind/rebind, `connection-handler.ts` builds the ordered `RpcSlashCommand` snapshot and digests it (`rpc-command-surface.ts`).
- The baseline digest starts `undefined`: the first snapshot is recorded WITHOUT emitting `commands_changed`. That baseline suppression is intentional (it removed the initial client-refresh feedback loop) — do not "fix" it into an emission.
- `commands_changed` fires only when a later snapshot differs (extension reload, rebind, config change); clients refetch via `get_commands`.
- `command_invocation` / `skill_invocation` are additive typed metadata on prompt events; they do not replace `loaded_surfaces_changed` / `get_loaded_surfaces`.
- Skill expansion (`$name`, `$skill:name`) happens in prompt preprocessing and must not reset or reorder MCP loaded surfaces.

## INVARIANTS

- Framing is strict LF. Records over `MAX_RPC_LINE_CHARACTERS` are dropped with resynchronization rather than killing the stream; preserve that recovery behavior.
- Inbound messages over `MAX_RPC_MESSAGE_CHARACTERS` are rejected with a typed error; non-object JSON is rejected.
- Pending work is rejected on disconnect or child exit; preserve request/response correlation.
- Child stderr is emitted and embedded raw; treat diagnostics as secret-bearing.

### Shared-daemon invariants (I1-I4)

One machine-wide host holds every client's sessions, so these hold for every surface that touches it - CLI, desktop, task runner:

- **I1** — never terminate, signal or replace a host this process did not start. A mismatch ends in `refuse`, never in a second host bound over somebody else's endpoint. The only carve-outs are `stopHost` against a validated own-writer pidfile with zero foreign attached/retained sessions (or explicit `force`), and a drain, which ends no work.
- **I2** — compatibility is `protocolVersion` + capabilities, never a version-string comparison. An uncomparable `engineOrdinal` is EQUAL, and a handoff needs STRICTLY greater, so an unknown-age build attaches instead of upgrading.
- **I3** — only the owning generation writes its daemon state; everyone else reads. Clients fail CLOSED (report, or start their own private host) and never edit, unlink or delete a shared host's files, socket or pidfile. Layout 2 deliberately writes no flat `host.pid`, which is what makes pre-layout-2 clients fail closed instead of taking the daemon over.
- **I4** — worker sessions are invisible by default: `kind: "worker"` rows need `include_workers: true`, `context` is published on that listing only, and their `session_closed`/`session_parked` records go to attached connections only.

### The no-sync rule

- The in-process runtime puts every session on ONE loop: a synchronous wait taken on the session path is an outage for every client. `execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`, `Bun.sleepSync` and `Atomics.wait` are banned on that call graph; `test/suite/no-sync-in-session-path.test.ts` fails on any call site the checked-in ledger does not already record, and reports sync fs against the same ledger.
- The in-process path has NO session cap. If a change makes the shared daemon refuse an `open_session` for occupancy, it is a defect, not a policy - `too_many_sessions` belongs to `worker-session-registry.ts` alone. The ONE memory-driven refusal is `host_memory_pressure` (senpi#1905): above `SENPI_RPC_HOST_RSS_REFUSE_MB` the registry declines to CREATE a `kind: "worker"` session and nothing else - attaches, interactive opens and existing sessions are served. It keys on RSS, never on a count.
- The socket dead-peer budget counts loop-SERVED time (`loop-blocked-time.ts`): a host stall must never cut a live peer. A session's provider scope closes only after its disposal settles (`session-teardown.ts`), and a config-reload callback bound to a closed scope is a no-op (`session-scoped-callback.ts`).
- Capacity is memory and threads: roughly 1 thread / 2 fds / 5-8 MB per open session, the thread coming from the `config-reload` builtin's per-session watch Worker (senpi#1794). Never claim it is flat.

## WHERE TO LOOK

| Task | File |
|---|---|
| Add/change a command-surface event | `rpc-command-surface.ts`, `connection-handler.ts` |
| Change framing or input bounds | `jsonl.ts`, `rpc-input-validation.ts` |
| Invocation metadata on prompts | `rpc-command-invocation.ts` |
| Session wiring / multi-session | `session-*.ts`, `multi-session-host.ts` |
| Daemon ensure/attach/refuse decision | `host-decision.ts`, `host-ensure.ts` |
| Generation handoff, drain, stop | `host-handoff.ts`, `host-successor.ts`, `host-stop.ts` |
| Daemon state directory + generations | `host-daemon-paths.ts`, `host-daemon-registration.ts` |
| `senpi host` behaviour / exit codes | `host-runner.ts`, `../../cli/host-command.ts` |
| Stall or memory reporting | `loop-lag-watchdog.ts`, `session-attribution.ts`, `host-memory-sampler.ts` |
| Protocol documentation | `packages/coding-agent/docs/rpc.md` |

## VALIDATION

- Focused tests live in `packages/coding-agent/test/rpc-*.test.ts` (rpc-jsonl, rpc-input-validation, rpc-command-invocation, rpc-commands-changed, rpc-multi-session-input, rpc-loaded-surfaces, rpc-classic-compat, rpc-prompt-response-semantics).
- Daemon suites: `test/suite/host-cli*.test.ts`, `test/rpc-host-ensure.test.ts`, `test/rpc-host-handoff.test.ts`, `test/suite/no-sync-in-session-path.test.ts`, `test/suite/rpc-inprocess-host*.test.ts`, `test/suite/rpc-session-context.test.ts`, `test/suite/rpc-retain-on-disconnect.test.ts`, `test/suite/rpc-loop-lag-watchdog.test.ts`, `test/suite/rpc-host-reaper.test.ts`, `test/suite/rpc-worker-capacity.test.ts`. Suites that spawn a host use `test/helpers/spawned-host-reaper.ts`; after any run `pgrep -f rpc-host-fixture.mjs | wc -l` must print 0.
- End-to-end scenarios: `.agents/skills/senpi-qa/scripts/scenarios/dollar-skill-invocation-qa.mjs` and `rpc-input-hardening-qa.mjs`.
- Live daemon QA (POSIX, sandbox agent dir, one JSON line per step, cleanup receipt last): `scripts/qa-rpc-socket/inprocess-daemon-qa.mjs` (two compiled generations end to end) and `scripts/qa-rpc-socket/generation-handoff.mjs` (the handoff alone).
- Behavior changes update `changes.md` here and `docs/rpc.md` in the same increment.
- Runtime changes require root `bun run check` and real CLI QA evidence.

---
Generated: 2026-08-17 | Commit `abae968e8` | Updated: 2026-09-18 (shared daemon, `senpi host`, I1-I4)
