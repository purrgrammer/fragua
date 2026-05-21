---
name: backend
description: Server-side patterns for packages/server, packages/store, packages/core, packages/agent. Load this skill before writing or modifying any .ts under those packages — adapters, route handlers, store methods, queries, reducers, daemon code, agent backends. Encodes SQL aggregations over in-memory event folding, per-module <domain>-queries.ts files in packages/store/src/ as the single audit point for every SQL statement, store-layer access via IEventStore (no raw db handles in routes), reducer purity (no clocks, no I/O), event-store invariants (4KB payload cap, seq monotonicity, observability events skip the reducer), and Hono route shape. Pair with the `postmortem` skill when the change touches replay or post-mortem behavior.
---

# Backend code patterns

*Aggregations live in SQL. Queries live in `<domain>-queries.ts` (`packages/store/src/`). Reducers stay pure. The store keeps its own house.*

Foundational patterns only. If a situation isn't covered here, derive it from the principles.

---

## Principles (earlier wins on conflict)

1. **Aggregations belong in SQL.** Sums, counts, max/min, grouped totals — never `.reduce()` over `getEvents(runId, { limit: BIG })`. SQL has the planner, the indexes, and one source of truth. In-memory folding is only correct when the projection is fundamentally non-aggregatable (a list of message blocks, a finalText built from streaming deltas, etc.). When you see a TypeScript loop accumulating a number, replace it with a query.
2. **SQL lives in `<domain>-queries.ts`, not in handlers.** Every named query gets a function in the matching `packages/store/src/<domain>-queries.ts` (one of: `analytics`, `artifact`, `daemon`, `event`, `message`, `provider-config`, `provider-credentials`, `run-state`, `schedule`, `workflow`). Route handlers and adapters in `packages/server` import named functions from `@fragua/store`; they never inline `db.prepare("SELECT …")`. The queries files are the audit point for what the database is asked, and the only place a column rename has to land.
3. **Reducers are pure.** `applyFact` and `eventsToSteps` style folders take inputs, return outputs, and never read clocks, fetch the network, or mutate globals. Same input ⇒ same output, every time. They're called from tests AND production with the same contract.
4. **The store guards its own invariants.** `IEventStore` enforces seq monotonicity, the 4KB payload cap, expected-version concurrency, and CASCADE on run deletion. Callers don't reimplement those checks. If you need a new invariant, push it into `store.ts` (not into a route handler).
5. **Observability events skip the reducer.** `appendObservabilityEvents` (`agent.*`, `llm.*`, `tool.*`, `cost.recorded`) shares the seq space but does NOT bump `run_state.version` and does NOT require `expectedVersion`. Handlers can emit them mid-step without racing the terminal `appendFact`.
6. **No silent caps.** `getEvents(runId, { limit: 5000 })` quietly drops late events. If you reach for a limit, prove the output is bounded a different way (e.g. filtering to one event type via the index) — otherwise pass `Number.MAX_SAFE_INTEGER` and let SQLite stream.
7. **Hono routes are thin.** A route validates input, calls one or two store/adapter functions, returns JSON. Business logic lives in adapters or a `<domain>-queries.ts`. If a route file grows past ~150 lines it's hiding logic that wants to move down a layer.

---

## SQL aggregations: the rule and the shape

### The rule

If a number on the wire (`costUsd`, `inputTokens`, `eventCount`, `nRunsByStatus`, anything) needs to be a sum or a count, the sum or count happens in SQLite, not in TypeScript.

```ts
// ❌ Wrong — folds in TS, breaks the moment any event is dropped
const events = store.getEvents(runId, { limit: Number.MAX_SAFE_INTEGER });
let totalCost = 0;
for (const e of events) {
  if (e.type === "cost.recorded") {
    const p = e.payload as { cost_usd?: number };
    if (typeof p.cost_usd === "number") totalCost += p.cost_usd;
  }
}

// ✅ Right — one indexed scan, planner-optimised
const totalCost = sumCostUsd(db, runId);
```

### The shape

Every named query is a function in the matching `<domain>-queries.ts` under `packages/store/src/`:

```
packages/store/src/
  analytics-queries.ts    ← cross-run rollups (run counts by status, totals)
  artifact-queries.ts     ← artifact blob lookups
  daemon-queries.ts       ← supervisor / executor coordination reads
  event-queries.ts        ← event log reads (getEvents, type-filtered scans)
  message-queries.ts              ← messages table (uncapped LLM content)
  provider-config-queries.ts      ← per-provider config rows (provider_config table)
  provider-credentials-queries.ts ← per-provider credential rows (provider_credentials table; api_key | oauth)
  run-state-queries.ts            ← per-run projections + aggregations (owns getStepAggregates)
  schedule-queries.ts     ← schedule + run-of-schedule reads
  workflow-queries.ts     ← workflow registry reads
packages/server/src/store/
  routes.ts               ← Hono handlers — never embed SQL, import from @fragua/store
  runs-routes.ts          ← Hono handlers — never embed SQL
  runs-adapter.ts         ← projects rows into RunSummary / RunDetail
  steps.ts                ← reducer for non-aggregatable step fields
```

