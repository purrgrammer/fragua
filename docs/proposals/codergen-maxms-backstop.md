---
title: Codergen handler maxMs is a runaway backstop, not a typical bound
summary: "LLM handler `DEFAULT_MAX_MS` raised from 30 min to 4 h (runaway backstop, not typical bound) and `DEFAULT_LEAK_GRACE_MS` raised from 10s to 30s — wall-clock no longer the binding constraint on legitimate long-running LLM work."
status: shipped
maturity: specified
last-reviewed: 2026-05-06
rationale: Feature run 01kqtna3ewdet7h6bd halted on `fact.handler_timeout_leaked` at 31m29s into a `verify` node whose diff was correct (local `bun run ci` green in 15s). The 30-min `DEFAULT_MAX_MS` in `handler-bridge.ts` was doing the wrong job — bounding wall-clock on legitimate LLM thinking time when the actual day-to-day bounds (cost, tokens, iterations, operator intents) already cap meaningful work. Raise the default to a runaway backstop and stop pretending it bounds typical completion.
---

> **Shipped (2026-05-06).** `DEFAULT_MAX_MS` raised to 4h in
> `packages/agent/src/handler-bridge.ts:55`; `DEFAULT_LEAK_GRACE_MS`
> raised to 30s in `packages/daemon/src/executor.ts:128` and
> `packages/daemon/src/supervisor.ts:41`;
> `DEFAULT_UNKNOWN_SPEC_FALLBACK_MS` (which mirrors the codergen
> default) raised to 4h in `packages/daemon/src/entrypoint.ts:92`.
> Existing tests use explicit `maxMs` / `leakGraceMs` overrides and
> survive unchanged. Workflow-author surface: nothing — the default
> just stops being binding on healthy long-running work.

# Codergen handler maxMs is a runaway backstop, not a typical bound

> Wall-clock is the wrong axis for bounding codergen work. Cost,
> tokens, iterations, and operator intents already bound *work* —
> wall-clock only loosely correlates with any of them, and the
> correlation breaks the moment the LLM is doing legitimate hard
> thinking. Set the default high enough that no honest workflow
> trips it; let the work-bounded knobs do the day-to-day capping.

## Problem

`packages/agent/src/handler-bridge.ts:55` —
`DEFAULT_MAX_MS = 30 * 60 * 1000` (30 min) is the codergen handler's
wall-clock ceiling. The number was picked when "30 min is generous
for plan/implement/review" felt true. It isn't. Multi-package
verify, deep-research codegen, large refactor passes — all are
legitimately multi-hour and trip the ceiling on healthy work.

Run `01kqtna3ewdet7h6bd` is the concrete evidence:

- `verify` node halted at 31m29s (`30 min maxMs` + 10s
  `LEAK_GRACE_MS` + clock skew) on `fact.handler_timeout_leaked` →
  `fact.run_halted{reason:"error",detail:"handler_leaked"}`.
- Plan / implement / review all completed cleanly. Review approved
  on first pass. The diff was correct: local `bun run ci` green in
  15.08s on the same diff.
- The verify node's prompt explicitly authorises 5 fix cycles. At
  ≥5 min/round of LLM thinking time, that's 25+ min of legitimate
  work + per-round tool overhead — squarely above 30 min.

The ceiling didn't catch a runaway. It killed honest work.

## Why wall-clock is the wrong axis

Codergen nodes already carry the bounds that matter:

| Knob | Bounds | Day-to-day binding? |
|---|---|---|
| `max_cost_usd` | spend | yes |
| `max_tokens` | token throughput | yes |
| `max_iterations` | tool-loop count | yes |
| operator pause/cancel | patience | yes |
| `max_ms` | wall-clock | rarely the right one |

Wall-clock correlates loosely with all four, but it's not a
*meaningful* bound on any of them. A node that's spent 4 hours doing
useful work (5 fix rounds, deep file traversal, careful edits) looks
identical to a stuck one from a wall-clock-only view.

The pathological cases wall-clock is supposed to catch are better
caught elsewhere:

