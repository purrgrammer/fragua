---
title: Cap-overflow strategy
status: accepted
maturity: designed
last-reviewed: 2026-05-04
rationale: Introspect run 01kqsj2z28wv7sxdfh audit finding C5 — 1.41% of recent runs reached `run_state.routing` ≥ 80% of the 8 KB CHECK cap (peak observed 6,629 B = 80.9%). Hit rate exceeded the 1% alert threshold. Empirically validates this proposal's load-bearing claim that the 8 KB routing cap is the largest production exposure; promotes from sketch to a designed spill / compaction / typed-halt path.
---

# Cap-overflow strategy

> Today, hitting any of the four hard caps fails opaquely:
>
> - `events.payload` (4 KB) → silent truncation with marker payload + `console.warn`
> - `run_state.routing` (8 KB) → SQLite CHECK throws; run halts with `reason: "error"`
> - `messages.content` (1 MiB) → typed `MessageTooLargeError`, but no built-in spill — handler must reach for artifacts manually
> - `blobs` content (16 MiB) → typed `ArtifactTooLargeError`; no chunking story (deferred per ARCH §12)
>
> All four are correct as defences and wrong as UX. Production users will hit each.

## Shape

For each cap, three things to land:

1. **Typed observability event** so cap-hits show up in the run feed and analytics — not just a console line.
2. **Spill path** where applicable (routing → segmented spill or compaction; messages → built-in artifact spill).
3. **Pre-flight warning** at ≥75% of cap so authors notice before runs halt.

| Cap | Today | Proposed |
|---|---|---|
| `events.payload` 4 KB | silent truncation marker + `console.warn` | New observability event `payload.truncated { type, originalBytes }`; truncate as today. Pressure signal: see [`payload-pressure-signal.md`](./payload-pressure-signal.md) |
| `run_state.routing` 8 KB | SQLite throw → `fact.run_halted { reason: "error" }` | New halt reason `routing_overflow` carrying `currentBytes` + top-3 routing keys by byte cost; opt-in compaction of the `internal.*` + `budget_warned.*` namespaces; `swarm db inspect-routing <runId>` for cause attribution. Detail in §"Routing spill design" below. Pressure signal lives in [`payload-pressure-signal.md`](./payload-pressure-signal.md) |
| `messages.content` 1 MiB | `MessageTooLargeError` thrown to handler | Built-in spill: `messages.append(msg)` over the cap auto-stores content as an artifact (`(run, node, iteration, "messages.<ordinal>")`) and writes a sentinel message row. Handlers don't change. _Out of scope for the first implementation PR — routing is the demonstrated pressure point._ |
| `blobs` 16 MiB | `ArtifactTooLargeError` | Document chunking pattern in `handler-contract.md`; provide `ctx.artifacts.putChunked(key, stream)` helper that splits and indexes. _Out of scope for the first implementation PR — no observed pressure._ |

## Boundary with `payload-pressure-signal.md`

These two proposals overlap on the routing cap. The split:

- [**`payload-pressure-signal.md`**](./payload-pressure-signal.md) owns the **observability** leg for both `events.payload` and `run_state.routing` — the `daemon.payload_pressure { kind: "events" | "routing" }` event, the analytics tile, and the run-detail warning. Pure visibility; no behaviour change.
- **This proposal** owns the **runtime-behaviour** legs: typed halt reason on cap hit, opt-in compaction at the projection writer, and the operator CLI to attribute cause. Without this split both proposals would re-design `daemon.payload_pressure` and one would lose.

It also resolves one of `payload-pressure-signal.md`'s open questions — *"What counts as 'near-cap' for routing?"* — by definition: **current projection length, evaluated at projection-write time**, not aggregated across writes. The audit measured length at-rest; same definition.

## Routing spill design

The 8 KB routing cap is the biggest exposure. Routing accumulates per-node retry counters, `goal_gates.<id>` outcomes, `internal.retry_count.<id>`, `budget_warned` tags, `retry_resume_at`, fan_in winners, plus user-supplied keys. A 30-node workflow with several gates and one parallel fan-out will graze 8 KB. Today's failure mode is "SQLite CHECK fails, run halts with `reason: error`" — opaque to the operator and indistinguishable from a generic handler error.

The audit measured 1.41% of recent runs ≥ 80% of cap with peak 6,629 B (80.9%). One slightly-larger projection halts a run with no diagnostic context. The implementation PR lands four pieces:

### 1. Typed halt reason

Extend `HaltReason` (declared in `packages/types/src/swarm-events.ts:51`) with `routing_overflow`. The `fact.run_halted` payload carries:

