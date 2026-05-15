# swarm — Specification

> What swarm **is**. For design detail see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for writing handlers see [`handler-contract.md`](./handler-contract.md).

---

## 1. Vision

**swarm** is a universal AI agent orchestrator. It takes a text-first declarative workflow (Graphviz DOT), executes it through a deterministic state machine that drives LLM-based agents across any provider, and produces a complete, replayable audit trail.

Core values, in priority order:

1. **Simple** — small number of primitives, obvious composition.
2. **Testable** — pure core, first-class simulation, deterministic replay of the control plane (state machine, intent fold, edge selection). LLM bodies are best-effort and depend on provider determinism (see ARCH §1.11).
3. **Observable** — every state transition is a typed event in one durable log.
4. **Flexible** — swap providers, models, environments, UIs without touching workflow logic.
5. **Efficient** — reuses mature libraries (`pi-ai`, `pi-agent-core`) instead of rebuilding the stack.

**Non-goals:**

- Not a data-engineering orchestrator (Airflow / Dagster / Prefect territory).
- Not a cloud-scale workflow service (Temporal territory).
- Not a chat framework (LangChain territory).
- Not a replacement for Claude Code or Codex — it *drives* them.

---

## 2. System shape

Single machine, one harness process, one SQLite database. The harness supervises a daemon subprocess and an in-process HTTP server against `~/.swarm/swarm.db`.

```
┌──────────────────────────────────┐
│            swarm harness         │      ┌───────────────┐
│  ┌───────────────────────────┐   │      │               │
│  │ daemon subprocess         │ ──┼─────▶│   SQLite      │
│  │ (executor + supervisor)   │ ◀─┼──────│  ~/.swarm/    │
│  └───────────────────────────┘   │      │  swarm.db     │
│  ┌───────────────────────────┐   │      │               │
│  │ HTTP + SSE (in-process)   │ ◀─┼──────│  WAL,         │
│  │ default :6767             │ ──┼─────▶│  single coord │
│  └───────────────────────────┘   │      │  surface      │
└────────────────┬─────────────────┘      └───────────────┘
                 │  HTTP + SSE
                 ▼
        ┌────────────────┐
        │  Web UI / CLI  │
        └────────────────┘
```

- **Harness** (`swarm harness`) is the default entry point: foreground process that spawns the daemon as a subprocess and runs the HTTP server in-process. Publishes its URL on `daemon_lock.{http_url, http_port, harness_version}` so CLIs discover it via the DB itself. SIGINT clears the URL columns on the way out.
- **Daemon** runs the executor fiber + a 50ms supervisor fiber (heartbeat + intent detection + watchdog). Writes **facts** under OCC.
- **Server** exposes a Hono HTTP surface. Writes **intents** (always appendable, no OCC). Reads go straight to the store's projection.
- **CLI** wraps everything via `swarm harness` (default), `swarm run`, `swarm validate`, `swarm db`. `swarm daemon --db <path>` and `swarm serve --db <path>` are CI/power-user primitives.
- **Store** (`@swarm/store`) is the only coordination surface. WAL-mode SQLite; harness, daemon, and any client read and write.

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

An explicit `type=` node attribute overrides the shape→handler mapping. The value must name one of the eight handler kinds (`E016`); a shape/`type=` divergence is legal but flagged with `W012`.

Loops are **backward conditional edges** bounded by `max_retries` on the target node — there is no `loop` primitive. A node that should re-run on `outcome=retry` takes an edge back to itself or to an upstream node with `[condition="outcome=retry"]`, and its `max_retries` attribute caps how many times the retry counter can bump before the run pauses with `fact.run_paused{reason:"max_retries"}` (operator-resumable; raise the cap via `intent.max_retries_adjusted`).

Workflows are uploaded via `POST /workflows { name, dotSource }` which returns a `sha` (sha256 of the source). Runs reference workflows by sha; `workflow_sha` is pinned at enqueue time.

### 3.2 Handlers

A handler is a pure async function `(ctx: HandlerContext) => Promise<HandlerResult>`. Its I/O routes through `ctx`: `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.messages`, `ctx.artifacts`, `ctx.externalCall`. Handlers may not import `node:fs`, `node:child_process`, or call bare `fetch` — enforced by lint.

