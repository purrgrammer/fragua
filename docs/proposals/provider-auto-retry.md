---
title: Auto-retry for transient LLM provider errors
status: proposed
maturity: specified
last-reviewed: 2026-05-01
---

# Auto-retry for transient LLM provider errors

> Today every LLM transport error (HTTP 402 / 429 / 5xx, network reset)
> pauses the run with `paused_provider_error` and waits for
> `intent.resume`. For interactive use this is reasonable; for unattended
> batch use it's a regression — a single 429 mid-run halts the whole
> batch.
>
> Currently a one-line item in `docs/PENDING.md`; this promotes it to a
> proper design.

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

## Open questions

- **Tightness of the manual default for 402.** A 402 *can* be transient (provider quota race conditions). Default stays manual to avoid burning money on real billing failures, but an explicit `--auto-retry-402` opt-in might earn its place once we see real workloads.
- **Logging of retry attempts.** Should retries fold into one `fact.run_paused_provider_error` with a chain of attempts, or be separate facts? Separate facts are simpler; chain folding is denser. Start with separate.
- **Provider-specific quirks.** OpenAI's `Retry-After` is sometimes wildly conservative; some providers don't send it at all. Honor when present, fall back to our backoff when absent.

## What this does not commit to

- **Custom backoff per project.** Hard-coded sensible defaults; a `timeouts.providerRetry` config layer is a natural follow-up but not required to ship.
- **Parsing provider-specific retry hints beyond `Retry-After`.** Out of scope; honor the standard header, ignore the rest.
- **Changing the manual default for 402.** Manual stays.
