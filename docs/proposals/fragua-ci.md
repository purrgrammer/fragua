---
title: fragua ci — embedded executor over an ephemeral, portable store
summary: "A one-shot CI command that embeds the executor in-process over an ephemeral SQLite store: env-discovered credentials, write the routing intent, drive the run to a stop-state (continuing the daemon-owed paused_auto retry tick), exit with the outcome through a total status→code map, render the event log as JSONL. The .db is a portable artifact. Not symmetric with the store-client CLI — it is the one command that writes facts — so it is its own entity, not a flag on `run`."
status: shipped
maturity: shipped
last-reviewed: 2026-05-25
parent: cli-topology.md
---

# `fragua ci`

> **Status (2026-05-25): MVP shipped.** `fragua ci <workflow>` is live
> (`packages/cli/src/commands/ci.ts`). All three prerequisites landed: the
> intent plane, the executor-assembly factory
> ([executor-pbt-decomposition.md Phase 8](executor-pbt-decomposition.md) →
> `packages/cli/src/executor-deps.ts` `buildExecutorDeps`), and the env→creds
> bridge (`packages/cli/src/env-creds.ts` `seedCredsFromEnv`, over pi-ai's
> `getEnvApiKey` map). The drive loop (`packages/cli/src/ci-drive.ts`
> `driveCiRun`) mirrors the daemon's `wakePending → claim → runOne` tick for one
> run, with a store-tailer fiber for the render. Exit code = outcome through the
> total `RunStatus`/`HaltReason` → code map (`packages/cli/src/ci-exit.ts`
> `ciExitCode`). Deferred (see §3): pluggable `--on-pause` responder,
> cross-machine `db-import`. The original framing follows.
>
> Child of [`cli-topology.md`](cli-topology.md).

> **Pause policy (2026-05-25, supersedes "fail-on-pause").** The drive loop
> **continues the `paused_auto` arm** — the daemon-owed clock tick
> (`provider_retry` / `handler_retry` / `timeout_retry`). It honours the run's
> `routing.internal.auto_resume_at` backoff, then loops so `wakePending` flips
> the run back to `queued` for re-claim, exactly as the daemon would. So a CI
> run is no longer failed the instant a node retries — it drives to a real
> terminal. The loop only STOPS (non-zero exit) on a terminal state or an
> *unanswerable* pause: `paused` (operator action), `paused_human` (HITL),
> `quarantined` — CI has no responder for those. **One exit code per terminal
> reason**, banded by status-class for legibility, so a CI run **never exits 0
> on anything but a clean `completed`** and can `case $?` on exactly why it
> stopped:
>
> | Stop-state / reason | Code |
> |---|---|
> | `completed` | `0` |
> | `ci` couldn't run the workflow (not found / parse / config / throw) | `1` |
> | `halted`: `error` `aborted_exit` `budget` `occ_exhausted` `timeout_exhausted` `route_not_picked` `route_call_not_isolated` `edge_no_match` | `10`–`17` |
> | `paused`: `operator` `provider_error` `payment_required` `budget` `max_retries` `goal_gate` `max_loops` `abort_loop` `provider_exhausted` `engine_incompatible` | `30`–`39` |
> | `quarantined`: `orphan_side_effect` `other` | `50`–`51` |
> | `paused_human` (HITL — no reason enum) | `60` |
> | `queued`/`running`/`paused_auto` as a stop-state (a `ci` driver bug) | `70` |
> | `cancelled` (or SIGINT/SIGTERM) | `130` |
>
> The per-reason maps are `Record<Union, number>` (`HALT_EXIT` / `PAUSE_EXIT` /
> `QUARANTINE_EXIT`), so totality is the type system itself — adding a
> `HaltReason`/`PauseReason`/`QuarantineReason` literal without a code is a
> compile error (CLAUDE.md ground rule 1). The trade-off: each engine reason is
> now a public exit code, so adding a reason is a CLI contract change — pick the
> next code in the band. The auto-wake PauseReasons (`provider_retry` /
> `handler_retry` / `timeout_retry`) project to `paused_auto`, which the loop
> *continues*, so they map to `70` only to keep the record total.

## 1. Why it is separate

Every other CLI verb is a pure store-client (write an intent, return). `ci` is
the one command that **embeds the executor**, so it writes `fact.*` itself.
Forcing it into the store-client `run` shape would conflate two contracts —
*"recorded"* vs *"executed, here's the outcome."* So it is its own command. CI is
also the one caller that genuinely wants *execute-now, exit-code = outcome*; that
is the embedded-engine semantics, the proof it can't be `run --watch`.

A CI run needs neither the HTTP API nor cross-process coordination: ephemeral
machine, one workflow, record result. `runOne` already takes a plain
`IEventStore` — no daemon, no supervisor, no `serve`, no `daemon_lock`.

## 2. Design

