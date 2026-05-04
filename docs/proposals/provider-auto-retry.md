---
title: Auto-retry for transient LLM provider errors
summary: "Auto-retry for transient LLM provider errors"
status: shipped
maturity: specified
last-reviewed: 2026-05-02
---

# Auto-retry for transient LLM provider errors

> Today every LLM transport error (HTTP 402 / 429 / 5xx, network reset)
> pauses the run with `paused_provider_error` and waits for
> `intent.resume`. For interactive use this is reasonable; for unattended
> batch use it's a regression — a single 429 mid-run halts the whole
> batch.

## Shape

Two policy classes, partitioned by status:

| Status | Policy | Reason |
|---|---|---|
| 402 | manual (current) | balance / billing failure — auto-retry burns money on a busted account |
| 429 | auto with capped backoff | rate-limited; provider tells us when via `Retry-After` |
| 5xx | auto with exponential backoff | transient server error; bounded retries are well-understood |
| network reset (no status) | auto with conservative backoff | bounded retries |

Backoff: exponential with jitter. Cap at 5 attempts or 5 minutes total, whichever first. Honour `Retry-After` headers when present.

## Implementation

- The `pause_provider` handler return gains `policy: "manual" | "auto-retry"` and `nextAttemptAt: number | null`.
- The wake-pending sweeper reads `policy: "auto-retry"` and re-queues the run when wall-clock catches up to `nextAttemptAt` — reuses the [`paused_retry`](../ARCHITECTURE.md) wake path.
- New fact `fact.provider_retry_attempted { httpStatus, attempt, delayMs }` lands so the operator UI shows the retry chain.
- Final exhaustion → `fact.run_halted { reason: "provider_exhausted" }` (additive halt reason).

## Manual escape hatch preserved

`intent.resume` still wakes the run regardless of `policy`. Operators retain the ability to short-circuit the auto-retry wait or override an auto-stop on a problematic 5xx loop.

## Why now

Operationally the current state is "every 429 halts the batch." For unattended use — the obvious target for a CLI like swarm — this is non-viable. The fact / intent shapes already support it (per ARCH §1.10); only the executor's branching needs to change.

## Resolved decisions (shipped 2026-05-02 in `666de77`)

The 2026-05-02 brainstorm settled the design; what shipped:

- **State persistence:** `routing.internal.provider_retry.attempt` survives daemon restart and manual `intent.resume`. Wake timer lives on `routing.internal.auto_resume_at` — shared with `paused_retry` via a single sweep in `wake-pending.ts`.
- **Attempt counter on manual resume:** continue-chain. The cap (5 attempts, 5 cumulative minutes) bounds the run even across operator interventions; resets only on successful turn append.
- **4xx classification:** auto-retry on 408 / 429 / 500–504 / 529 / pre-response network; manual on 400 / 401 / 402 / 403 / 404 / 413 / 422.
- **`Retry-After` honoured exactly:** no cap, no jitter when present. Provider knows their state better than we do.
- **Backoff without `Retry-After`:** full-jitter exponential, base 1s, capped at 32s per attempt; 5 attempts / 5 cumulative minutes total.
- **Cardinality:** one `fact.provider_retry_attempted` per attempt (preserves I3 fact immutability).
- **Status taxonomy:** new `paused_provider_retry` status mirrors `paused_retry` so operators can filter auto-retrying runs cheaply by status alone.
- **Recoverable-pause unification:** consolidated `routing.internal.retry_resume_at` → `routing.internal.auto_resume_at` so both auto-resumable statuses share one sweep loop and one routing key.

## Open questions (deferred follow-ups)

These are remaining items from the brainstorm that didn't ship and earn their own slice when the appetite arrives.

- **402 default tightness.** Stays manual today. An explicit `--auto-retry-402` opt-in might earn its place once we see real workloads where billing-race transients are common enough to justify the risk of burning money on a busted account.

- **Provider-specific `Retry-After` quirks.** OpenAI sometimes uses `x-ratelimit-reset-after` instead of `Retry-After`, and the value is sometimes wildly conservative. Today we parse only `Retry-After` (case-insensitive); the rest fall through to our exponential backoff. Worth revisiting if a provider-specific issue bites.

- **Web UI retry-chain display.** A `paused_provider_retry` run currently shows up as "paused" in RunDetail. Operators see the chain only by reading the events. A small UI affordance (read the latest `fact.provider_retry_attempted`, render "auto-retrying, attempt 3 of 5, next try in 4s") would close the visibility gap.

- **Cost-attribution comment in code.** Auto-retry that fails before getting a response → no `cost.recorded` fires (cost-recording is response-driven). Worth a code comment in `provider-retry-policy.ts` so a future pi-ai upgrade doesn't break the invariant by accident.

## What this does not commit to

- **Custom backoff per project.** Hard-coded sensible defaults; a `timeouts.providerRetry` config layer is a natural follow-up but not required to ship.
- **Parsing provider-specific retry hints beyond `Retry-After`.** Out of scope; honor the standard header, ignore the rest.
- **Changing the manual default for 402.** Manual stays.