```ts
{
  reason: "routing_overflow";
  detail?: string;
  currentBytes: number;       // length of the rejected serialised routing
  topKeys: Array<{ key: string; bytes: number }>;  // top 3 by JSON length
}
```

Adding the literal triggers the AGENTS.md ground-rule #1 same-PR obligations (ARCHITECTURE.md §3, the schema-CHECK doc reference, `swarm-debug` SKILL §8, `STATUS.md` "What swarm delivers today" if the new halt reason carries user-visible behaviour). The implementation PR owns those — this is a docs-only proposal-promotion PR.

### 2. Pre-flight check at the projection writer

The single point of routing writes is the projection in `packages/store/src/reducers.ts`. Before the `INSERT … ON CONFLICT … UPDATE` that touches `run_state.routing`, evaluate the would-be serialised length:

- `length < 0.75 × 8192` (6,144 B) — write as today.
- `0.75 × 8192 ≤ length < 0.9 × 8192` (6,144–7,372 B) — write as today; signal flows through `payload-pressure-signal.md`.
- `0.9 × 8192 ≤ length < 8192` (7,372–8,191 B) — apply opt-in compaction (§3); if post-compaction length still ≥ 8192, halt with `routing_overflow`.
- `length ≥ 8192` — apply compaction; if still ≥ 8192, halt with `routing_overflow` carrying `currentBytes` (post-compaction length) and `topKeys` (computed from the pre-compaction object).

The check stays inside the projection's transaction; it is pure SQL + deterministic JSON measurement, preserving I1 (no `await`, no I/O inside `db.transaction(...)`; enforced by `packages/store/test/lint.test.ts`). Compaction operates on the JS object before serialisation, so no extra round-trip.

### 3. Opt-in compaction whitelist

Compaction is **only** safe over keys whose loss does not change replay outcomes. The whitelist:

- **`internal.retry_count.<nodeId>`** — droppable once the node's terminal goal-gate outcome has been recorded in `goal_gates.<id>`. The retry counter served the gate; once the gate is decided, the counter is dead state.
- **`budget_warned.<scope>`** — droppable once a corresponding `intent.budget_adjusted` event lands (raises the cap, so the warning is stale).
- **`retry_resume_at`** — droppable once the resume timestamp is in the past relative to the projection clock (the resume already fired or was skipped).

Out of compaction scope (durable, must never be touched):

- Any user-supplied routing key (anything not under the `internal.*` / `budget_warned.*` / `retry_resume_at` namespaces).
- `goal_gates.<id>` outcomes — durable per ARCH §3.4.
- Fan_in winner records — needed for substitution `$<branchId>.output` resolution per the parallel-branch-outputs proposal.

Compaction runs in the same transaction as the projection write, single-pass, deterministic — same routing object + same projection state always yields the same compacted object. No clocks except the projection clock already present in the transaction.

### 4. Operator CLI: `swarm db inspect-routing <runId>`

`packages/cli/src/commands/db-inspect-routing.ts` (out of scope this PR). Reads `run_state.routing` for the given run; pretty-prints the JSON keys sorted by byte cost; flags which keys would be touched by compaction. Gives an operator landing on a halted run a one-shot answer to "what is consuming routing here?"

## What this does not commit to

- **Raising any cap.** The caps are correct constraints; this is about graceful degradation, not loosening invariants.
- **Replay-safety changes.** Compaction is a deterministic function of the routing object + the projection state. Truncation (events) is a deterministic function of input + cap.
- **Schema-level changes to routing.** Compaction is opt-in; the routing column stays a JSON blob.
- **Auto-spilling user-supplied routing keys.** If a workflow author writes >8 KB of their own keys, they hit the halt. The compaction whitelist covers framework-emitted state only.

## Open questions

- **Pre-flight thresholds.** 75% / 90% are picked to match the audit's alert threshold (≥80% caught the empirical near-miss). Could be configurable in `config.yaml` `caps.warnAt` / `caps.compactAt` if real workloads need different curves.
- **Truncation event volume.** If a workflow legitimately generates oversized observability events (e.g., a chatty backend), the truncation event will fire many times per run. Rate-limit per-(node, type) to avoid event-table churn.
- **Compaction interaction with replay.** A run replayed from `events` should yield the same projection. Compaction is keyed on observable projection state (gate outcomes, budget-adjusted events) — replay reproduces both, so compaction is replay-stable. Worth a dedicated test (`packages/store/test/routing-compaction-replay.test.ts`) in the implementation PR.
