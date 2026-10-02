# Proposals

Design documents for work that is **not yet a frozen part of the spec**. Each
file declares its `status` + `maturity` in its frontmatter; this index gives
the cross-doc view.

The authoritative description of shipped behaviour lives in
[`docs/SPEC.md`](../SPEC.md) and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md);
this directory is for *active* design work and freeze checklists.

**Rule.** A proposal stays live only while something is pulling on it: an open
PR, a brief under `.fragua/reports/*/briefs/`, or a dated note in its
frontmatter saying who picks it up and when. Anything shipped moves to
[`archive/`](archive/) the day its PR merges; anything untouched for 90 days
with none of the above moves there too, with its state recorded in the archive
index so the thinking is not lost. The nightly `assess` run reports doc drift,
and a stale proposal is the most common kind.

## Live

| Doc | State | Open work |
|---|---|---|
| [`workflow-as-step.md`](workflow-as-step.md) | draft (panel not converged) | `type: workflow` — a workflow invoked as a step: one child run per step over the spawn/park/join spine at N=1, the child's run-level `outputs:` as the step's outputs, `--base` as the worktree hand-off, signoff kept a top-level HITL. The composition direction after the executor refactors landed. Open demands in [`workflow-as-step.critique.md`](workflow-as-step.critique.md). |
| [`ernesto-interop.md`](ernesto-interop.md) | sketch | Two engines, one contract: the shared `fact.*` taxonomy spec + Ernesto's `kind: 'fragua'` step. **v1 runner spec = subprocess** (`fragua ci --json`, ships today); the in-process embed is deferred. Prerequisite (run-level outputs) has shipped. The load-bearing half is [`fact-taxonomy.md`](fact-taxonomy.md). |
| [`fact-taxonomy.md`](fact-taxonomy.md) | sketch (v0) | The shared `fact.*` event contract fragua + Ernesto both implement. Stance: **converge, don't reconcile**. The v0 convergence target (one `fact.run_terminated { status }`, `fact.run_paused { reason }`) has shipped on the fragua side; open: the status string set and the cross-repo copy at the same `taxonomy_version`. |
| [`deterministic-thread-id.md`](deterministic-thread-id.md) | partially shipped | E043 bars an explicit `thread:` on a branch, and synthetic thread ids are pass-qualified (`messages.pass` scopes threadless rehydration). The `messages.thread_id` stamp-on-write column + thread-filtered reads remain designed, not built. Small; pairs with any transcript-touching brief. |
| [`judge-step.md`](judge-step.md) | MVP built; provider record in #129 | `type: judge` — turn-less typed decisions from a System One model over `state:` + `questions:`; `decide.route` / `decide.outcome`, `for-each` + `keep`, `composite:`. Moves to the archive when #129 merges and the §Open items are either shipped or filed as briefs. |

## Archived

See [`archive/README.md`](archive/README.md) for the state of each. Shipped:
`cli-topology.md`, `event-contract-version.md`, `bundles.md`,
`large-run-inputs.md`, `reactive-frontier.md`, `fan-out-nodes.md`,
`mcp-tools.md`, `reversible-migrations.md`, `typed-routing-struct.md`,
`concurrency.md`, `structured-outputs.md`, `tool-outputs.md` (+ critique),
`pi-085-auth-migration.md`, `secret-scrubbing.md` (experimental),
`workflow-ir.md` (A + C), `agent-tool.md`. Superseded: `db-import.md`. Parked without a
sponsor: `tool-exec-variant.md`, `hitl-channel.md`, `cache-retention.md`,
`fan-out-runs.md`, `worktree-opt-out.md`.