- **Provider hang** — pi-ai already wraps each request in its own
  timeout. A stuck request fails *that call*, not the whole handler.
- **Tool-loop infinite cycle** — `max_iterations` and the cost/token
  budgets cap this directly.
- **Genuinely stuck handler** — the leak-detection path
  (`fact.handler_timeout_leaked`) is the right tool, but the trigger
  should be set so it fires only on *actually* stuck handlers, not
  on legitimately-long ones.

## Proposed fix

### Layer 1 — raise `DEFAULT_MAX_MS` to a runaway backstop

`packages/agent/src/handler-bridge.ts:55`:

```ts
// Wall-clock is a runaway-detection backstop, not a typical-completion
// bound. Day-to-day capping happens on cost/tokens/iterations + operator
// intents. Set this high enough that no legitimate workflow trips it;
// any handler that runs longer than this is pathologically stuck.
const DEFAULT_MAX_MS = 4 * 60 * 60 * 1000; // 4 hours
```

4 hours is the recommendation:

- Comfortably above the longest legitimate codergen node we've
  observed in production (~45 min for a heavy `verify`).
- Low enough that a wedged handler holding the executor slot is
  noticed within an operator's working day, not weeks later.
- One number. No per-class lookup, no stylesheet machinery, no
  workflow-author drudgery to override per node.

Workflow authors who want a *tighter* bound for a specific node
still set `max_ms` explicitly — the existing per-node override path
is unchanged. The default just stops being the binding constraint.

### Layer 2 — raise `LEAK_GRACE_MS` from 10s to 30s

`packages/daemon/src/executor.ts:780` (or wherever the constant
lives — `DEFAULT_LEAK_GRACE_MS = 10_000`).

10s is too tight for a codergen handler mid-bash-tool with a
long-running child process: SIGTERM → SIGKILL escalation, file-handle
close, fdsync, pi-ai abort latency, and any in-flight blob writes
all need to settle. 30s gives the handler room to honour `signal`
cleanly without raising the leak rate on healthy aborts.

This was flagged as out-of-scope in the proposal this one supersedes;
folding it in here because the two changes belong together — both are
"the wall-clock numbers were calibrated wrong."

## Anti-goals

- **Per-class default lookup.** Considered and rejected. Class-keyed
  ceilings (`verify` → 90 min, `commit` → 30 min, etc.) treat the
  symptom: they raise the ceiling for nodes that hit it without
  asking why the universal default is too low. With the universal
  default set to a true runaway backstop, the per-class machinery
  buys nothing.
- **Stylesheet-driven `max_ms`.** Same critique. The bound a workflow
  author actually wants to express is "cap this node's spend at $X"
  or "cap this node at N iterations" — both already supported.
- **Removing wall-clock entirely.** Tempting but rejected. A genuinely
  wedged handler with no I/O activity needs *some* trigger to free
  the executor slot; the leak-detection path is the right place,
  and it needs an upper bound to fire. 4 hours is a backstop, not a
  removal.

## Validation plan

1. Land Layer 1 + Layer 2 in one commit. No code changes elsewhere
   — the two constants are the entire surface.
2. Re-run the feature workflow on a sister proposal that touches
   the same package set as `01kqtna3ewdet7h6bd`. Expect verify to
   finish within budget; expect no other workflow regression
   (everything that fit under 30 min still fits under 4 hours).
3. Watch the `fact.handler_timeout_leaked` rate over the next month.
   If it stays at ~0, the new ceiling is doing its job. If it
   spikes, investigate the offending runs individually — that's
   the trigger working as designed.

Add a unit test in `packages/daemon/test/executor.leak-budget.test.ts`
pinning the new defaults so a future regression is caught at the
constant level, not in production.

## Out of scope

- Why the handler in `01kqtna3ewdet7h6bd` took >10s to honour the
  abort signal. Worth a separate post-mortem with daemon logs from
  the run window — could be bash subprocess shutdown, pi-ai abort
  latency, or something else. The Layer-2 grace bump papers over it
  for now; the post-mortem is a follow-up.
- Reducing the 5-fix-round cap on `verify`. Policy, not ceiling.
