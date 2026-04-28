# swarm — Specification

> What swarm **is**. For design detail see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for writing handlers see [`handler-contract.md`](./handler-contract.md).

---

## 1. Vision

**swarm** is a universal AI agent orchestrator. It takes a text-first declarative workflow (Graphviz DOT), executes it through a deterministic state machine that drives LLM-based agents across any provider, and produces a complete, replayable audit trail.

Core values, in priority order:

1. **Simple** — small number of primitives, obvious composition
2. **Testable** — pure core, first-class simulation, bit-identical replay
3. **Observable** — every state transition is a typed event in one durable log
4. **Flexible** — swap providers, models, environments, UIs without touching workflow logic
5. **Efficient** — reuses mature libraries (`pi-ai`, `pi-agent-core`) instead of rebuilding the stack

**Non-goals:**
- Not a data-engineering orchestrator (Airflow / Dagster / Prefect territory)
- Not a cloud-scale workflow service (Temporal territory)
- Not a chat framework (LangChain territory)
- Not a replacement for Claude Code or Codex — it *drives* them

---

## 2. System shape

Single machine, two processes, one SQLite database.

```
┌────────────────┐                 ┌──────────────┐
│  swarm daemon  │ ──────────────▶ │              │
│  (executor +   │ ◀────────────── │   SQLite     │
│  supervisor)   │    facts /      │  .swarm/     │
└────────────────┘    reads        │  swarm.db    │
                                   │              │
┌────────────────┐                 │  (WAL mode,  │
│  swarm serve   │ ◀────────────── │   single     │
│  (HTTP + SSE)  │ ──────────────▶ │   coord.     │
└────────────────┘    intents /    │   surface)   │
                      reads        └──────────────┘
       ▲
       │  HTTP + SSE
       ▼
┌────────────────┐
│  Web UI / CLI  │
└────────────────┘
```

- **Daemon** runs the executor fiber + a 50ms supervisor fiber (heartbeat + intent detection + watchdog). Writes **facts** under OCC.
- **Server** exposes a Hono HTTP surface. Writes **intents** (always appendable, no OCC). Reads go straight to the store's projection.
- **CLI** wraps both via `swarm daemon`, `swarm serve`, `swarm run`, `swarm db`.
- **Store** (`@swarm/store`) is the only coordination surface. WAL-mode SQLite; both processes read and write.

---

## 3. Primitives

### 3.1 Workflows
A workflow is a Graphviz DOT graph. Each node has a shape that maps to a handler kind:

| Shape | Handler kind |
|---|---|
| `Mdiamond` | `start` |
| `Msquare` | `exit` |
| `box` | `codergen` (LLM call) |
| `diamond` | `conditional` |
| `hexagon` | `wait.human` |
| `parallelogram` | `tool` (graph-level shell step) |
| `component` | `parallel` |
| `tripleoctagon` | `parallel.fan_in` |

Loops are **backward conditional edges** bounded by `max_retries` on the
target node (attractor-spec §3.6 / §5.2) — there is no `loop` primitive.
A node that should re-run on `outcome=retry` takes an edge back to itself
or to an upstream node with `[condition="outcome=retry"]`, and its
`max_retries` attribute caps how many times the retry counter can bump
before the run halts with `reason=max_retries_exceeded`.

Workflows are uploaded via `POST /workflows { name, dotSource }` which returns a `sha` (sha256 of the source). Runs reference workflows by sha.

### 3.2 Handlers
A handler is a pure async function `(ctx: HandlerContext) => Promise<HandlerResult>`. Its I/O routes through `ctx`: `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.messages`, `ctx.artifacts`, `ctx.externalCall`. Handlers may not import `node:fs`, `node:child_process`, or call bare `fetch` — enforced by lint.

See [`handler-contract.md`](./handler-contract.md).

### 3.3 Events
Two kinds, both in the same `events` table:

- **Intents** (`intent.*`) — written by the web server on behalf of operators. No OCC. Always appendable.
- **Facts** (`fact.*`) — written by the daemon as state transitions. OCC-checked against `run_state.version`.

Event log is the source of truth; the `run_state` row is the materialized projection, updated in the same transaction as the event append.

### 3.4 Run lifecycle

```
queued → running → {completed, paused_hitl, paused_provider_error, halted, cancelled, quarantined}
          ▲            │
          └────── run_resumed (any paused_* → queued on intent.resume / intent.hitl_input / intent.unquarantine)
```

- `queued` — enqueued; ready to be claimed
- `running` — a daemon has claimed it and is dispatching handlers
- `paused_hitl` — a `wait.human` node yielded; `fact.run_paused_hitl` carries `label` + `options[]` (one per outgoing edge); awaits `intent.hitl_input { selected, note? }` or `intent.resume`
- `paused_provider_error` — an LLM provider returned a transport error (402, 429, 5xx, network); awaits `intent.resume`. Re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript
- `completed` / `halted` / `cancelled` — terminal
- `quarantined` — startup sweep found an orphan `side_effect_intent` without a matching `done`/`failed`; awaits `intent.unquarantine`

### 3.5 Control plane
All operator actions are intent writes:

- `POST /runs/:id/steer` — inject text; aborts current handler so next dispatch sees the steering
- `POST /runs/:id/pause` — abort + transition to `paused_hitl`
- `POST /runs/:id/cancel` — abort + transition to `cancelled`
- `POST /runs/:id/hitl` — deliver `{ selected: string, note?: string }`; wakes `paused_hitl` runs; `selected` must be an accelerator key from `fact.run_paused_hitl.options`
- `POST /runs/:id/resume` — generic wake for any `paused_*` run (no payload required)
- `POST /runs/:id/unquarantine` — operator decision on a quarantined run

---

## 4. Contracts (the invariants)

| # | Invariant |
|---|---|
| **I1** | Every write is one SQLite transaction; events + projection updated together |
| **I2** | No handler state outside the projection |
| **I3** | Intents always-appendable; facts OCC-checked |
| **I4** | Handlers receive `AbortSignal`; respecting it is contract |
| **I5** | External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay |
| **I6** | `run_state.routing` ≤ 8KB; payload lives in messages/artifacts |
| **I7** | Event payloads ≤ 4KB |
| **I8** | Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)` |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`) |
| **I10** | Seq assignment is O(1) via per-run counter; never scanned |

Enforced by structural lints (`packages/store/test/lint.test.ts`, `packages/core/test/handler/discipline.test.ts`) and a 24-entry property-test matrix ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §10).

---

## 5. Non-goals for this scope

- **Multi-machine deployment.** Everything assumes one machine, one SQLite file. Replace the store with a Postgres implementation of `IEventStore` later if needed.
- **Blob encryption.** Single-user local tool; DB read = full read anyway.
- **Auto-migration of schema drift.** Runs pin a `schema_version`; mismatches halt rather than auto-upgrade.
- **Workflow hot-reload.** `workflow_sha` is pinned at enqueue time.
