# fragua — Specification

> What fragua **is**. For design detail see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for writing handlers see [`handler-contract.md`](./handler-contract.md).

---

## 1. Vision

**fragua** is a git-native, auditable, local software dark factory. A workflow is a declarative YAML document; fragua executes it through a deterministic state machine that drives LLMs across any provider, and produces a complete, replayable audit trail.

Core values, in priority order:

1. **Simple** — small number of primitives, obvious composition.
2. **Testable** — pure core, first-class simulation, deterministic replay of the control plane (state machine, intent fold, edge selection). LLM bodies are best-effort and depend on provider determinism (see ARCH §1.11).
3. **Observable** — every state transition is a typed event in one durable log.
4. **Flexible** — swap providers, models, environments, UIs without touching workflow logic.
5. **Efficient** — reuses mature libraries (`pi-ai`, `pi-agent-core`) instead of rebuilding the stack.

**Non-goals:**

- Not a data-engineering orchestrator (Airflow / Dagster / Prefect territory).
- Not a cloud-scale workflow service (Temporal territory).
- Not a multi-tenant always-on server. Execution is local or in ephemeral CI jobs; there is no shared runner that accepts submitted workflows. Trust is delegated to git (PR review gates the workflow library) and CI (permissions/environments gate secrets) — so the workflow-authz / multi-user-isolation problem a shared runner would create simply isn't in scope.
- Not a chat framework (LangChain territory).
- Not a replacement for Claude Code or Codex — it *drives* them.

---

## 2. System shape

Single machine, one harness process, one SQLite database. The harness supervises a daemon subprocess and an in-process HTTP server against `~/.fragua/fragua.db`. The **CLI is a direct store-client** — it never goes through the HTTP server; only the browser Web UI does.

```
  Web UI (browser)
      │  HTTP + SSE
      ▼
┌──────────────────────────────────┐
│            fragua harness         │      ┌───────────────┐
│  ┌───────────────────────────┐   │      │   SQLite       │
│  │ HTTP + SSE server          │ ◀─┼──────│  ~/.fragua/    │
│  │ (in-process, :6767)        │ ──┼─────▶│  fragua.db     │
│  └───────────────────────────┘   │      │               │
│  ┌───────────────────────────┐   │      │  WAL — the one │
│  │ daemon subprocess          │ ──┼─────▶│  coordination  │
│  │ (executor + supervisor)    │ ◀─┼──────│  surface       │
│  └───────────────────────────┘   │      │               │
└──────────────────────────────────┘      │               │
                                           │               │
  fragua CLI  ── intents (write plane) ──▶ │               │
  (store-client) ◀── reads (read plane) ── │               │
                                           └───────────────┘
```

- **Harness** (`fragua harness`) is the default entry point: foreground process that spawns the daemon as a subprocess and runs the HTTP server in-process. The in-process server publishes its URL on the `server_endpoint` row (the Web UI / a remote client discovers it via the DB). SIGINT clears that row on the way out.
- **Daemon** runs the executor fiber + a 50ms supervisor fiber (heartbeat + intent detection + watchdog). Writes **facts** under OCC.
- **Server** exposes a Hono HTTP surface **for the Web UI**. Writes **intents** through the intent plane (always appendable, no OCC); reads through the read plane.
- **CLI** is a **direct store-client**: it opens `~/.fragua/fragua.db` and writes intents through the **intent plane** and reads through the **read plane** — no HTTP, works daemon-down. `fragua harness` (default) supervises; `fragua daemon --db <path>` / `fragua serve --db <path>` are CI/power-user primitives.
- **Planes** — the two shared surfaces both the server and the CLI route through, so no two clients can disagree: the **intent plane** (`@fragua/core/intent-plane`) validates + constructs + commits every write; the **read plane** (`@fragua/core/read-plane`) projects every run read (summary / detail / steps / messages / events / snapshots / diff / streaming).
- **Store** (`@fragua/store`) is the only coordination surface. WAL-mode SQLite; harness, daemon, and any client read and write.

---

## 3. Primitives

### 3.1 Workflows

