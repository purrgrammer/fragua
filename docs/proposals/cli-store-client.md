---
title: CLI as a direct store-client — no HTTP, run enqueues, watch tails
summary: "Decomplect the CLI from HTTP: it opens the local SQLite directly, reads projections, and writes intents through the shared intent plane — no localhost round-trip. `fragua run` enqueues and exits 0 (recorded, not succeeded); tailing is the explicit `fragua watch`. Nail scriptability: stdout=data/stderr=chatter, --json⇒JSONL, a HaltReason exit-code taxonomy, TTY-only rendering. Removes --url; adds `fragua db migrate`."
status: shipped
maturity: sketch
last-reviewed: 2026-05-25
parent: cli-topology.md
---

# CLI as a direct store-client

> **Shipped.** The CLI opens the local store directly (`packages/cli/src/store-client.ts`,
> `withStoreClient`) and reads/writes through the two planes — no HTTP. The
> `migrate:false` open mode it stands on landed in `@fragua/store` (verify-and-refuse-to-bump);
> `run` enqueues + follows by default, the operate/schedule verbs are store-clients, and
> the `'web'→'client'` writer rename landed. Kept for the design record.
>
> Child of [`cli-topology.md`](cli-topology.md). Built on
> [`intent-plane.md`](intent-plane.md) (shipped) and the shared read plane.

## 1. Problem

`discoverHarnessUrl` (`run.ts:70`) already opens the local store and reads
`daemon_lock` — then makes a localhost HTTP round-trip back to the same machine
(`POST /workflows`, `POST /runs`, SSE stream). The HTTP hop buys nothing
co-located, and it makes `run` *fail* when no daemon answers (`run.ts` falls back
to `localhost:3000` and hard-errors the POST). A store-client never cares whether
a daemon is running: it writes a durable intent and returns.

## 2. Verbs

- **`fragua run <wf>`** — resolve the workflow file (bare names → `~/.fragua/
  workflows/` then `<cwd>/.fragua/workflows/`), then **two plane ops the command
  sequences** (intent-plane §3.1): `buildSaveWorkflow(source) → commit` (content-
  addressed `sha` into the `workflows` table) **then** `buildEnqueue → commit` by
  that sha. Print the run id to **stdout**, exit `0` = *recorded* (not succeeded).
  No daemon ⇒ *queued*, not failed. `--watch` is sugar for `run` + `watch`; the
  default never blocks.
- **`fragua watch <id>`** — tail the store via poll-on-seq (the exact mechanism
  `sse.ts` already uses), render, exit with the run's terminal status.
- **`steer` / `pause` / `cancel` / `respond`** — `plane.build(intent) →
  store.appendIntent`, return. Written while no daemon is up, they are folded on
  daemon restart (durable-pause-across-downtime for free).

## 3. Log scriptability

- **stdout = data, stderr = chatter.** Run id on stdout (so `id=$(fragua run wf)`
  works); "enqueued ✓" and progress on stderr. Today `run.ts` mixes them.
- **`--json` ⇒ JSONL.** Event payloads are already JSON; one raw event per line
  is the CI log *and* the importable artifact in one format. No bespoke "CI log
  format" — render the event log; the `.db` is lossless.
- **Exit-code taxonomy.** Today every halt → exit 1 (`run.ts:218`). Map
  `HaltReason` (`packages/types/src/events.ts` — `budget`, `error`,
  `aborted_exit`, `occ_exhausted`, `timeout_exhausted`, `route_not_picked`,
  `route_call_not_isolated`, `edge_no_match`) to distinct codes so pipelines
  branch — *retry* on `occ_exhausted`/`timeout_exhausted`. A version mismatch is
  no longer a halt: it is the recoverable `engine_incompatible` pause,
  so it shares the non-interactive-pause exit code (distinct from a fail:
  "couldn't run / needed a human"), not a halt code. **Enum-consumer note
  (CLAUDE.md §1):** the exit map is a new `HaltReason` *and* `PauseReason` literal
  consumer.
- **Rendering, not semantics, keys off the TTY.** `NO_COLOR` / `isTTY` / `CI`
  gate color and spinners only; enqueue-vs-tail behavior is mode-independent on
  purpose — "why did it behave differently in CI" is the scriptability bug we
  refuse to ship. None of these exist in the CLI today.

## 4. Decisions owned here

- **Remove `--url`** (cli-topology §5.1). Remote control is out of scope; revisit
  later. The CLI is co-located only.
- **`fragua db migrate` — explicit, consent-driven** (cli-topology §5.4).
  Migrations are already transactional + version-gated (`schema_version` single
  row, `migrate()` in a transaction), so two processes calling `migrate()`
  *serialize and idempotently no-op* — a race is **safe, not corrupting**. The
  reason to stop a store-client from auto-migrating is therefore *surprise*, not
  correctness. So:
  - `fragua db migrate` = explicit operator consent to mutate schema; `--dry-run`
    prints the plan (`vN → vM: [list]`); pairs with `db backup --to`.
  - Harness/daemon startup keeps auto-migrate (fact-writer, natural owner,
    zero-friction local upgrade) — same routine, under its lock.
  - Pure store-client verbs open *without* migrating; on `schema_version <
    binary` they error *"run `fragua db migrate` or start the harness"*; the
    inverse (CLI older than store) errors clearly too.
  - `fragua ci` opens a fresh store at the baseline version — no migration.
  - **Foundational dependency (adversarial finding):** the store constructor
    *always* calls `migrate(this.db)` (`store.ts:346`). "Open without migrating"
    requires a new store-open mode — `new SqliteStore({ path, migrate: false })`
    (read-the-version-and-refuse-to-bump). This is a **store API change**, not a
    CLI behavior, and it gates every store-client verb. Pull it forward with the
    intent plane.

## 5. Scope / dependencies / MVP

- **Depends on:** [`intent-plane.md`](intent-plane.md) (write intents); the
  `'web'`→`'client'` writer rename (cli-topology §5.2); the renderer from
  [`fragua-ci.md`](fragua-ci.md).
- **Wins independently:** yes once intent-plane lands — the user-facing payoff
  (no localhost round-trip, fully scriptable, never hangs on a missing daemon).
- **MVP = full**, minus the *prompting* console HITL channel (that is
  [`hitl-channel.md`](hitl-channel.md)); `respond` against an existing pause is
  here.