Each `<domain>-queries.ts` exports plain functions that take a `Database` and the parameters, and return rows. They own the SQL strings — nothing else does.

```ts
// packages/store/src/run-state-queries.ts
import type { Database } from "bun:sqlite";

export interface StepAggregateRow {
  startSeq: number;
  startTs: number;
  nodeId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billedTokens: number;
  costEventCount: number;
  endedAtMs: number | null;
  stopReason: string | null;
}

const STEP_AGGREGATES_SQL = `
  WITH starts AS (
    SELECT
      seq,
      ts,
      json_extract(payload, '$.nodeId') AS node_id,
      LEAD(seq) OVER (
        PARTITION BY json_extract(payload, '$.nodeId')
        ORDER BY seq
      ) AS next_seq
    FROM events
    WHERE run_id = ?1 AND type = 'llm.start'
  )
  SELECT
    s.seq                                                                         AS startSeq,
    s.ts                                                                          AS startTs,
    s.node_id                                                                     AS nodeId,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cost_usd')           AS REAL))   , 0) AS costUsd,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.input_tokens')       AS INTEGER)), 0) AS inputTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.output_tokens')      AS INTEGER)), 0) AS outputTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cache_read_tokens')  AS INTEGER)), 0) AS cacheReadTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.cache_write_tokens') AS INTEGER)), 0) AS cacheWriteTokens,
    COALESCE(SUM(CAST(json_extract(c.payload, '$.total_tokens')       AS INTEGER)), 0) AS billedTokens,
    COUNT(c.seq)                                                                  AS costEventCount,
    (
      SELECT MAX(d.ts) FROM events d
      WHERE d.run_id = ?1
        AND d.type   = 'llm.done'
        AND json_extract(d.payload, '$.nodeId') = s.node_id
        AND d.seq    > s.seq
        AND (s.next_seq IS NULL OR d.seq < s.next_seq)
    )                                                                             AS endedAtMs,
    (
      SELECT json_extract(d.payload, '$.stop_reason') FROM events d
      WHERE d.run_id = ?1
        AND d.type   = 'llm.done'
        AND json_extract(d.payload, '$.nodeId') = s.node_id
        AND d.seq    > s.seq
        AND (s.next_seq IS NULL OR d.seq < s.next_seq)
      ORDER BY d.seq DESC
      LIMIT 1
    )                                                                             AS stopReason
  FROM starts s
  LEFT JOIN events c
    ON c.run_id = ?1
   AND c.type   = 'cost.recorded'
   AND json_extract(c.payload, '$.nodeId') = s.node_id
   AND c.seq    > s.seq
   AND (s.next_seq IS NULL OR c.seq < s.next_seq)
  GROUP BY s.seq, s.ts, s.node_id
  ORDER BY s.seq
`;

export function getStepAggregates(db: Database, runId: string): StepAggregateRow[] {
  return db.query<StepAggregateRow, [string]>(STEP_AGGREGATES_SQL).all(runId);
}
```

Notes:
- The query is a constant string at module top — easy to copy into `sqlite3` for verification.
- The function returns typed rows shaped as the consumer expects (camelCase, sums coalesced to 0, not null).
- The window is `(prev_llm.start, next_llm.start_for_same_node)` — that's the correct step boundary for `cost.recorded` events. One `llm.start` opens the step; multiple `message_end → cost.recorded` events fire inside it on tool-using turns; `endedAtMs` and `stopReason` come from the LAST `llm.done` in the window.
- Filter by `run_id` first (indexed), then by `type` (indexed via `idx_events_type`), then JSON-extract `nodeId` last.

### Tests for queries

Aggregation queries get unit tests with realistic event interleaving. The minimum bar:

- empty input → empty / zero result
- one `llm.start` with one `cost.recorded` → that cost
- one `llm.start` with `cost.recorded` AFTER `llm.done` → still counted (this is the actual agent flow)
- multiple `cost.recorded` events under one `llm.start` → summed
- two `llm.start` events for the same nodeId (loop iteration) → costs split correctly
- interleaved nodes (`A.start, B.start, A.cost, B.cost`) → costs go to the right node
- `cost.recorded` for a synthetic node (summariser) without an `llm.start` → not in step output (but visible to a separate run-totals query)

Run them against a real `:memory:` SQLite — the migrate step and JSON-extract behavior must be exercised.

---

## Reducers vs queries — when each applies