The codergen handler force-includes an **`abort` tool** on every call. Agents that cannot proceed call `abort({ reason })`; the handler translates the call to `outcome.status="fail"` with `non_retryable=true`, so workflows route via `condition="outcome=fail"` edges and the boundary skips retries on intentional failures.

See [`handler-contract.md`](./handler-contract.md) for the full API.

### 3.3 Events

Per-run causality lives in the `events` table; daemon-process lifecycle lives in a sibling `daemon_events` table.

- **Intents** (`intent.*`, table `events`) — written by the web server on behalf of operators. No OCC. Always appendable.
- **Facts** (`fact.*`, table `events`) — written by the daemon as state transitions. OCC-checked against `run_state.version`.
- **Daemon events** (`daemon.*` and `intent.schedule_*` / `fact.schedule_*`, table `daemon_events`) — written by the daemon for process-level audit (start/stop, sweeps, blob GC, leak detection, worktree provisioning, schedules). Not run-scoped, not OCC-tracked. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3 for the full taxonomy.

The `events` log is the source of truth for run state; the `run_state` row is the materialized projection, updated in the same transaction as the event append. `daemon_events` is an audit log — operators read it but no projection depends on it.

### 3.4 Run lifecycle

```
queued → running → {completed, paused, paused_hitl, paused_auto, halted, cancelled, quarantined}
          ▲            │
          └────── run_resumed (any paused_* → queued on intent.resume / intent.hitl_input / intent.unquarantine,
                              or wake-pending timer for paused_auto)
```

- **`queued`** — enqueued; ready to be claimed.
- **`running`** — a daemon has claimed it and is dispatching handlers.
- **`paused_hitl`** — a `wait.human` node yielded. `fact.run_paused_hitl` carries `label` + `options[]` (one per outgoing edge); awaits `intent.hitl_input { selected, note? }` or `intent.resume`.
- **`paused`** — operator-resumable pause. `fact.run_paused.payload.reason` discriminates the action shape. All wake on `intent.resume`; some pauses pair `intent.resume` with a cap-adjustment intent. The full reason set:

  | Reason | Trigger | Operator action |
  |---|---|---|
  | `operator` | Operator hit Pause (`intent.pause_requested`) | `intent.resume` |
  | `provider_error` | LLM provider returned 400/401/403/404/413/422 | Fix creds/request → `intent.resume` |
  | `payment_required` | LLM provider returned 402 | Top up off-ledger → `intent.resume` |
  | `budget` | `budget_usd` / `max_cost_usd` / `budget_tokens` / `max_tokens` ceiling crossed under `budget_policy="pause"` | `intent.budget_adjusted { scope, metric, newLimit }` → `intent.resume` |
  | `max_retries` | Node exhausted `max_retries` on `outcome=retry` | `intent.max_retries_adjusted { nodeId, newLimit }` → `intent.resume` |
  | `goal_gate` | `max_goal_gate_retries` retarget cap reached | `intent.goal_gate_adjusted { newLimit }` → `intent.resume` |
  | `max_loops` | Per-run dispatch ceiling reached | `intent.max_loops_adjusted { newLimit }` → `intent.resume` |
  | `abort_loop` | Codergen agent called `abort` repeatedly within the same node | `intent.resume` (operator decision) |
  | `provider_exhausted` | All configured providers in the model's fallback chain refused | `intent.resume` after fixing provider config |

- **`paused_auto`** — daemon owes a clock tick. `fact.run_paused.payload.reason` discriminates the source:

  | Reason | Trigger | Payload | Wake |
  |---|---|---|---|
  | `provider_retry` | Auto-retryable transport error (408/429/5xx/529/network) | `httpStatus`, `provider`, `attempt`, `resumeAt` | wake-pending sweeper at `resumeAt`; operator may short-circuit via `intent.resume` |
  | `handler_retry` | Node returned `outcomeStatus="retry"`; backoff scheduled | `attempt`, `delayMs`, `resumeAt`, `maxRetries` | same |
  | `timeout_retry` | Handler watchdog tripped (`max_ms` / `timeout`); retry budget remains | `attempt`, `resumeAt`, `maxRetries` | same |

  The concurrency slot is released during the wait so other queued runs can claim. The wake-pending sweeper emits `fact.run_resumed { fromStatus: "paused_auto" }` once `now >= resumeAt`; the run goes back to `queued` and re-dispatches.

