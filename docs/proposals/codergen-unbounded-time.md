---
title: Codergen nodes — unbounded wall-clock time
summary: "LLM nodes can opt out of wall-clock bounding via `max-ms: 0`; the auto-dispatcher resolves zero to `HandlerSpec.maxMs: undefined`, the executor skips `AbortSignal.timeout` and the leak watchdog, the supervisor skips the stuck-node trip. Cost / tokens / operator intents remain the operative ceiling. Default `DEFAULT_MAX_MS` stays at 4 h when nothing is set — unbounded is opt-in per node."
status: shipped
maturity: sketch
last-reviewed: 2026-05-16
---

# Codergen nodes — unbounded wall-clock time

> Codergen is the long-running shape: a model that thinks, calls tools, reads files, iterates. The
> meaningful ceiling is *what the model spends* — input/output tokens and USD — not how many
> minutes the wall clock ticks. Wall-clock matters for `tool` (shell subprocess) and `parallel`
> (sibling branches), where a runaway has obvious blast radius. For codergen the wall-clock cap is
> mostly cargo: a 30-min default forces operators to invent budgets the model doesn't actually
> need, and a 12-hour bump just admits that.
>
> Make `HandlerSpec.maxMs` **optional** for the codergen handler. When unset, no
> `AbortSignal.timeout` is created; the leak-watchdog falls back to a different signal; the
> timeout-retry path is skipped (it has nothing to retry against). Operators bound runs through
> `max_tokens` / `max_cost_usd` on the node attrs — which already exist and already work.

## Why

- **What we have today.** `HandlerSpec.maxMs: number` is required (`packages/core/src/handler/types.ts:19`).
  Every dispatch builds `AbortSignal.timeout(spec.maxMs)` (`executor.ts:605`), a leak watchdog
  fires `spec.maxMs + leakGrace` after dispatch (`:864`), and the timeout-retry pause path quotes
  `spec.maxMs` as `attemptedMs` (`:993`). All three paths assume a number.
- **The bug it forces.** To get "effectively unbounded" the operator sets `timeouts.codergen` to a
  large duration string (`"999h"` is the going rate). The arbitrary ceiling is a smell — the value
  has no semantic meaning, just "large enough that I won't hit it." Real cost controls
  (`max_tokens`, `max_cost_usd`) are the actual ceiling and live on the node attrs.
- **The bug it produces.** `parseDurationMs` accepts `ms/s/m/h` and validates against safe
  integers, but Node's `setTimeout` silently clamps any delay above `2^31 - 1` (~596 hours, ~24.8
  days) to 1 ms. A `"999h"` config slips through `parseDurationMs` cleanly, then the leak
  watchdog at `executor.ts:864` fires immediately and the run halts with
  `reason: "error", detail: "handler_leaked"`. Observed in practice on 2026-05-15. A safer
  ceiling like `"240h"` (10 days) dodges the clamp — but the value remains a smell.
- **Why other handler kinds are different.**
  - `tool` (shell subprocess): wall-clock IS the right bound. A hung `bun run ci` could spin
    forever. Default `5 * 60 * 1000` ms (`handlers/tool.ts:80`) stays sensible.
  - `parallel` / `fan_in`: branches need a wall-clock ceiling so a stuck sibling can't pin the
    parent forever. Default `60 * 60 * 1000` for `parallel`, `1_000` for `fan_in` (`parallel.ts:47`,
    `fan-in.ts:33`) stay sensible.
  - `codergen`: the model is the bottleneck and self-limits via tokens / cost. Wall-clock adds no
    safety, only false ceilings.

## Shape

Three site changes:

1. **Type** — `packages/core/src/handler/types.ts:19`:
   ```ts
   maxMs?: number;   // was: maxMs: number
   ```

2. **Executor dispatch** — `packages/daemon/src/executor.ts:605`:
   ```ts
   const signals: AbortSignal[] = [steerCtrl.signal, opts.shutdownSignal];
   if (spec.maxMs !== undefined) signals.push(AbortSignal.timeout(spec.maxMs));
   ```

3. **Leak watchdog** — `packages/daemon/src/executor.ts:855-871`. The watchdog exists to catch a
   handler that ignores `AbortSignal` past `maxMs + leakGrace`. With no `maxMs`, there's nothing
   to leak past — gate the `Promise.race` on `spec.maxMs !== undefined`. Codergen nodes simply
   `await spec.handler(ctx)` directly; the steer / shutdown abort signals still apply.