| Need | Approach | Why |
|---|---|---|
| Sum of `cost_usd` per step | `queries.ts` | Aggregation, indexable |
| Step's `prompt`, `system_prompt`, `messages[]`, `context_files[]` | TS extract from `llm.start.payload` | Single-row field access; no aggregation |
| `finalText` built from `llm.text_delta` deltas | TS reducer | Order-dependent string concat; SQLite GROUP_CONCAT order is not guaranteed |
| Per-status run counts (`/health`) | `queries.ts` (`COUNT(*) … GROUP BY status`) | Aggregation |
| Token totals on `RunSummary` | `run_state.metrics` generated columns | Already in SQL; never re-derive |
| Latest `node_completed` per node | `queries.ts` (`MAX(seq) … GROUP BY nodeId`) | Aggregation |
| List of all events, raw, for a run | `store.getEvents(runId)` | Not aggregation; use the store API |

A useful sanity check: if your TS code calls `.reduce()` on an array longer than `O(steps)`, you almost certainly want SQL.

---

## Store layer (`packages/store`)

### Routes don't touch `db`

Hono routes get a `store: IEventStore` (or a higher-level adapter). They call store methods and adapter functions. They do not import `bun:sqlite`. If a new query is needed, it goes in the matching `packages/store/src/<domain>-queries.ts` and is imported from `@fragua/store`. Intrinsic store invariants (seq monotonicity, payload cap, expectedVersion) live in `store.ts` itself.

### Schema is `STRICT`

Every table is `STRICT, WITHOUT ROWID` (where applicable). New columns are added via `migrations.ts` with an idempotent `ALTER TABLE … ADD COLUMN` guarded by `PRAGMA user_version`. Generated columns (e.g. `total_cost_usd`) avoid the JSON-extract round-trip on read; reach for them when a value will be read more often than it changes.

### Observability vs facts

```
appendFact         → bumps version, runs the reducer, requires expectedVersion
appendIntent       → idempotent, dedup'd by idempotency_key
appendObservabilityEvents → does NOT bump version, NO expectedVersion, NO reducer
```

If you're wiring a new event type, decide which lane it's on **before** writing code. `cost.recorded` and `llm.*` are observability — they describe what happened but don't change the state machine. `node_completed` is a fact — it advances the run.

### Payload cap

Observability event payloads are capped at 4KB (`length(payload) < 4096`). Oversized payloads are replaced with `truncationMarker(...)` which preserves routing fields (`nodeId`, `iteration`, `content_index`, plus `provider`, `model`, `summary`, `thread_id` for `llm.start`). Full LLM content is reconstructable from the `messages` table (uncapped). When you add a high-value, low-bytes field to an observability event, also add it to the truncation marker — otherwise it will randomly disappear on long prompts.

---

## Hono route shape

```ts
app.get("/runs/:id/steps", (c) => {
  const runId = c.req.param("id");
  if (store.getState(runId) == null) {
    return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
  }
  return c.json(buildStepSnapshots(store, runId));
});
```

- One existence check, one delegation. The route doesn't know the schema.
- 404 payload uses `{ error, code, details }` — that's the project's error envelope.
- Aggregations go through the matching `<domain>-queries.ts` in `@fragua/store`; non-aggregations go through an adapter (`runs-adapter.ts`, `runStateToSummary`, etc.).

---

## Anti-patterns (caught in review)

- `let total = 0; for (const e of events) total += e.payload.cost_usd` — folding what SQL can sum.
- `db.prepare("SELECT …").all()` inside a route handler or adapter — SQL outside a `<domain>-queries.ts` in `@fragua/store`.
- `getEvents(runId, { limit: 5000 })` to "save memory" on a derivation that needs all events — silent data loss.
- A reducer that calls `Date.now()`, `crypto.randomUUID()`, `fetch()`, or imports `process` — not pure.
- A new event type that emits via `appendFact` but doesn't change `run_state.version` — picked the wrong lane.
- A column added to schema.sql with no migration entry — fresh DBs work, existing ones drift.

---

## Checklist before merging a server change

- [ ] Every numeric total on the wire comes from a SQL aggregation, not a TS fold.
- [ ] Every SQL statement lives in the matching `<domain>-queries.ts` under `packages/store/src/`, named, exported, typed.
- [ ] New aggregation queries have unit tests against `:memory:` covering empty / single / multi / interleaved / iteration cases.
- [ ] Routes are thin — no SQL, no large reducers inline.
- [ ] If you added an observability field that consumers depend on, you also added it to the truncation marker.
- [ ] If you added a fact event type, you bumped reducer logic AND the event taxonomy in `packages/types`.
- [ ] `bun run --filter='@fragua/<pkg>' typecheck` clean. Schema changes have a migration.