- **`completed`** / **`halted`** / **`cancelled`** — terminal.
  - `fact.run_halted.payload.reason` is one of: `budget` (when `budget_policy="stop"`), `schema_drift`, `error`, `aborted_exit`, `occ_exhausted`, `timeout_exhausted`.
- **`quarantined`** — startup sweep found an orphan `fact.side_effect_intent` without a matching `done`/`failed`; awaits `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel" }`.

Adding a new operator-fixable failure mode is a new `PauseReason` literal — no new status, no schema migration.

### 3.5 Control plane

All operator actions are intent writes. Every endpoint validates its body and rejects 4xx on schema violation before any intent is appended. Route+body shapes are also tabulated in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

| Route | Body | Effect |
|---|---|---|
| `POST /runs/:id/steer` | `{ text: string }` (length > 0) | Injects steering text; aborts the current handler so the next dispatch sees it. |
| `POST /runs/:id/pause` | `{}` | Abort + transition to `paused{reason:"operator"}`. |
| `POST /runs/:id/cancel` | `{ reason?: string }` | Abort + transition to `cancelled`. |
| `POST /runs/:id/hitl` | `{ selected: string, note?: string }` | Wakes `paused_hitl`. `selected` must be an accelerator key from `fact.run_paused_hitl.options`. |
| `POST /runs/:id/resume` | `{ note?: string }` | Generic wake for any `paused_*` run. |
| `POST /runs/:id/unquarantine` | `{ resolution: "treat_as_done" \| "retry" \| "cancel", note?: string }` | Operator decision on a quarantined run. |
| `POST /runs/:id/priority` | `{ newPriority: number, note?: string }` | Appends `intent.priority_adjusted`; bumps queue priority. |
| `POST /runs/:id/budget` | `{ scope: "node" \| "run", metric: "cost" \| "tokens", newLimit: number, note?: string }` | Raises a budget ceiling on a `paused{reason:"budget"}` run. Folded into `routing.budget_override.<scope>.<metric>`. |
| `POST /runs/:id/max_retries` | `{ nodeId: string, newLimit: number, note?: string }` | Raises `max_retries` on a `paused{reason:"max_retries"}` run. |
| `POST /runs/:id/goal_gate` | `{ newLimit: number, note?: string }` | Raises `max_goal_gate_retries` on a `paused{reason:"goal_gate"}` run. |
| `POST /runs/:id/max_loops` | `{ newLimit: number, note?: string }` | Raises the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run. |

The four cap-adjustment intents (`budget` / `max_retries` / `goal_gate` / `max_loops`) raise per-run ceilings but do not themselves resume — the operator pairs each with `intent.resume` (the web UI bundles both clicks into a single "Raise & Resume" action).

### 3.6 Edge selection

After a node completes, the executor picks the next edge from the source node's outgoing edges. The five-step algorithm (`packages/core/src/engine/edge-selection.ts:60-124`) is:

1. **Condition** — among edges with a non-empty `condition`, evaluate each against the current outcome + routing. Among those that match, pick by weight (highest wins), then lexical tiebreak on `edge.to`.
2. **Preferred label** — among unconditional edges (no `condition`), first edge whose `label` normalises to `outcome.preferred_label` wins.
3. **Suggested next ids** — first unconditional edge whose target matches one of `outcome.suggested_next_ids` (in order) wins.
4. **Weight** — highest-weight unconditional edge.
5. **Lexical** — tiebreak by `edge.to` (lower wins).

**Fail routing.** When `outcome.status === "fail"` and step 1 produces no match, the executor does **not** fall through to steps 2–5 (those are reserved for success-path resolution). It follows the fail-routing chain (`packages/daemon/src/executor.ts:1031-1042`):

1. **Fail edge** — a condition-matched edge from step 1 above. If found, follow it.
2. **`retry_target`** on the failing node — jump to that node id (validated against the graph).
3. **`fallback_retry_target`** on the failing node — secondary jump target.
4. **Halt** — `fact.run_halted` with the original failure reason.

