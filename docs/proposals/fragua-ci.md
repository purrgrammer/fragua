---
title: fragua ci — embedded executor over an ephemeral, portable store
summary: "A one-shot CI command that embeds the executor in-process over an ephemeral SQLite store: env-discovered credentials, write the routing intent, run to terminal, exit with the outcome, render the event log as JSONL. The .db is a portable artifact. Not symmetric with the store-client CLI — it is the one command that writes facts — so it is its own entity, not a flag on `run`."
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
> `getEnvApiKey` map). The drive loop is claim → `runOne` → check-status with a
> store-tailer fiber; exit code = outcome; **fail-on-pause** is the hardcoded
> MVP policy. Deferred (see §3): pluggable `--on-pause`, cross-machine
> `db-import`. The original framing follows.
>
> Child of [`cli-topology.md`](cli-topology.md).

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
  5. drive to terminal:  claimNextRun → runOne(deps) → check status → repeat   [fiber A]
     tailer: poll store seq → render to stdout                                 [fiber B]
  6. exit code = outcome (cli-store-client exit map); pause ⇒ fail (MVP)
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
  (terminal **or pause**). CI either reuses `runExecutor` (maxConcurrent=1, shut
  down on terminal) or claims-then-`runOne`-then-checks-status in a loop. A pause
  with no responder ⇒ exit nonzero (MVP fail-on-pause).
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
- **MVP (shipped):** ephemeral store + claim/`runOne` drive loop + env creds +
  JSONL-to-stdout (`--json`, else human render) + outcome exit code (0 completed,
  130 cancelled, nonzero otherwise) + **hardcoded `fail-on-pause`**. Execution
  environment: a `WorktreeProvisioner` at the checkout cwd (git → worktree,
  non-git → LocalEnvironment). Deferred: pluggable HITL (generalize
  `fail-on-pause` into `--on-pause=auto|fail|first` in
  [`hitl-channel.md`](hitl-channel.md)); cross-machine import (the artifact is
  just the `.db` until [`db-import.md`](db-import.md)).

## 4. Open notes

- **Schema-version on import.** A `ci` ephemeral store is pinned at the *building
  binary's* `CURRENT_SCHEMA_VERSION`. Importing that artifact into a central
  store on a different version is exactly the schema-drift window — tracked in
  [`db-import.md`](db-import.md) §schema-version.
- **HITL in CI** is answered by the auto-approve channel; until then,
  `fail-on-pause` is the safe default (a CI run with no responder must not hang).
