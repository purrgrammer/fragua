# Cost & Token Accounting — Review

Deep read end-to-end: pi-ai pricing table → provider cost calc → event
emission → handler-bridge accumulation → executor accounting → reducer →
store generated columns → REST adapters → web stats.

## The basic pipeline (accurate, not estimated)

1. **Pricing** lives in `node_modules/@mariozechner/pi-ai/dist/models.generated.js` —
   a static table. Example: `anthropic/claude-opus-4-7` =
   `{input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25}` USD per
   million tokens.
2. **Token counts** come from the provider response (Anthropic:
   `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
   `cache_creation_input_tokens` — `providers/anthropic.js:173-179`).
   Provider-reported, not estimated.
3. `calculateCost()` (`models.js:22-29`) multiplies each bucket by its
   price and sums. Linear, deterministic.
4. pi-agent-core emits `message_end` → `event-bridge.ts:15` builds
   `cost.recorded` with `cost_usd = msg.usage.cost.total` and
   `total_tokens = msg.usage.totalTokens`. Tool-result `message_end`
   events are filtered (`backend.ts:386` checks `role === "assistant"`),
   so the data fed back to the model isn't double-counted as its own
   cost — it's correctly absorbed into the *next* call's `input_tokens`.
5. `handler-bridge.ts:88-97` accumulates per-turn; executor writes into
   `fact.node_completed`; `reducers.ts:50-91` folds into
   `run_state.metrics`.

Per-call USD is as accurate as the pricing table (baked in, see ⑥).
Not an estimation. Tool calls and tool results are correctly attributed:
each LLM call inside a tool loop emits its own `cost.recorded`, and the
input tokens of every follow-up call cover the prior tool-result content
the provider had to read.

## Token vocabulary

Two distinct quantities — separate names, separate read sites:

- **`billedTokens`** = `input + output + cacheRead + cacheWrite`. The
  invoice number. Stored on `state.metrics.billedTokens`, surfaced as
  `run_state.billed_tokens` (generated column) and `/metrics/global`
  `billed_tokens`.
- **`freshTokens`** = `input + output`. Work-done. Computed at every
  read site from `totalInputTokens + totalOutputTokens` — no stored
  scalar. Web `computeStats.freshTokens` and `/metrics/global`
  `fresh_tokens` expose it; the home Tokens tile uses fresh.

`budget_tokens` fences against fresh. `budget_usd` caps the bill. The
two ceilings are orthogonal — a run with heavy cache reads stays under
the token ceiling while still showing accurate billed totals on the
dashboard.

## Findings

### ① Parallel branch costs are silently dropped from rolled-up metrics

`packages/core/src/handler/handlers/parallel.ts:117-121`
```ts
return { kind: "transition", nextNode: cfg.fanInNode, …, tokens: 0, costUsd: 0, … };
```
Branches are sub-handler calls inside the parent turn, not separate
executor turns, so they don't write their own `fact.node_completed`. A
codergen branch returns populated `tokens/costUsd/inputTokens/outputTokens`
in its `HandlerResult`, and the parallel wrapper throws them away. The
executor's zero-backfill (`executor.ts:637-651`) only fills from
`LlmAccounting` (which fires on `ctx.llm.call()`) — codergen bypasses
that path entirely (Agent talks to the provider directly), so the
executor-side accumulator is also zero.

The branches' `cost.recorded` events do land in the events table (so
`getRunCostTotals` SQL is right), but they never reach
`state.metrics.totalCostUsd`, `state.metrics.totalInputTokens` /
`totalOutputTokens`, the generated columns, or `metrics.nodeCosts`.

**Net: parallel fan-outs using codergen branches report $0 / 0 tokens
in rolled-up metrics. Two real consequences:**

- **The UI tile and `/metrics/global` understate parallel runs.**
- **`budget_usd` and `budget_tokens` are both bypassable.** The budget
  evaluator reads cumulative cost / fresh tokens out of `state.metrics`
  (`executor.ts:702-712`), and branches never increment either. A
  parallel-heavy run can blow past both ceilings without ever firing
  `budget.stop`. The budget ledger went in believing branches landed
  cost via their own `fact.node_completed`; they don't.

### ② Per-model attribution uses only the last model seen

- `executor.ts:444`: `lastModel = model` overwrites.
- `handler-bridge.ts:97`: `if (model != null) modelName = model` overwrites.

A turn that calls two different models credits 100% of its tokens/cost
to the second one in `metrics.models[...]`. Single-model nodes are fine;
mixed-model turns mis-attribute. The summariser path is one realistic
trigger: `summary:medium/high` runs a different model from the calling
node, both fire through the same handler-bridge accumulator.

### ⑤ `costUsd: 0` is ambiguous

`executor.ts:637-638`
```ts
if (result.tokens === 0 && turnBilled > 0) result.tokens = turnBilled;
if (result.costUsd === 0 && totalCostUsd > 0) result.costUsd = totalCostUsd;
```
A handler that genuinely spent $0 but had non-zero `LlmAccounting`
(e.g. used `ctx.llm` only through a code path that suppressed cost)
gets silently backfilled. Rare, but worth naming.

### ⑥ Pricing is a frozen snapshot

`models.generated.js` ships with pi-ai. No "as of <date>" on any USD
figure in the UI. If a provider drops prices, historical USDs remain
on the old rate until a pi-ai bump — arguably correct (historical cost
shouldn't shift), but also: if pi-ai had a bad rate, every number since
then is wrong silently.

### ⑦ `ctx.emit('cost.recorded')` from non-codergen handlers is invisible to metrics

The executor's `LlmAccounting` (`executor.ts:436-446`) is fed only by
`ctx.llm.call()`. The codergen path sidesteps this and self-aggregates
in `handler-bridge.ts:88-97`, then surfaces the totals on its
`HandlerResult` so the executor's zero-backfill picks them up. Any
*other* handler that reaches an LLM (a future custom handler, a tool
that internally calls a model) and emits `cost.recorded` via
`ctx.emit` lands the cost in the events table but **not** in
`state.metrics`, the generated columns, or the budget evaluator.

Foot-gun for the next handler kind. Today there's only one such kind
(codergen) and the pattern is correct; the trap is that the contract
isn't enforced — `ctx.emit('cost.recorded', …)` looks like it should
"just work."

### ⑨ Per-chunk cost accounting is upstream-blocked — partial-stream cost is dropped on crash / abort

`packages/agent/src/event-bridge.ts:62` only emits `cost.recorded` on `message_end` (end of an assembled assistant turn). pi-agent-core's `AssistantMessageEvent` carries a `partial: AssistantMessage` field on every delta (`pi-ai/dist/types.d.ts:210-260`), but the embedded `usage` is provider-dependent:

- **Anthropic** streams `message_delta` events with running `usage` mid-turn — recoverable in principle, but pi-ai's bridge doesn't surface a per-chunk usage event today.
- **OpenAI** delivers usage only in the final stream chunk (`stream_options: { include_usage: true }`).
- **Google** delivers usage only at end.

When a daemon dies mid-stream or the executor aborts a handler (timeout / steer / cancel) before `message_end`, the partial output:

- **Is on disk as deltas** (`llm.text_delta` / `llm.thinking_delta` / `llm.toolcall_delta` are observability events, durable in the `events` table).
- **Has been billed by the provider** (Anthropic and OpenAI both bill per token streamed, regardless of stream completion).
- **Does not land in `state.metrics`** — no `cost.recorded` ever fires for the partial.
- **On resume, will be billed again**: input prefix cache hits typically work (sessionId is stable across restarts; pi-ai sets cache_control headers), so input is mostly free, but **output tokens for the redo are paid in full**.

Net: a run killed mid-30s/4000-token completion at second 25 pays for ~3300 output tokens twice — once silent (lost on crash) and once accounted (on the redo). `state.metrics.totalCostUsd` only sees the second one. `budget_usd` enforcement undercounts by the lost amount until the redo completes.

**Why we don't estimate.** Estimating output cost from streamed delta byte count × tokens-per-byte ratio × per-token output rate would give a rough number but introduce error of unknown sign. Policy: drop the data point rather than report inaccurate cost. The lost cost is bounded (single mid-stream crash per dispatch) and surface-area is limited to crash/abort paths.

**What unblocks a fix.**

- Upstream pi-ai exposes a per-chunk `usage_delta` event (Anthropic: trivial; OpenAI/Google: limited to final chunk). Filed upstream — track there.
- Until then: bridge captures the deltas (in `event-bridge.ts`), so a future replay path can reconstruct the partial AssistantMessage from disk and synthesize a `cost.recorded` once we have authoritative usage.

### ⑧ Reported cost is ~50% of actual provider charge for `provider: "ppq"`

Two quick-change runs (claude-sonnet-4.6 via ppq) reported $0.381 + $0.693 = **$1.074**; the user's PPQ balance dropped by **$2.12** over the same window (no other activity).

Token mix matches roughly Anthropic-published cache-read pricing (run 2: 91% cache_read, blended ~$0.27/M ≈ Anthropic's $0.30/M cache-read rate). Hypotheses worth ruling out:

- pi-ai pricing table has no `ppq/<model>` key → silent fallback to Anthropic-direct rates while PPQ adds a per-token markup. **Confirmed**: `grep -c ppq node_modules/@mariozechner/pi-ai/dist/models.generated.js` = 0; `claude-sonnet-4*` entries in the table are all `anthropic.*` keys. Whatever fallback path resolves the price for `provider="ppq"` is using Anthropic-direct pricing; the gap to actual PPQ charges (here ~2x) is invisible to swarm.
- PPQ doesn't actually serve cached reads at Anthropic's 90%-off rate → user pays full input rate while we record `cache_read_tokens` and price them at $0.30/M.
- Model-name slug mismatch (`claude-sonnet-4.6` vs `claude-sonnet-4-6`, etc.) → fallback to a cheaper-priced model in the table.

Linked to ⑥ (frozen pricing) but distinct: ⑥ assumes the right key was found and the value got stale; ⑧ is "wrong/missing key in the first place".

## Resolved since the prior pass

- **`captureBudget()` returns zeros** — fixed in `aa9545e`. The executor
  passes a real snapshot via `ctx.budgetSnapshot`
  (`executor.ts:513-521`); `backend.ts:376` prefers it over the zeroed
  shape.
- **Budgets don't halt runs** — fixed in `aa9545e`. `evaluateBudget`
  runs at the post-handler boundary (`executor.ts:704-712`); breach
  rewrites `result` to a budget halt before `resultToFacts`, producing
  the `[budget.stop, fact.run_halted]` chain. Caveat: enforcement is
  still subject to ① — branches' spend doesn't reach the metrics the
  evaluator reads.
- **`totalTokens` meant two different things** — fixed in `49a92fc`.
  Reducer/SQL now uses `billedTokens` (all four buckets); web stats and
  `/metrics/global` expose `freshTokens` (input+output) separately.
  `budget_tokens` switched to fence against fresh — orthogonal to
  `budget_usd`. Home Tokens tile shows fresh with a hover breakdown of
  all four buckets. Schema bumped to v5; v4→v5 migration rebuilds
  `run_state` with the renamed generated column and rewrites each row's
  metrics JSON.
- **Pre-split fallback in `runs-adapter`** — removed in `49a92fc`.
  `inputTokens` now reads `m.totalInputTokens` directly; pre-split runs
  render zeros instead of conflating the all-buckets total with input.
- **Per-node `tokens` conflated cache reads** (was finding ④) — fixed in
  `49a92fc`. `state.metrics.nodeCosts[].tokens` accumulates fresh now
  (`reducers.ts:71`), so per-node `max_tokens` ceilings and the detail
  view both reflect actual model input.

## TL;DR

Individual LLM-call USDs are **accurate** (provider-reported tokens ×
baked pricing table, not an estimate). Tool-call/result attribution
flows correctly because each LLM call self-reports usage and tool
results show up as input tokens of the next call. The roll-ups are
where it bends: ① parallel branches silently underreport AND let runs
outspend `budget_usd` / `budget_tokens`, ② per-model attribution is
wrong for mixed-model turns, ⑦ only codergen handlers feed metrics —
any other handler emitting `cost.recorded` is invisible to the budget
ledger. ⑧ `provider: "ppq"` falls back to Anthropic-direct prices and
under-reports actual charges by ~2× because pi-ai's pricing table has
no PPQ keys.
