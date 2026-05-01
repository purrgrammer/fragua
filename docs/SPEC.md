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
queued → running → {completed, paused_hitl, paused_provider_error, paused_retry, halted, cancelled, quarantined}
          ▲            │
          └────── run_resumed (any paused_* → queued on intent.resume / intent.hitl_input / intent.unquarantine,
                              or wake-pending timer for paused_retry)
```

- `queued` — enqueued; ready to be claimed
- `running` — a daemon has claimed it and is dispatching handlers
- `paused_hitl` — a `wait.human` node yielded; `fact.run_paused_hitl` carries `label` + `options[]` (one per outgoing edge); awaits `intent.hitl_input { selected, note? }` or `intent.resume`
- `paused_provider_error` — an LLM provider returned a transport error (402, 429, 5xx, network); awaits `intent.resume`. Re-dispatches the same `(nodeId, iteration)` with the rehydrated transcript
- `paused_retry` — a node returned `outcomeStatus="retry"` and the engine scheduled a backoff window per attractor §3.5/§3.6; `fact.run_paused_retry` carries `{ nodeId, attempt, delayMs, resumeAt, maxRetries }`. The wake-pending sweeper emits `fact.run_resumed { fromStatus: "paused_retry" }` once `resumeAt` has elapsed; the run goes back to `queued` and the same node re-dispatches. **The slot is released during the wait — other queued runs can claim while this one sleeps.**
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

### 3.6 Edge selection

After a node completes, the executor picks the next edge from the source node's outgoing edges (attractor-spec §3.3). The five-step algorithm (`packages/core/src/engine/edge-selection.ts:60-124`) is:

1. **Condition** — among edges with a non-empty `condition`, evaluate each against the current outcome + routing. Among those that match, pick by weight (highest wins), then lexical tiebreak on `edge.to`.
2. **Preferred label** — among unconditional edges (no `condition`), first edge whose `label` normalises to `outcome.preferred_label` wins.
3. **Suggested next ids** — first unconditional edge whose target matches one of `outcome.suggested_next_ids` (in the order the outcome listed them) wins.
4. **Weight** — highest-weight unconditional edge.
5. **Lexical** — tiebreak by `edge.to` (lower wins).

**Fail-halt clarification.** When `outcome.status === "fail"` and step 1 produces no match, the executor halts the run with `fact.run_halted` instead of falling through to steps 2–5. Authors recovering from failure declare an explicit `condition="outcome=fail"` edge; absence of one is the halt signal. This is the swarm interpretation of attractor §3.7 step 1 ("fail edge: an outgoing edge with `condition=\"outcome=fail\"`"); the halt corresponds to attractor's "pipeline termination" (step 4) once `retry_target` / `fallback_retry_target` retargeting is exhausted.

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

---

## 6. Conscious divergences from attractor

swarm is *inspired by* the attractor specification (`attractor-spec.md`) — its DOT-as-workflow shape, deterministic state machine, pluggable handlers, and edge-routed control flow are taken directly. The deviations below are intentional, not lag: each one is a place attractor is incomplete, incorrect for production use, or addresses a concern swarm solves differently. Lint gaps and unimplemented attractor features are tracked separately in the per-decision docs at the repo root, not here.

### 6.1 Coordination & persistence

- **Checkpoint storage** (attractor §5.3 → swarm I1). Attractor prescribes `{logs_root}/checkpoint.json` after each node. swarm uses the event log + `run_state` projection updated in the same SQLite transaction. Filesystem coordination is forbidden by I1 — every workflow engine that has tried it bears the same stale-checkpoint scars.
- **Artifact addressing** (attractor §5.5 → swarm I8/I9). Attractor's `ArtifactStore.store(id, name, data)` is keyed by a single `id` that collides on retries and parallel branches. swarm scopes by `(run, node, iteration, key)` with sha256-addressed blobs; LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`).
- **Run directory layout** (attractor §5.6). swarm has none. SQLite is the only coordination surface.

### 6.2 Lifecycle & operator control

