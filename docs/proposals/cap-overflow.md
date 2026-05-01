---
title: Cap-overflow strategy
status: proposed
maturity: sketch
last-reviewed: 2026-05-01
---

# Cap-overflow strategy

> Today, hitting any of the four hard caps fails opaquely:
>
> - `events.payload` (4 KB) → silent truncation with marker payload + `console.warn`
> - `run_state.routing` (8 KB) → SQLite CHECK throws; run halts with `reason: "error"`
> - `messages.content` (1 MiB) → typed `MessageTooLargeError`, but no built-in spill — handler must reach for artifacts manually
> - `blobs` content (16 MiB) → typed `ArtifactTooLargeError`; no chunking story (deferred per ARCH §13)
>
> All four are correct as defences and wrong as UX. Production users will hit each.

## Shape

For each cap, three things to land:

1. **Typed observability event** so cap-hits show up in the run feed and analytics — not just a console line.
2. **Spill path** where applicable (routing → segmented spill or compaction; messages → built-in artifact spill).
3. **Pre-flight warning** at ≥75% of cap so authors notice before runs halt.

| Cap | Today | Proposed |
|---|---|---|
| `events.payload` 4 KB | silent truncation marker + `console.warn` | New observability event `payload.truncated { type, originalBytes }`; truncate as today |
| `run_state.routing` 8 KB | SQLite throw → `fact.run_halted { reason: "error" }` | New halt reason `routing_overflow` carrying `currentBytes`; pre-flight warn at 75%; `swarm db inspect-routing <runId>` to surface the largest keys; optional opt-in compaction (drop pre-§3.4 retry counters once the gate retargeting succeeded) |
| `messages.content` 1 MiB | `MessageTooLargeError` thrown to handler | Built-in spill: `messages.append(msg)` over the cap auto-stores content as an artifact (`(run, node, iteration, "messages.<ordinal>")`) and writes a sentinel message row. Handlers don't change |
| `blobs` 16 MiB | `ArtifactTooLargeError` | Document chunking pattern in `handler-contract.md`; provide `ctx.artifacts.putChunked(key, stream)` helper that splits and indexes |

## Why this is load-bearing

The 8 KB routing cap is the biggest exposure. Routing accumulates per-node retry counters, `goal_gates.<id>` outcomes, `internal.retry_count.<id>`, `budget_warned` tags, `retry_resume_at`, fan_in winners, plus user-supplied keys. A 30-node workflow with several gates and one parallel fan-out will graze 8 KB. Today's failure mode is "SQLite CHECK fails, run halts with `reason: error`" — opaque to the operator and indistinguishable from a generic handler error.

The 1 MiB message cap is real for long agent turns: pi-agent-core can produce thinking + multiple tool_use blocks that approach the cap on a single turn. The handler-contract says "spill to artifacts" but that's a contract on the handler, not the framework.

## Open questions

- **Auto-compaction safety.** Dropping `internal.retry_count.<nodeId>` after a goal gate succeeded is reasonable, but there's no taxonomy of which routing keys are durable vs ephemeral. The `internal.*` namespace is one heuristic; a structured schema for routing keys is cleaner but bigger.
- **Pre-flight thresholds.** 75% is a guess. Could be configurable in `config.jsonc` `caps.warnAt`.
- **Truncation event volume.** If a workflow legitimately generates oversized observability events (e.g., a chatty backend), the truncation event will fire many times per run. Rate-limit per-(node, type) to avoid event-table churn.

## What this does not commit to

- **Raising any cap.** The caps are correct constraints; this is about graceful degradation, not loosening invariants.
- **Replay-safety changes.** Truncation is a deterministic function of input + cap.
- **Schema-level changes to routing.** Compaction is opt-in; the routing column stays a JSON blob.