4. **Timeout-retry pause** — `packages/daemon/src/executor.ts:985-995`. This block fires when the
   abort cause classifies as a timeout (signal fired from `AbortSignal.timeout`). With no
   `AbortSignal.timeout`, the cause can't be `timeout` — the branch becomes unreachable for
   codergen and stays valid for `tool` / `parallel`. No code change needed beyond making sure
   `attemptedMs` access is gated on the same `spec.maxMs !== undefined` check used at dispatch.

5. **`resolveMaxMs`** (`packages/daemon/src/auto-dispatcher.ts:60`) already returns `undefined`
   when neither attr nor fallback is set. Today that bubbles up as a type error in `specForNode`;
   after this PR it propagates as `HandlerSpec.maxMs: undefined`.

6. **Default behaviour for non-codergen kinds is unchanged.** `tool` and `parallel` factories keep
   their `DEFAULT_MAX_MS` constants and always pass a number.

## Operator surface

- **Today**: `timeouts.codergen: "999h"` in `~/.swarm/config.yaml` (the workaround this proposal
  obsoletes).
- **After this PR**: omit `timeouts.codergen` entirely. Set `max_tokens` / `max_cost_usd` on the
  codergen node attrs (or rely on workflow-level / per-class defaults via `model_stylesheet`).
- **Halt semantics**: a runaway codergen still halts on `max_tokens` / `max_cost_usd` exhaustion
  with `reason: "budget"` (existing path). Wall-clock-class halts (`reason: "timeout"`) for
  codergen go away — but they were always a poor proxy for the real bound.

## Migration

Trivial — the change is type-narrowing for optionality. Tests that construct `HandlerSpec` by hand
need no change (a literal `maxMs: 60000` is still valid). The CLI's `timeouts.codergen` config key
stays accepted for back-compat; operators who set it get the old behaviour (`AbortSignal.timeout`
fires when reached). Removing the workaround is opt-in.

Same-PR doc updates per `AGENTS.md` §1:
- `docs/handler-contract.md` — `maxMs` typed as `number | undefined`; document the codergen
  exception.
- `docs/ARCHITECTURE.md` §3 if it claims every node has a wall-clock ceiling.
- `README.md` mention of `timeouts.codergen` (if present).
- `.agents/skills/swarm-author/SKILL.md` per-node attribute reference (cite that `max_ms` /
  `timeout` are optional on codergen and what happens when unset).

## Risks

- **Stuck codergen with broken cost reporting.** If the cost-tracking path silently fails, a
  runaway codergen has nothing to halt it. Mitigation: `max_tokens` is provider-reported and
  monotonic — it's the durable backstop. `max_cost_usd` is derived from tokens × per-model rate,
  so it's only as reliable as the rate. Worth a paragraph in the proposal's "what kills a
  codergen" section once specified.
- **Pause-on-provider-error already exists.** Network failures + 5xx pause the run with
  `reason: "provider_retry"`, not silent hangs. So "stuck waiting on the network" isn't a new
  failure mode this proposal introduces.
- **Operator visibility.** Today an operator sees `attemptedMs: 30m` in a halt fact and knows the
  bound. After this PR, no equivalent for codergen — they see `budget` halts with token / USD
  numbers instead. Acceptable: the numbers are more meaningful than a wall-clock ceiling anyway.

## Tests

- New: codergen handler can run past the configured `timeouts.codergen` (or with it absent) — no
  timeout halt.
- Regression: `tool` and `parallel` handlers still honour `maxMs`; their timeout paths unchanged.
- Regression: a steer / cancel / shutdown abort on a codergen with `maxMs: undefined` still aborts
  cleanly (the other signals in `AbortSignal.any` still work).

## Not in scope

- Adding a "max wall-clock" backstop with a much larger default (e.g. 24h). That's the workaround
  we're removing.
- Changing `tool` or `parallel` defaults.
- Per-workflow / per-class wall-clock budgets. Today operators can already set `max_ms` /
  `timeout` per-node; this PR keeps that escape hatch for the rare codergen that legitimately
  wants a ceiling.