- **`paused_provider_error`** (extends attractor §3.1). Attractor models provider transport failures as either retryable-by-policy or terminal FAIL. Real operators need a third state: pause the run with the transcript intact, fix the API key / quota, then `intent.resume`. This state is first-class in swarm.
- **`quarantined`** (extends attractor §3.1). Attractor handwaves at-most-once for external side effects. swarm emits `side_effect_intent` before any external call and `side_effect_done|failed` after; the startup sweep quarantines runs whose intent has no terminal pair, awaiting `intent.unquarantine`.
- **`should_retry` shape** (attractor §3.6 underspecified → `non_retryable: boolean` on `Outcome`). Attractor's predicate is described in prose with no interface signature. swarm answers concretely: handlers set `non_retryable=true` on auth/4xx/validation errors at the boundary where the error class is known; the reducer treats it as terminal regardless of status.
- **Intent / fact dual taxonomy + OCC** (attractor §9.6 → I3). Attractor's observability is observer-only; it has no model of operator interventions. swarm splits `intent.*` (operator-initiated, always-appendable) from `fact.*` (engine-initiated, OCC-checked against `run_state.version`). `steer_requested` / `pause_requested` / `cancel_requested` / `hitl_input` / `unquarantine` / `resume` / `priority_changed` are all intents.

### 6.3 Naming

- **HTTP paths**: `/runs/...` and `/workflows/...` (not `/pipelines/...`). swarm splits *workflow* (source SHA) from *run* (one execution) — attractor conflates them. The split survives one-to-many naturally.
- **Event names**: snake_case (`run.started`, `node.completed`, `parallel.branch_started`). Attractor §9.6 uses PascalCase (`PipelineStarted`, `StageStarted`); the rest of the spec is snake_case. swarm normalises to one convention.
- **Diagnostic codes**: swarm validators emit `code` (e.g. `E001`, `W002`) alongside the rule name from attractor §7.2. Codes are stable through rule renames; rule names are searchable in spec text. Both ship in the `Diagnostic` shape.

### 6.4 Extensions (no attractor counterpart)

- **Budget primitives** — `budget_usd`, `max_cost_usd`, `budget_policy: warn|stop`, `max_tokens` on graph + node. Attractor has nothing on cost. Any spec for AI workflow orchestration that lacks budget primitives is incomplete; swarm enforces them at the executor.
- **Per-node agent config** — `system_prompt`, `allowed_tools`, `denied_tools`, `context_files`, `skills`, `skills_disabled`. Attractor §4.5 leaves codergen backend opaque. swarm surfaces these in workflow grammar so a `.dot` file fully specifies what the agent can do.
- **`<abort>` / `<promise>` prompt contract** — codergen handler's structured outcome markers in prompts; documented in `handler-contract.md`. Not orchestration but contract between workflow author and codergen handler.
- **`max_goal_gate_retries`** — per-run safety bound on the §3.4 goal-gate retarget chain (default 3). Attractor §3.4 step 4 is unbounded — a workflow whose `retry_target` itself fails forever loops. swarm caps it.
- **`$ARGUMENTS` substitution token** — expands to the run's `--input` text in node prompts. Attractor §9.2 specifies only `$goal`; `$ARGUMENTS` is the natural per-run-input counterpart and is the substitution most workflow authors reach for first.
- **`intent.steer` for free-text operator input on a running thread** — attractor's HITL surface (§4.6) is choice-only: the hexagon handler returns `human.gate.selected` (a key) and `human.gate.label`. `intent.steer` fills the free-text gap by injecting operator text into the current handler's transcript without compromising the canonical hexagon contract. Recommended path for "operator wants to clarify or redirect mid-run".

### 6.5 Deliberate omissions

- **`stack.manager_loop`** (attractor §4.11, `house` shape). Composition lives at the workflow level via separate runs sharing artifacts. swarm does not ship a supervisor-loop primitive.
- **`loop_restart` edge attribute** (attractor §2.7). Same rationale; loops are backward conditional edges bounded by `max_retries`.
- **`tool_hooks.pre` / `tool_hooks.post`** (attractor §9.7). The agent backend handles tool interception; not orchestration.
- **Interviewer pattern** (attractor §6). swarm replaces the question/answer Interviewer interface with `wait.human` nodes plus the `intent.hitl_input { selected, note? }` event. Different shape, same purpose.