Authors recovering from failure declare a `condition="outcome=fail"` edge (step 1) or a per-node `retry_target` (steps 2-3); absence of all three is the halt signal. Graph-level `retry_target` / `fallback_retry_target` belong to goal-gate retargeting (§3.7), not per-node failure.

### 3.7 Retries and goal gates

**Per-node retries.** A handler returning `outcome.status="retry"` re-enters the same node with a backoff. `max_retries` (node attr, default 0) caps the count; exhaustion pauses the run with `fact.run_paused{reason:"max_retries"}` unless the node sets `allow_partial=true` (advance carrying `partial_success`).

`retry_policy` (node attr) names a backoff preset; `default_retry_policy` (graph attr) is the fallback.

| Preset | Max attempts | Initial delay | Factor |
|---|---|---|---|
| `none` (default) | 1 | — | — |
| `standard` | 5 | 200ms | 2.0 |
| `aggressive` | 5 | 500ms | 2.0 |
| `linear` | 3 | 500ms | 1.0 |
| `patient` | 3 | 2000ms | 3.0 |

Per-node overrides (`retry_initial_delay_ms`, `retry_backoff_factor`, `retry_max_delay_ms`, `retry_jitter`) replace individual fields of the resolved preset.

Boundary failures (auth, 4xx, validation) set `non_retryable=true` on the Outcome — the reducer treats the outcome as terminal regardless of status, so retry presets don't accidentally hammer a permanent failure.

**Goal gates.** A node with `goal_gate=true` must reach `success` or `partial_success` before the run can exit. When a terminal `Msquare` node would emit `fact.run_completed`, the executor first checks every visited gate; if any is unsatisfied, the run retargets to:

1. The failing gate's `retry_target` (then `fallback_retry_target`).
2. The graph-level `retry_target` (then `fallback_retry_target`).
3. Halt — `fact.run_paused{reason:"goal_gate"}` after `max_goal_gate_retries` (graph attr, default 3) retargets are exhausted.

`max_goal_gate_retries` bounds the chain so a perpetually-failing `retry_target` can't loop forever. Operators raise the cap via `intent.goal_gate_adjusted`.

### 3.8 Substitution

The following tokens expand in node `prompt` and `tool_command` strings before the handler sees them:

