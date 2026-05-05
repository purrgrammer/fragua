---
title: Codergen handler maxMs is too tight for multi-package verify
status: proposed
maturity: designed
last-reviewed: 2026-05-05
rationale: Feature run 01kqtna3ewdet7h6bd halted on `fact.handler_timeout_leaked` at 31m29s into the verify node — the codergen default maxMs (30 min) capped a legitimate multi-fix-round CI loop on a monorepo where `bun run ci` legitimately runs to completion in ~15s but the LLM iterates through 5 fix rounds × ~5 min each.
---

# Codergen handler maxMs is too tight for multi-package verify

> The codergen handler's default `maxMs = 30 * 60 * 1000` (30 min) is
> a sensible ceiling for a *single* iteration of plan/implement/review
> work, but it's the same ceiling that fences a `verify` node which
> runs a full CI loop and is allowed to take up to 5 LLM-fix rounds.
> When `bun run ci` is fast (~15s) but each fix iteration's LLM round
> spends 5+ min thinking + tool-using, 30 min becomes the binding
> constraint and the run halts mid-fix with no recourse.

## Evidence

Run `01kqtna3ewdet7h6bd` (`feature` workflow on `agent-tool` proposal):

- `fact.node_started` for `verify` at `00:08:24`.
- `fact.handler_timeout_leaked` at `00:39:53` — exactly 31m29s
  (30min `maxMs` + 10s `LEAK_GRACE_MS` + observed wall-clock skew).
- `fact.run_halted { reason: "error", detail: "handler_leaked" }`
  immediately after.
- Plan, implement, and review all completed cleanly. Review
  approved on first pass. The verify node was the only stage with
  the budget exhausted.
- Local `bun run ci` on the same diff: green in **15.08s**.

Implication: the diff was correct; the verify node was *succeeding*
mid-process and got cut off because the LLM's planning between
`bun run ci` invocations consumed the 30-min budget.

## Surfaces involved

- `packages/agent/src/handler-bridge.ts:55` —
  `DEFAULT_MAX_MS = 30 * 60 * 1000`. The shared codergen ceiling.
- `packages/daemon/src/executor.ts:780` — leak detection emits
  `fact.handler_timeout_leaked` after `spec.maxMs + LEAK_GRACE_MS`
  (10s grace).
- `~/.swarm/workflows/feature.dot` — verify node has
  `max_cost_usd = 1.50`, `max_tokens = 4000000`, but **no
  `max_ms` override**. Inherits the codergen default.

The verify node's prompt explicitly authorises 5 fix cycles
("Cap: 5 fix rounds — then abort with reason `CI unstable: <last
failure signature>`"). At ≥5 min/round in LLM time on a complex
diff, that's 25+ min just for the fix LLM rounds, plus the initial
CI run, plus per-round tool overhead — squarely above 30 min.

## Proposed fix — two layers

### Layer 1 — per-workflow override (immediate)

Land a one-line addition to `feature.dot`'s verify node:

```dot
verify [
  class         = "verify"
  prompt        = "..."
  allowed_tools = "read, write, edit, bash"
  max_cost_usd  = 1.50
  max_tokens    = 4000000
  max_ms        = 5400000   // 90 min — accommodates 5 fix rounds on multi-pkg work
]
```

Same change probably warranted for `change.dot`'s verify (smaller
budget but same prompt shape). No behaviour change for
plan/implement/review/commit nodes — those finish well within 30 min
in practice.

### Layer 2 — separate ceilings for codergen vs verify-shaped work (follow-up)

The deeper issue is that "codergen handler default" is one number
serving two regimes:

- **Tight regime** — plan, implement, review: short LLM rounds,
  bounded by `max_goal_gate_retries`. 30 min is generous.
- **Loose regime** — verify, sometimes commit: bounded by an
  external loop (CI fix cycles, hook-failure retries). The wall
  clock is dominated by the LLM's between-tool thinking time and
  the cap is per-step, not per-round.

Options:

A. **Class-keyed defaults**: codergen handler-bridge looks up
   `DEFAULT_MAX_MS_BY_CLASS` and falls back to the universal
   default. `class = "verify"` → 90 min; `class = "commit"` → 30 min;
   unspecified → 30 min. Cheap, no schema changes.

B. **Stylesheet-driven**: extend `model_stylesheet` to also stamp
   `.verify { max_ms: 5400000; }`. More general but requires
   parser/validator support.

C. **Status quo with documentation**: leave the default at 30 min,
   document the verify pattern in `docs/handler-contract.md` so
   workflow authors set `max_ms` explicitly. Minimum surface change
   but doesn't help authors who forget.

Strawman: **A**. Class is already the natural axis (`verify` /
`commit` are existing class values); a small map lives next to
`DEFAULT_MAX_MS` and the executor reads the resolved spec normally.

## Leak-grace separately

The 10s `DEFAULT_LEAK_GRACE_MS` is the secondary constraint:
when the executor calls abort, the handler has only 10s to honour
`signal` before being declared leaked. For a codergen handler
mid-bash-tool with a long-running child process, 10s is tight —
SIGTERM → SIGKILL escalation, file-handle close, fdsync, etc.
Worth raising to 30s as a separate hardening pass; out of scope for
this proposal.

## Validation plan

1. Apply Layer-1 to `feature.dot` and re-run the agent-tool feature
   on a sister proposal that touches the same package set. Expect
   verify to finish within budget.
2. (Layer-2) Author the class-keyed map, update
   `docs/handler-contract.md`, add a unit test in
   `packages/daemon/test/executor.leak-budget.test.ts` that pins the
   class-keyed resolution.

## Out of scope

- Why the handler took >10s to honour the abort signal in this
  specific run (could be bash subprocess shutdown, pi-ai abort
  latency, or something else). Worth a separate post-mortem with
  daemon logs from the run window.
- Reducing the 5-fix-round cap on verify — that's policy, not
  ceiling.
