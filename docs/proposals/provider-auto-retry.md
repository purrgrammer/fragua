---
title: Auto-retry for transient LLM provider errors
status: proposed
maturity: designed
last-reviewed: 2026-05-02
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

The 2026-05-02 brainstorm surfaced new corners alongside the original three;
consolidated below.

- **State persistence across daemon restart.** `nextAttemptAt` and `attempt` need to survive a daemon restart mid-backoff so the wake-pending sweeper can read them. Means the values live on the persisted fact payload (`fact.run_paused_provider_error { policy, attempt, nextAttemptAt }`), not in executor memory. Same shape as `paused_retry`'s `routing.internal.retry_resume_at`. Confirm this is the right home.

- **Manual-resume attempt counter.** If the operator resumes manually after auto-retry attempt 3, then the next 429 hits — is that attempt 4 (continuing the chain) or attempt 1 (manual reset)? Manual resume signals the operator believes the underlying issue is transient, which argues for reset. Open until the first real workload surfaces a preference.

- **4xx enumeration.** The Shape table covers 402 / 429 / 5xx / network. Silent on 401 / 403 / 404 / 408 / 422. Provisional reads: 401 / 403 / 404 / 422 stay manual (auth/perm rotated, model gone, schema mismatch — none auto-retryable); 408 (request timeout) gets auto-retry like network reset. Lock these down before queueing.

- **`Retry-After` longer than the cap.** Provider says `Retry-After: 3600`; cap says 5 min total. Three options: (a) cap wins, halt with `provider_exhausted`; (b) header wins, pause longer than the cap allows; (c) honour the header but past the cap fall through to manual `paused_provider_error`. (c) feels right — operator decision past the documented limit — but pin it.

- **Interaction with `paused_budget`.** Once [`recoverable-budget-pause`](./recoverable-budget-pause.md) ships: a run is over per-run cost cap AND just got a 429. Budget is checked at turn boundary; the 429 happens during the turn. So 429 → auto-retry pause → next attempt fires → turn boundary → budget pause. Cleanly composes; one-line note in the Shape section once both ship.

- **Cardinality of `provider_retry_attempted` facts.** 5 retries × N paused runs × M providers = many fact rows. Two shapes: (a) one fact per attempt — simple, queryable, transparent; (b) fold into `fact.run_paused_provider_error.attempts[]` — denser but mutates payload, violating fact immutability. (a) is the only consistent answer; flagged here so it doesn't drift.

- **Tightness of the manual default for 402.** A 402 *can* be transient (provider quota race conditions). Default stays manual to avoid burning money on real billing failures, but an explicit `--auto-retry-402` opt-in might earn its place once we see real workloads.

- **Provider-specific `Retry-After` quirks.** OpenAI's `Retry-After` is sometimes wildly conservative; some providers don't send it at all; Anthropic uses `retry-after`; OpenAI sometimes uses `x-ratelimit-reset-after` instead. Honour the standard header when present, fall back to our backoff when absent — but the parser needs care.

- **Test fixture shape.** Mock pi-ai's transport layer to inject 429 / 5xx / network reset deterministically, or run against a fake HTTP server? Plan agent should propose; the answer affects how flaky the suite ends up.

## What this does not commit to

- **Custom backoff per project.** Hard-coded sensible defaults; a `timeouts.providerRetry` config layer is a natural follow-up but not required to ship.
- **Parsing provider-specific retry hints beyond `Retry-After`.** Out of scope; honor the standard header, ignore the rest.
- **Changing the manual default for 402.** Manual stays.
