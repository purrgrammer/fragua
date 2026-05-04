---
title: Throughput baseline + benchmark suite
status: proposed
maturity: specified
last-reviewed: 2026-05-01
---

# Throughput baseline + benchmark suite

> ARCH §13 risk #3: "SQLite write throughput ceiling — unknown until
> measured. ... Measure in M6." Never executed. Capacity claims
> ("comfortably below 1000 writes/sec", `MAX_CONCURRENT_RUNS = 8`) are
> nominal — no measurement-backed numbers anywhere in the repo.

## Shape

A `bun run bench:store` target plus a CI gate. Five primitive scenarios:

1. **Single-writer, append-fact only** — fresh DB, pure facts (no observability), 1 KB payload. Establishes the ceiling.
2. **Two-writer realistic mix** — daemon facts at ~100/s, web intents at ~10/s, OCC conflicts measured. Establishes the operational baseline.
3. **OCC conflict storm** — N daemons racing the same run. Should converge; measure conflict rate.
4. **Observability stream** — daemon-side append-burst at 1000 events/s for 60 s; measure WAL size and SSE consumer lag.
5. **Cap-near-miss** — payload at 95 % of cap repeatedly; measure write latency for the bounds-check path.

Each scenario produces a structured JSON output: writes/sec, p50/p95/p99 latency, OCC conflict rate, WAL bytes/s.

## CI gate

A nightly `bench:store` run that compares against a stored baseline (in `bench/baseline.json`). Regression > 20 % on any p95 → CI red; > 50 % on any throughput → CI red. Operators tune thresholds; the point is to catch unintended regressions in the store layer.

## Why this is load-bearing

Three reasons:

1. **Risk #3 has been "unknown until measured" for the entire pre-release window.** Measurement is the only way to know what the cap on concurrent runs really is.
2. **Doc claims need to be evidence-backed.** Today's "comfortably below 1000 writes/sec" is a guess; the eventual user reading ARCH should see a measurement, not a hedge.
3. **Regression detection.** The store is the foundation; a 2× write slowdown from an accidental schema or pragma change would propagate to every component.

## Open questions

- **Where to store the baseline.** `bench/baseline.json` checked in is simplest; will diff noisily in PRs that genuinely regress. Alternative: a separate baseline repo polled by CI.
- **Hardware variance.** CI hardware is not the user's hardware. Publish the CI baseline + a one-paragraph "what to expect on a M-series Mac" / "what to expect on a small VM" so users don't extrapolate from CI numbers.
- **Bench under WAL pressure.** A long-running test with several hundred MiB of WAL is more representative of real use than a fresh DB; needs a scenario for that.

## What this does not commit to

- **Multi-machine benchmarks.** Out of scope; single-machine is the deployment shape.
- **Real-LLM benchmarks.** The store is the contention surface; LLM latency is not the daemon's problem and varies with provider weather.
- **Continuous load testing in production.** Bench is CI-only; production deployments measure their own pressure via the existing observability stream.
