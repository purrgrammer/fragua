---
title: fragua ci — embedded executor over an ephemeral, portable store
summary: "A one-shot CI command that embeds the executor in-process over an ephemeral SQLite store: env-discovered credentials, write the routing intent, run to terminal, exit with the outcome, render the event log as JSONL. The .db is a portable artifact. Not symmetric with the store-client CLI — it is the one command that writes facts — so it is its own entity, not a flag on `run`."
status: proposed
maturity: sketch
last-reviewed: 2026-05-21
parent: cli-topology.md
---

# `fragua ci`

> Child of [`cli-topology.md`](cli-topology.md). The **urgent** deliverable —
> but **sketch, not designed**: an adversarial pass found two unnamed
> prerequisites (executor-assembly extraction, env→creds bridge) and an
> under-specified drive loop. Gated on [`intent-plane.md`](intent-plane.md),
> the executor-assembly factory ([executor-pbt-decomposition.md Phase 8](executor-pbt-decomposition.md)),
> and the pre-0.1.0 cleanup (shipped).

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
  4. plane.build(enqueue intent) → store.enqueueRun                        (via intent-plane)
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

- **Depends on:** [`intent-plane.md`](intent-plane.md) (mint + write the routing
  intent); **the executor-assembly factory** (executor
  [Phase 8](executor-pbt-decomposition.md) — `buildExecutorDeps` + injectable
  tool/credentials registries); the **env→creds bridge**; the
  pre-0.1.0 cleanup (shipped — which removed the sub-agent backend,
  shrinking the assembly to extract); a renderer (built here, shared into
  `cli-store-client`'s `watch`).
- **Wins independently:** yes *once its prerequisites land* — but it is **not**
  gated only on intent-plane (the original claim). The assembly extraction is the
  item that, left implicit, blows the estimate.
- **MVP:** ephemeral store + `runOne` + env creds + JSONL-to-stdout + outcome
  exit code + **hardcoded `fail-on-pause`** (so it ships before the HITL
  workstream). Deferred: pluggable HITL (generalize `fail-on-pause` into
  `--on-pause=auto|fail|first` in [`hitl-channel.md`](hitl-channel.md));
  cross-machine import (artifact is just the `.db` until [`db-import.md`](db-import.md)).

## 4. Open notes

- **Schema-version on import.** A `ci` ephemeral store is pinned at the *building
  binary's* `CURRENT_SCHEMA_VERSION`. Importing that artifact into a central
  store on a different version is exactly the schema-drift window — tracked in
  [`db-import.md`](db-import.md) §schema-version.
- **HITL in CI** is answered by the auto-approve channel; until then,
  `fail-on-pause` is the safe default (a CI run with no responder must not hang).
