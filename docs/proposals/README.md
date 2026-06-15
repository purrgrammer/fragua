# Proposals

Design documents for work that is **not yet a frozen part of the spec**. Each
file declares its `status` + `maturity` in its frontmatter; this index gives
the cross-doc view. Shipped proposals move to [`archive/`](archive/).

The authoritative description of shipped behaviour lives in
[`docs/SPEC.md`](../SPEC.md) and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md);
this directory is for *active* design work and freeze checklists.

## Live

| Doc | State | Open work |
|---|---|---|
| [`concurrency.md`](concurrency.md) | designed | Umbrella + decision record for parallel fan-out. The linearization invariant; the on-log frontier as the single intra-run model; the recovery-granularity axis (`branch:` / `run:`); doors (multi-node IN MVP, semaphore IN MVP, HITL-in-branch / nested / `map` deferred-but-sound). |
| [`fan-out-nodes.md`](fan-out-nodes.md) | designed | Model A spec: `type: parallel`, multi-node read-class branches as sub-pipelines, on-log reactive frontier, bounded-concurrency semaphore, E036–E043, MVP = static sectioning + verify-step `review.yaml` acceptance. |
| [`reactive-frontier.md`](reactive-frontier.md) | shipped | The `Promise.race` commit-as-settled pool replaced the `Promise.all` superstep batch (head-of-line blocking confirmed in a live post-mortem), plus the two liveness gaps (per-branch watchdog via registry-stamped deadlines, per-branch abort-loop). Open follow-up: a shared `executeNode` kernel for the linear/branch dispatch paths. |
| [`fact-taxonomy.md`](fact-taxonomy.md) | sketch (v0) | The shared `fact.*` event contract fragua + Ernesto both implement. Stance: **converge, don't reconcile**. Envelope, `fact.<subject>_<event>` grammar, the core event set with payload minima, the v0 convergence target — one `fact.run_terminated { status }` (Ernesto has it; fragua collapses its three terminal facts toward it, losslessly), and the extend/version/forward-compat rules. Open: the status string set. Not a shared package — each repo checks in a copy at the same `taxonomy_version`. The load-bearing half of `ernesto-interop.md`. |
| [`ernesto-interop.md`](ernesto-interop.md) | sketch | Two engines, one contract: the shared `fact.*` taxonomy spec + Ernesto's `kind: 'fragua'` step. **v1 runner spec = subprocess** (`fragua ci --json`, ships today) — the child-process boundary dissolves runtime-mismatch, env-confinement, and crash-isolation; the in-process `@fragua/engine` embed (Bun split + `node:sqlite` + embed API) is **deferred, earned not speculative**. One v1 prerequisite: run-level outputs (structured-outputs §11). Plus the convergence list (env lifecycle, graph-as-data, pause taxonomy). Supersedes the embedding motivation of `embeddable-engine.md` (unmerged branch). |
| [`deterministic-thread-id.md`](deterministic-thread-id.md) | partially shipped | E043 bars an explicit `thread:` on a branch, and synthetic thread ids are pass-qualified (`syntheticThreadId(node, iteration, pass)`; `messages.pass` scopes threadless rehydration). The `messages.thread_id` stamp-on-write column + thread-filtered reads remain designed, not built. |
| [`fan-out-runs.md`](fan-out-runs.md) | specified (future) | Cross-run primitive (`run:` — N child runs over a parameter sweep, isolated worktrees, join by cross-run outputs read). The other end of the recovery-granularity axis; after the intra-run frontier. |
| [`hitl-channel.md`](hitl-channel.md) | sketch | `fragua ci --on-pause=auto\|fail\|first\|emit`, `--resume`, console resolver. Route options on the pause fact are already shipped (§5.2). |
| [`secret-scrubbing.md`](secret-scrubbing.md) | shipped-experimental | `scrubber:` config block (§15), `cwd` v1 contract call (full-redact vs basename-normalize), per-export label / `--keep-cwd-path` flags, V2 items. |
| [`structured-outputs.md`](structured-outputs.md) | MVP shipped; §11 designed | §11 (designed, not built): run-level outputs — a top-level `outputs:` block projecting step outputs into a **typed-partial** egress envelope (absent ≠ `""`, absent ≠ halt), read-plane projection over the existing outputs index, E046/W018, `default:` deferred-but-sound. Driver: the `ernesto-interop.md` black-box step. MVP: `outputs:` on **`llm` steps only**; one type grammar shared with `inputs:` (provider-supported JSON-Schema subset, no recursion/`$ref`), compiled to TypeBox; `${{ outputs.X.f }}`, `emit_output` tool, fail-closed reads, native strict-mode via the tool channel; spill via the input CAS path; nonce-wrapped prompt interpolation. Tool production, route-carried outputs, native final-message JSON deferred (§10). `ir_version` bump. |
| [`tool-exec-variant.md`](tool-exec-variant.md) | designed | 0.1.1. `exec: {cmd, args}` argv form + `idempotent:` marker on the `tool` kind. |
| [`workflow-ir.md`](workflow-ir.md) | (A)+(C) shipped, (B) deferred | (B) — `sha = hash(canonical IR core)` — waits until the graph feature set is complete. §8 is the freeze gate + canonicalization checklist. |

## Archived

See [`archive/README.md`](archive/README.md). Shipped: `cli-topology.md`,
`event-contract-version.md`, `bundles.md`, `large-run-inputs.md`. Superseded:
`db-import.md`.