```
fragua ci <wf> [--db <path>] [--input k=v] [--json]
  1. open ephemeral store (temp, or --db-pinned), created at baseline version
  2. bridge credentials from env → the store's provider_credentials rows
  3. buildExecutorDeps(env) → { store, dispatcher, tools, llmCall, ... }   (assembly factory)
  4. buildSaveWorkflow(source) → commit  (ALWAYS — a CI store starts fresh, so the
     workflow is never already present), THEN buildEnqueue → commit by the just-minted
     sha. Two ops sequenced by the command, same save-then-enqueue as every other
     caller (intent-plane §3.1).
  5. drive (driveCiRun): wakePending → claimNextRun → runOne(deps);            [fiber A]
       paused_auto → honour auto_resume_at, re-claim (continue); stop on
       terminal / paused / paused_human / quarantined
     tailer: poll store seq → render to stdout                                 [fiber B]
  6. exit code = ciExitCode(status, {halt|pause|quarantine}) — one code per
       reason (banded), 0 only on completed
  artifact: the .db (and/or JSONL export)
```

- **Ephemeral store**, temp or `--db`-pinned. Fresh DB ⇒ created at the baseline
  schema version; no migration question.
- **Credentials — env→store bridge, not a config layer.** Reality check: the
  daemon resolves providers from the store's `provider_credentials` /
  `provider_config` rows (`daemon.ts:145`), *not* from `config.yaml`. So CI does
  not "add an env layer to the config cascade" — it **populates the ephemeral
  store's cred rows from env** (`ANTHROPIC_API_KEY`, …) at startup, then normal
  store-backed resolution runs unchanged. (Alternative: an env-direct port on the
  credentials registry — executor [Phase 8](executor-pbt-decomposition.md).)
- **Assembly factory.** "build dispatcher/tools/llmCall" is **not** a constructor
  call — that wiring is ~400 lines inline in `daemonCommand`
  (`daemon.ts:128–~520`). CI reuses it only once it is extracted into
  `buildExecutorDeps` (executor [Phase 8](executor-pbt-decomposition.md)) with
  the tool + credentials registries injectable.
- **Drive loop.** `runOne` does *not* claim or loop — `runExecutor` claims via
  `claimNextRun` then calls `runOne` once, which drives the run to its next yield
  (terminal **or pause**). CI runs its own one-run version of the daemon tick
  (`ci-drive.ts` `driveCiRun`): `wakePending → claim → runOne`, **continuing the
  `paused_auto` arm** (honour `auto_resume_at`, then re-claim) and stopping only
  on a terminal state or an unanswerable pause (`paused` / `paused_human` /
  `quarantined`) ⇒ exit nonzero (see the Pause-policy note above).
- **Executor + tailer fibers.** Even in-process, **the tailer reads the store,
  not the executor** — so `ci` and `fragua watch` share one rendering path and
  cannot drift. (Both on one `bun:sqlite` handle; SQLite calls are sync and
  fibers yield only at `await`, so write/poll interleave safely.)
- **Execution environment.** The daemon wires a `WorktreeProvisioner` (a git
  worktree per run). CI must choose: run **in the checkout cwd** (no provisioner,
  likely default) or in a worktree. `provisioner` is optional in `ExecutorOpts` —
  an explicit choice, not a default.
- **Portable state.** The `.db` *is* the artifact (upload it); JSONL is its line
  view. Merging it into a central store is [`db-import.md`](db-import.md).

## 3. Scope / dependencies / MVP

- **Depends on (all landed):** ✅ [`intent-plane.md`](intent-plane.md) (mint +
  write the routing intent — `buildSaveWorkflow`/`buildEnqueue`); ✅ **the
  executor-assembly factory** (executor [Phase 8](executor-pbt-decomposition.md) →
  `packages/cli/src/executor-deps.ts` `buildExecutorDeps`; credentials stay
  store-backed, so the seam is the store's cred rows, not an injected registry —
  the env→creds bridge seeds them); ✅ the **env→creds bridge**
  (`packages/cli/src/env-creds.ts`); ✅ the pre-0.1.0 cleanup; ✅ a renderer —
  reused, not built: `run-follow.ts` `renderEvent` already backs `run --follow`,
  so `ci` shares it (the tailer reads the store, so neither can drift).
- **Estimate note (borne out):** the assembly extraction was indeed the long
  pole — done as its own commit (Phase 8) before the command, behaviour-preserving
  for the daemon.
- **MVP (shipped):** ephemeral store + `driveCiRun` loop (continues
  `paused_auto`) + env creds + JSONL-to-stdout (`--json`, else human render) +
  the total `ciExitCode` map (see the Pause-policy table). Execution
  environment: a `WorktreeProvisioner` at the checkout cwd (git → worktree,
  non-git → LocalEnvironment). Deferred: a pluggable responder for the
  *unanswerable* pauses (`--on-pause=auto|fail|first` in
  [`hitl-channel.md`](hitl-channel.md)) — until then they stop the run with a
  distinct non-zero code; cross-machine import (the artifact is just the `.db`
  until [`db-import.md`](db-import.md)).

## 4. Open notes

- **Schema-version on import.** A `ci` ephemeral store is pinned at the *building
  binary's* `CURRENT_SCHEMA_VERSION`. Importing that artifact into a central
  store on a different version is exactly the schema-drift window — tracked in
  [`db-import.md`](db-import.md) §schema-version.
- **HITL in CI** is answered by the auto-approve channel; until then, an
  *unanswerable* pause (`paused` / `paused_human` / `quarantined`) stops the run
  with a distinct non-zero exit code — a CI run with no responder must not hang.
  Note this is narrower than the old "fail-on-pause": `paused_auto` (the
  daemon-owed retry tick) is *not* a stop — the loop rides it to a real
  terminal.
