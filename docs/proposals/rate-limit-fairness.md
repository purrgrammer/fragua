---
title: Rate-limit fairness
status: deferred
maturity: sketch
last-reviewed: 2026-05-01
rationale: Defer until felt. In single-project mode, the budget cost cap covers the use case.
---

# Rate-limit fairness

> Deferred until a multi-project user actually feels the bug. In
> single-project mode, the [budget cost cap](./budget-controls.md)
> covers the use case; picking a fair-share algorithm before there's
> real load to measure means picking blind.

## The problem

One provider key serving five projects: project A's burst stalls
project B mid-deploy, because the rate limit is per-key, not
per-project. The provider's bucket fills first-come-first-served; one
hot project starves the others.

## The shape

Layer per-project token buckets *over* the per-key bucket in the rate
limiter:

```jsonc
"providers": {
  "openai": {
    "rateLimit": {
      "perProjectShare": "even"
    }
  }
}
```

Admission check happens in the supervisor before dispatching an
LLM-issuing node — same place as the [budget cost
cap](./budget-controls.md).

## Open questions

- **Default share is hard.** "Even split" punishes the project doing
  real work in favor of the dormant one. Other candidates: per-project
  max with the provider key just enforced; first-come-first-served with
  a soft cap; weighted fair queueing.
- **Burstiness**: token-bucket-over-token-bucket has well-known
  pathologies when both layers are configured tightly. Need real
  numbers from a multi-project workload before picking parameters.
- **Failure mode**: when a project hits its share, does the run pause
  (`paused_provider_error`) or queue? The budget answer is pause; the
  fairness answer might be queue, since it's a transient share, not a
  hard cap.

## Why defer

The algorithm is genuinely hard scheduler work. Every reasonable
answer has trade-offs that only matter under multi-project load — load
that doesn't exist until the [harness](./harness.md) ships and people
actually use it. Picking now means picking blind.

The [budget cost cap](./budget-controls.md) covers single-project
users fully. Defer until a multi-project user reports the bug.