| Token | Meaning |
|---|---|
| `$ARGUMENTS` | The run's `--input` text (CLI positional or `POST /runs` body). |
| `$goal` | Graph-level `goal` attribute. |
| `$<nodeId>.output` | Raw text output of a prior node (codergen last turn's text, or tool stdout). |
| `$<nodeId>.output.<path>` | JSON-path dive into structured output; returns `""` if absent. |
| `${context.<key>}` | Lookup in the run's `routing` projection. |

Validator code `E005` flags `$<id>.output` references to unknown node ids.

### 3.9 Budgets

| Attribute | Scope | Effect |
|---|---|---|
| `budget_usd` | graph | Cumulative USD ceiling across the run. |
| `budget_tokens` | graph | Cumulative input+output+cache token ceiling across the run. |
| `max_cost_usd` | node | Cumulative USD ceiling for all iterations of one node. |
| `max_tokens` | node | Same for tokens. |
| `budget_policy` | graph | `"pause"` (default) → `fact.run_paused{reason:"budget"}`; `"stop"` → `fact.run_halted{reason:"budget"}`; `"warn"` → emit `budget.warn` / `budget.stop` events without pausing/halting. |

Soft `budget.warn` fires once per run at 80% of the ceiling. The ceiling check runs at every turn boundary; on `pause`, the operator raises the cap via `intent.budget_adjusted` and pairs it with `intent.resume`.

### 3.10 Schedules

Schedules fire a workflow on a fixed interval, independent of any one run's lifecycle. Schedule audit lives in `daemon_events` (not the per-run `events` table) because at `intent.schedule_create` time no run exists, and `fact.schedule_skipped` may fire without producing a run.

| Route | Body | Effect |
|---|---|---|
| `POST /schedules` | `{ workflow, cwd, every, input?, overlap?, fireOnCreate? }` | Creates the schedule; emits `intent.schedule_create`. `every` matches a known interval keyword (parsed by `parseInterval`). `overlap ∈ {"skip","queue","concurrent"}` (default `skip`). |
| `GET /schedules` | (query: `cwd?`) | Lists schedules with a `recentRuns` health stripe per schedule. |
| `GET /schedules/:id/runs` | (query: `limit?`) | Run history for one schedule. |
| `POST /schedules/:id/pause` | `{}` | Pauses; emits `intent.schedule_pause`. |
| `POST /schedules/:id/resume` | `{}` | Resumes; emits `intent.schedule_resume`. |
| `DELETE /schedules/:id` | — | Deletes; emits `intent.schedule_delete`. |

Daemon-emitted facts on a schedule fire:

- `fact.schedule_fired { scheduleId, runId }` — a run was enqueued.
- `fact.schedule_skipped { scheduleId, reason: "overlap" | "paused" }` — no run was enqueued.
- `fact.schedule_late { scheduleId, missedIntervals, lastTargetAt }` — emitted before a catch-up fire when ≥1 interval was missed.
- `fact.schedule_invalid_workflow { scheduleId, error }` — the schedule's workflow ref no longer resolves.

---

## 4. Invariants

| # | Invariant |
|---|---|
| **I1** | Every write is one SQLite transaction; events + projection updated together. |
| **I2** | No handler state outside the projection. |
| **I3** | Intents always-appendable; facts OCC-checked. |
| **I4** | Handlers receive `AbortSignal`; respecting it is contract. |
| **I5** | External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay. |
| **I6** | `run_state.routing` ≤ 8KB; payload lives in messages/artifacts. |
| **I7** | Event payloads ≤ 4KB. |
| **I8** | Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)`. |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`). |
| **I10** | Seq assignment is O(1) via per-run counter; never scanned. |

Enforced by structural lints (`packages/store/test/lint.test.ts`, `packages/core/test/handler/discipline.test.ts`) and a 24-entry property-test matrix ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §10).

---

## 5. Not in scope

**Out of scope by design:**

- **Multi-machine deployment.** Everything assumes one machine, one SQLite file. The `IEventStore` interface is synchronous (matching `bun:sqlite`); a Postgres backing would require async-ifying the interface and every callsite.
- **Blob encryption.** Single-user local tool; DB read = full read anyway.
- **Auto-migration of schema drift.** Runs pin a `schema_version`; mismatches halt rather than auto-upgrade.
- **Workflow hot-reload.** `workflow_sha` is pinned at enqueue time.

**Not honored from attractor-spec:**

- **`stack.manager_loop` / `house` shape** (attractor §4.11). Composition lives at the workflow level via separate runs sharing artifacts.
- **`tool_hooks.pre` / `tool_hooks.post`** (attractor §9.7). The agent backend handles tool interception.
- **Interviewer interface** (attractor §6). Replaced by `wait.human` nodes plus the `intent.hitl_input` event.
- **`auto_status` node attribute** (attractor §2.6 / Appendix C). Swarm handlers return a typed `HandlerResult`; there is no missing-status path to synthesize. Validator: `W014`.
- **`loop_restart` edge attribute** (attractor §2.7). Context resets happen via per-edge `fidelity=truncate|compact|summary:*`; full restarts happen by enqueueing a new run. Validator: `W014`.
- **`tripleoctagon.prompt` LLM-eval branch** (attractor §4.9). `parallel.fan_in` is structural-only — a deterministic heuristic ranker. LLM synthesis of branch outputs lives in a downstream codergen node referencing `$<branchId>.output` (see `~/.swarm/workflows/review.dot` for the canonical pattern), or in an upstream codergen using the `agent` tool for runtime-decided fan-out. Validator: `W015`.

**Surfaced as warnings, not errors:**

- Unknown attribute names on nodes / edges / graph (`W013`) — the DOT parser accepts any name through index-signature passthrough; the validator catches typos at validate-time.

Validator code lookup table: [`.agents/skills/swarm-author/references/validator-codes.md`](../.agents/skills/swarm-author/references/validator-codes.md).