A workflow is a YAML document with `name:` and a `steps:` map at the root (GitHub-Actions-style). Each step declares a `type:` discriminator that selects its handler kind:

| `type:` | Handler kind |
|---|---|
| `llm` | LLM call (the implicit default when `type:` is omitted) |
| `human` | operator-gated routing |
| `tool` | graph-level shell step (`run:`) |
| `parallel` | fork-all into ≥2 concurrent branch sub-pipelines, joined by `wait_all` (§3.1.1) |
| `exit` | reserved graceful-halt sink |

`start` is synthesized by the parser (the entry node pointing at the first declared step) and is never authored; `exit` is the reserved sink. Declaring a step named `start` or `exit` with a mismatched type is rejected (`E029` / `E028`).

Most steps run one handler to completion before the next dispatches. The **one** concurrent-dispatch primitive is the `parallel` node (§3.1.1); everything else is sequential.

### 3.1.1 Parallel fan-out

A `type: parallel` node forks into ≥2 **branch sub-pipelines** that execute concurrently and converge on a single **`wait_all` join**. A branch is a closure of deliberation-only `llm` steps (read-class — they share the run's worktree **read-only**) — typically a short pipeline like scan→verify, though any depth that reaches the join validates; closures are disjoint; each sub-node has its own `nodeId`, so its outputs/artifacts scope cleanly and the join reads `${{ outputs.<branch-terminal>.findings }}` per branch.

This is a **topology** change, not a second scheduler — three properties make it legitimate, and each is an invariant with a written reason, not a placeholder:

- **`wait_all` is the only join.** The region stays single-entry/single-exit, so dominance — and with it budget / goal-gate scoping — remains well-defined. `wait_any` / `race` / `quorum` joins would break SESE and are deliberately **excluded by design**, not yet-unbuilt.
- **Pause is run-global; there is no per-branch pause.** An operator pause / cancel, or a budget breach, trips the run's one shared `AbortSignal`, which aborts *every* in-flight branch; resume re-enters each branch from its own logged checkpoint. The scalar `run_state.status` stays the single lifecycle truth (claim / sweep / SSE read it); the per-branch **active set is diagnostic — derived from the fact log, never an authority** (no partial-pause status exists). That seam is not built and won't be until there is demand.
- **The commit unit is the branch-step, not a superstep.** Each branch commits its own `fact.node_completed` through the single daemon writer the instant it settles — one interleaved log under one OCC lane. This is *not* bulk-synchronous (no per-superstep barrier): a fast branch never waits on a slow sibling to commit, and crash recovery re-derives each branch's cursor from the log alone (no barrier needed — the active-set fold *is* the per-branch cursor).

The branch set is **static per run** — materialised at parse time, never grown during dispatch. A dynamic ("fork N at runtime") variant, if ever added, would still materialise the full branch set *before* executing the region (plan-time), never stream branches mid-dispatch — static-per-run is what keeps the possibility space, and the log, a pure fold. `parallel` is composition *within* a run; composition across *runs* still happens via separate runs sharing artifacts. Well-formedness is enforced by validator codes E036–E044 (ARCH §6.2). See [`docs/proposals/fan-out-nodes.md`](proposals/fan-out-nodes.md) for the execution model.

Loops are **backward edges** bounded by `max-retries` on the target node — there is no `loop` primitive. A step that should re-run on failure routes back to itself or to an upstream step via `on: {fail: <step>}`, and its `max-retries` attribute caps how many times the retry counter can bump before the run pauses with `fact.run_paused{reason:"max_retries"}` (operator-resumable; raise the cap via `intent.max_retries_adjusted`). The `retry: <step>` shorthand collapses the goal-gate-and-retarget idiom into one line.

Workflows are uploaded via `POST /workflows { name, source }` which returns a `sha` (sha256 of the source). Runs reference workflows by sha; `workflow_sha` is pinned at enqueue time.

### 3.2 Handlers

A handler is a pure async function `(ctx: HandlerContext) => Promise<HandlerResult>`. Its I/O routes through `ctx`: `ctx.llm`, `ctx.http`, `ctx.tools`, `ctx.messages`, `ctx.artifacts`, `ctx.externalCall`. Handlers may not import `node:fs`, `node:child_process`, or call bare `fetch` — enforced by lint.

The llm handler force-includes an **`abort` tool** on every call. Agents that cannot proceed call `abort({ reason })`; the handler translates the call to `outcome.status="fail"` with `non_retryable=true`, so workflows route via `on: {fail: …}` edges and the boundary skips retries on intentional failures.

See [`handler-contract.md`](./handler-contract.md) for the full API.

### 3.3 Events

Per-run causality lives in the `events` table; daemon-process lifecycle lives in a sibling `daemon_events` table.

- **Intents** (`intent.*`, table `events`) — operator-initiated, written through the intent plane: by the CLI directly (store-client) or by the HTTP server on behalf of the Web UI. No OCC. Always appendable.
- **Facts** (`fact.*`, table `events`) — written by the daemon as state transitions. OCC-checked against `run_state.version`.
- **Daemon events** (`daemon.*` and `intent.schedule_*` / `fact.schedule_*`, table `daemon_events`) — written by the daemon for process-level audit (start/stop, sweeps, blob GC, leak detection, worktree provisioning, schedules). Not run-scoped, not OCC-tracked. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3 for the full taxonomy.

The `events` log is the source of truth for run state; the `run_state` row is the materialized projection, updated in the same transaction as the event append. `daemon_events` is an audit log — operators read it but no projection depends on it.

### 3.4 Run lifecycle

```
queued → running → {completed, paused, paused_human, paused_auto, halted, cancelled, quarantined}
          ▲            │
          └────── run_resumed (any paused_* → queued on intent.resume / intent.human_input / intent.unquarantine,
                              or wake-pending timer for paused_auto)
```

- **`queued`** — enqueued; ready to be claimed.
- **`running`** — a daemon has claimed it and is dispatching handlers.
- **`paused_human`** — a `human` node yielded. `fact.run_paused_human` carries `text` + `routes: string[]`; awaits `intent.human_input { route, note? }` or `intent.resume`.
- **`paused`** — operator-resumable pause. `fact.run_paused.payload.reason` discriminates the action shape. All wake on `intent.resume`; some pauses pair `intent.resume` with a cap-adjustment intent. The full reason set:

  | Reason | Trigger | Operator action |
  |---|---|---|
  | `operator` | Operator hit Pause (`intent.pause_requested`) | `intent.resume` |
  | `provider_error` | LLM provider returned 400/401/403/404/413/422 | Fix creds/request → `intent.resume` |
  | `payment_required` | LLM provider returned 402 | Top up off-ledger → `intent.resume` |
  | `budget` | `budget_usd` / `max_cost_usd` / `budget_tokens` / `max_tokens` ceiling crossed under `budget_policy="pause"` | `intent.budget_adjusted { scope, metric, newLimit }` → `intent.resume` |
  | `max_retries` | Node exhausted `max_retries` on `outcome=retry` | `intent.max_retries_adjusted { nodeId, newLimit }` → `intent.resume` |
  | `goal_gate` | failing gate's `max_retries` retarget cap reached | `intent.goal_gate_adjusted { newLimit }` → `intent.resume` |
  | `max_loops` | Per-run dispatch ceiling reached | `intent.max_loops_adjusted { newLimit }` → `intent.resume` |
  | `abort_loop` | LLM agent called `abort` repeatedly within the same node | `intent.resume` (operator decision) |
  | `provider_exhausted` | All configured providers in the model's fallback chain refused | `intent.resume` after fixing provider config |

- **`paused_auto`** — daemon owes a clock tick. `fact.run_paused.payload.reason` discriminates the source:

  | Reason | Trigger | Payload | Wake |
  |---|---|---|---|
  | `provider_retry` | Auto-retryable transport error (408/429/5xx/529/network) | `httpStatus`, `provider`, `attempt`, `resumeAt` | wake-pending sweeper at `resumeAt`; operator may short-circuit via `intent.resume` |
  | `handler_retry` | Node returned `outcomeStatus="retry"`; backoff scheduled | `attempt`, `delayMs`, `resumeAt`, `maxRetries` | same |
  | `timeout_retry` | Handler watchdog tripped (`max_ms` / `timeout`); retry budget remains | `attempt`, `resumeAt`, `maxRetries` | same |

  The concurrency slot is released during the wait so other queued runs can claim. The wake-pending sweeper emits `fact.run_resumed { fromStatus: "paused_auto" }` once `now >= resumeAt`; the run goes back to `queued` and re-dispatches.

- **`completed`** / **`halted`** / **`cancelled`** — terminal.
  - `fact.run_halted.payload.reason` is one of: `budget` (when `budget_policy="stop"`), `error`, `aborted_exit`, `occ_exhausted`, `timeout_exhausted`. (A version mismatch is recoverable — `fact.run_paused{reason:"engine_incompatible"}` — not a halt; see §282.)
- **`quarantined`** — startup sweep found an orphan `fact.side_effect_intent` without a matching `done`/`failed`; awaits `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel" }`.

Adding a new operator-fixable failure mode is a new `PauseReason` literal — no new status, no schema migration.

### 3.5 Control plane

All operator actions are intent writes. Every endpoint validates its body and rejects 4xx on schema violation before any intent is appended. Route+body shapes are also tabulated in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

| Route | Body | Effect |
|---|---|---|
| `POST /runs/:id/steer` | `{ text: string }` (length > 0) | Injects steering text; aborts the current handler so the next dispatch sees it. |
| `POST /runs/:id/pause` | `{}` | Abort + transition to `paused{reason:"operator"}`. |
| `POST /runs/:id/cancel` | `{ reason?: string }` | Abort + transition to `cancelled`. |
| `POST /runs/:id/human` | `{ route: string, note?: string }` | Wakes `paused_human`. `route` must be one of the node's declared `routes=` names (surfaced on `fact.run_paused_human`). |
| `POST /runs/:id/resume` | `{ note?: string }` | Generic wake for any `paused_*` run. |
| `POST /runs/:id/unquarantine` | `{ resolution: "treat_as_done" \| "retry" \| "cancel", note?: string }` | Operator decision on a quarantined run. |
| `POST /runs/:id/priority` | `{ newPriority: number, note?: string }` | Appends `intent.priority_adjusted`; bumps queue priority. |
| `POST /runs/:id/budget` | `{ scope: "node" \| "run", metric: "cost" \| "tokens", newLimit: number, note?: string }` | Raises a budget ceiling on a `paused{reason:"budget"}` run. Folded into `routing.budget_override.<scope>.<metric>`. |
| `POST /runs/:id/max_retries` | `{ nodeId: string, newLimit: number, note?: string }` | Raises `max_retries` on a `paused{reason:"max_retries"}` run. |
| `POST /runs/:id/goal_gate` | `{ newLimit: number, note?: string }` | Raises the failing gate's retarget cap on a `paused{reason:"goal_gate"}` run. Folded into `routing.max_goal_gate_retries_override`. |
| `POST /runs/:id/max_loops` | `{ newLimit: number, note?: string }` | Raises the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run. |

The four cap-adjustment intents (`budget` / `max_retries` / `goal_gate` / `max_loops`) raise per-run ceilings but do not themselves resume — the operator pairs each with `intent.resume` (the web UI bundles both clicks into a single "Raise & Resume" action).

### 3.6 Edge selection

After a node completes, the executor picks the next edge using a two-case algorithm (`packages/core/src/engine/edge-selection.ts`).

**Route case** — when the source node declares `routes:`, it is a *routing node*. The llm backend synthesises an ephemeral `route` tool constrained to those values; the LLM exits the turn with `route({name:"a"})`. Edge selection picks the edge whose `route=a` attribute matches the chosen value. An unmatched route halts with `edge_no_match`.

**Outcome case** — for all other nodes, edge selection picks the edge whose `outcome=` attribute matches `handlerResult.outcomeStatus`. Unannotated edges default to `outcome=success`. If no edge matches a `fail` outcome the executor halts; no fall-through to success-path edges occurs.

Fail recovery is authored explicitly: add an `outcome=fail` edge from the node to a recovery target. Absence of a fail-edge is the halt signal — a node that fails with no fail route halts the run with `aborted_exit`. A fail-edge whose target is the `exit` sink is the one graceful exception: it is a sanctioned failure landing the author opted into, so the run reaches the terminal and emits `fact.run_completed` rather than halting. Per-node `retry_target` serves goal-gate retargeting (§3.7), not per-node failure.

**Outcome shape.** Every handler returns an `Outcome` (defined in `packages/core/src/types/outcome.ts`):

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "fail" \| "retry"` | Terminal disposition. `retry` re-enters the same node with backoff. |
| `notes` | string | Free-form diagnostic. |
| `failure_reason` | string? | Human-readable failure detail, surfaced as `fact.run_halted.detail`. |
| `non_retryable` | boolean? | When true, suppresses goal-gate retry even on fail. |
| `provider_error` | object? | Set by the llm boundary on transport errors. |
| `route` | string? | Chosen route name (routing nodes only). |
| `halt_reason` | HaltReason? | Set by the llm boundary for structural halts. |

### 3.7 Retries and goal gates

**Per-node retries.** A handler returning `outcome.status="retry"` re-enters the same node with a backoff. `max_retries` (node attr, default 0) caps the count; exhaustion pauses the run with `fact.run_paused{reason:"max_retries"}`.

`retry-policy` (node attr, authoring kebab-case; IR: `retry_policy`) names a backoff preset. Resolution order: node `retry-policy` → graph `default-retry-policy` → `"none"`.

| Preset | Max attempts | Initial delay | Factor | Jitter |
|---|---|---|---|---|
| `none` (default) | 1 | — | — | no |
| `standard` | 5 | 200ms | 2.0 | yes |
| `aggressive` | 5 | 500ms | 2.0 | yes |
| `linear` | 3 | 500ms | 1.0 | no |
| `patient` | 3 | 2000ms | 3.0 | yes |

Per-node override attrs (`retry-initial-delay-ms`, `retry-backoff-factor`, `retry-max-delay-ms`, `retry-jitter`) replace individual fields of the resolved preset. An unrecognised preset name is warned at validate-time (W014) and silently falls back to `none` at runtime.

Boundary failures (auth, 4xx, validation) set `non_retryable=true` on the Outcome — the reducer treats the outcome as terminal regardless of status, so retry presets don't accidentally hammer a permanent failure.

**Goal gates.** A node with `goal_gate=true` must reach `success` before the run can exit. When the run reaches the `exit` node and would emit `fact.run_completed`, the executor first checks every visited gate; if any is unsatisfied, the run retargets to the failing gate's `retry_target`. If that's unset, or once the failing gate's `max_retries` retargets are exhausted, the run pauses `fact.run_paused{reason:"goal_gate"}` (operator-resumable; raise the cap via `intent.goal_gate_adjusted` → `routing.max_goal_gate_retries_override`). Single-step retarget — there is no graph-level retarget and no fallback chain.

The gate's `max_retries` bounds the loop so a perpetually-failing `retry_target` can't burn the run forever; it is required on every step authored via `retry:` (E031).

### 3.8 Substitution

Two token families expand in `prompt:`, `text:`, and `run:` strings before the handler sees them:

| Token | Meaning |
|---|---|
| `${{ inputs.<name> }}` | A typed run input declared in the workflow's `inputs:` block, bound per-run via `--input name=value`. Declared `default:` values apply when a binding is omitted; the validator (E030) flags references to undeclared inputs, and enqueue rejects a missing required input or an out-of-range `choice`. |
| `${{ outputs.<producer>.<field>[.<sub>…] }}` | A typed step output emitted by an upstream `llm` node that declared `outputs:`. A scalar leaf interpolates as its value; a record/array as JSON; a dotted leaf reaches a scalar inside a structure. **Reads fail closed** — referencing a field the producer never populated on the taken path fails the consuming node (a recorded fact), never a silent `""`. The validator hard-errors on a broken/dead reference (E035) and warns when the producer may not run on every path (W015) or when a read reaches through an `optional:` field the producer may omit (W016). A value that is *always* read but sometimes empty is modelled as a **required field carrying a sentinel** (e.g. `"none"`), not `optional:`; `optional:` is for fields read inside a record/array consumed **whole** (absence is just omitted JSON there, never a fail-closed read). A direct read of an optional leaf has no fallback syntax yet, so W016 stays advisory. |

Workflows take their substitutable values through declared `inputs:` (the only run input surface is typed `routing.inputs`) and typed `outputs:`.

**Structured step outputs.** An `llm` step declares typed `outputs:` over a small type grammar shared with `inputs:` — scalars, `choice`, records (`fields`), arrays (`items`); no recursion, no `$ref` — a subset of JSON Schema sized to what provider strict-mode enforces, compiled to TypeBox. The step emits them through a single force-included `emit_output` tool whose schema is the declaration (validated post-emit; a missing or invalid emission fails the node). Like the `route` exit, `emit_output` must be called in isolation — it terminates the turn, so a tool sharing its batch would run blind to it; an emission paired with other tool calls fails the node. The emitted struct rides `fact.node_completed.payload.outputs`, spilling to the blob CAS when it exceeds the event cap; the executor folds it into an `(run_id, node_id)` index that the substitution resolver reads. `outputs:` is `llm`-only and mutually exclusive with `routes:`; `tool` and `human` steps consume outputs but do not produce them. See [`docs/proposals/structured-outputs.md`](proposals/structured-outputs.md).

**Conversation** still moves through **shared threads** (§3.3), not substitution. Two llm steps with the same `thread:` share the LLM conversation — downstream nodes see upstream replies as regular assistant messages; a receiving node may set `summary=low|medium|high` for a summariser-compressed view. Reach for `outputs:` for a typed machine hand-off (a value a `tool` runs, a struct a synthesiser aggregates); reach for the thread for conversation; re-derive on-disk state via the `bash` / `read` tools.

Tool nodes (`type: tool`, §3.1) are side-effect-only: exit 0 → `outcome=success`, non-zero → `outcome=fail`. They do not *produce* data forward (they consume `${{ … }}` in `run:`). Workflows that need to run a deterministic script and reason about its output should call the script from inside an llm step's `bash` tool instead of synthesising a tool-node-then-llm chain.

### 3.9 Budgets

| Attribute | Scope | Effect |
|---|---|---|
| `budget_usd` | graph | Cumulative USD ceiling across the run. |
| `budget_tokens` | graph | Cumulative input+output+cache token ceiling across the run. |
| `max_cost_usd` | node | Cumulative USD ceiling for all iterations of one node. |
| `max_tokens` | node | Same for tokens. |
| `budget_policy` | graph | `"pause"` (default) → `fact.run_paused{reason:"budget"}`; `"stop"` → `fact.run_halted{reason:"budget"}`; `"warn"` → emit `budget.warn` / `budget.stop` events without pausing/halting. |

Soft `budget.warn` fires once per run at 80% of the ceiling. The ceiling check runs at every turn boundary; on `pause`, the operator raises the cap via `intent.budget_adjusted` and pairs it with `intent.resume`. On a `parallel` node, `max_cost_usd` / `max_tokens` bound the **whole branch closure** — the sum of every sub-node's spend — since branch costs commit under sub-node ids, not the parent; the same warn / stop / pause policy applies.

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
| **I11** | A `parallel` region is single-entry/single-exit: `wait_all` is its only join, pause is run-global (one shared `AbortSignal` aborts every branch), and the per-branch active set is a log-derived **diagnostic** — the scalar `run_state.status` stays the sole lifecycle authority. Branches commit through the one daemon writer (the commit unit is the branch-step, not a synchronised superstep). |

Enforced by structural lints (`packages/store/test/lint.test.ts`, `packages/core/test/handler/discipline.test.ts`) and the property-test matrix ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §10).

---

## 5. Not in scope

**Out of scope by design:**

- **Multi-machine deployment.** Everything assumes one machine, one SQLite file. The `IEventStore` interface is synchronous (matching `bun:sqlite`); a Postgres backing would require async-ifying the interface and every callsite.
- **Blob encryption.** Single-user local tool; DB read = full read anyway.
- **Auto-migration of contract drift.** Runs pin an **event-contract version** (`EVENT_CONTRACT_VERSION`) at enqueue — DISTINCT from the DB-migration counter (`CURRENT_SCHEMA_VERSION`): it bumps only when `FactEvent`/`IntentEvent` shapes or reducer fold-semantics change, so projection-only migrations don't trip the resume gate. A mismatch **pauses** the run (recoverable — `fact.run_paused{reason:"engine_incompatible", pinnedVersion, supportedMin, supportedMax}`) rather than auto-upgrading. The payload's window tells the two arms apart: `pinnedVersion > supportedMax` (too new — a downgraded daemon / newer-producer import) heals once a capable daemon runs; `pinnedVersion < supportedMin` (too old) needs an operator rebuild-from-source or cancel. Neither is terminal. Parallel fan-out drove the first real bump: `EVENT_CONTRACT_VERSION = 2` (the new `fact.fanout_started` / `fact.fanout_joined` plus the active-set reducer fold), with `MIN_COMPATIBLE_CONTRACT_VERSION = 1` — so the gate is now live but backward-compatible: a current daemon folds every pin in `[1, 2]` (pre-fan-out v1 runs replay unchanged) and only an older v1 daemon meeting a v2 pin parks (too-new). A contract-surface hash test + a `reducers.ts` touch-gate force a conscious bump-or-resnapshot on any fold-contract change; capability-gated auto-wake for the too-new arm is still deferred.
- **Schema downgrade (DB-structure axis).** The DB-migration counter (`CURRENT_SCHEMA_VERSION`) walks forward automatically under the daemon lock and refuses to open a store newer than the binary. **Downgrade is supported but never automatic:** each `SCHEMA_MIGRATIONS` step carries an optional `down` inverse, and `fragua db migrate --to <lower>` walks them — backed up first, refusing an irreversible step, a data-losing step (without `--allow-data-loss`), or a live daemon. It is run by the *newer* binary that defines the `down` steps. This is the schema axis only, orthogonal to the contract-drift gate above: it does **not** make a newer-contract run resumable on an older daemon. See `docs/proposals/reversible-migrations.md`.
- **Workflow hot-reload.** `workflow_sha` is pinned at enqueue time.

**Not honored from attractor-spec:**

- **`stack.manager_loop` / `house` shape** (attractor §4.11). Composition lives at the workflow level via separate runs sharing artifacts.
- **`tool_hooks.pre` / `tool_hooks.post`** (attractor §9.7). The agent backend handles tool interception.
- **Interviewer interface** (attractor §6). Replaced by `human` nodes (`type: human`) plus the `intent.human_input` event.
- **`auto_status` node attribute** (attractor §2.6 / Appendix C). Fragua handlers return a typed `HandlerResult`; there is no missing-status path to synthesize. Validator: `W014`.
- **`loop_restart` edge attribute** (attractor §2.7). Context isolation happens at the node level: a node without `thread_id` runs fresh, a threaded node may set `summary=low|medium|high` for a summariser-compressed view. Full restarts happen by enqueueing a new run. Validator: `W014`.
- **Non-`wait_all` joins, cross-run fan-in, and dynamic forks** (attractor §4.8 / §4.9). The intra-run `parallel` fork-all → `wait_all` primitive ships (§3.1.1), but `wait_any` / `race` / `quorum` joins are excluded **by design** — they break the single-entry/single-exit invariant that keeps dominance (and thus budget / goal-gate scoping) well-defined. Fan-*in* across runs is likewise out of scope: composition across runs stays artifact-sharing, not a graph join. And a runtime-sized fork is out: a branch set is materialised at parse time, never streamed during dispatch.

**Surfaced as warnings, not errors:**

- Unknown attribute names on nodes / edges / graph (`W013`) — the YAML parser accepts any name through index-signature passthrough; the validator catches typos at validate-time.

Validator code lookup table: [`.agents/skills/workflows/references/validator-codes.md`](../.agents/skills/workflows/references/validator-codes.md).
