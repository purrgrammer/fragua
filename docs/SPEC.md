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
| `tool` | graph-level side-effect step (`run:` shell string **or** `exec:` argv vector) |
| `exit` | reserved graceful-halt sink |

**Tool steps — `run:` vs `exec:`.**  Tool steps are side-effect-only: exit 0 → `outcome=success`, non-zero → `outcome=fail`. Two mutually-exclusive execution forms are supported (validator E033 / E034):

- `run: <shell-string>` — passed verbatim to `sh -c`. The right choice for shell idioms (pipes, redirects, globs, multi-statement commands). `${{ inputs.* }}` values are POSIX-single-quote-escaped before substitution.
- `exec: {cmd: <binary>, args: [<arg>, …]}` — invokes the binary directly with no shell. `${{ inputs.* }}` is substituted **per element** (`cmd` and each `args[i]` independently); the substituted value becomes exactly one argv token and is never re-split. A value containing spaces, newlines, `$()`, or backticks is inert data at the child process — no shell sees it. This is the injection-safe form for steps that interpolate dynamic or generated values. See `docs/proposals/tool-exec-variant.md` for the full decision record.

For the `exec:` path: the resolved `cmd` is checked against the blocklist AND refused when it is a shell interpreter (`sh`, `bash`, `zsh`, `dash`, `fish`). The latter check is static (validator E034) for literal `cmd` values and runtime for interpolated ones. This preserves the invariant that all shell execution passes through the `run:` path.

`start` is synthesized by the parser (the entry node pointing at the first declared step) and is never authored; `exit` is the reserved sink. Declaring a step named `start` or `exit` with a mismatched type is rejected (`E029` / `E028`).

fragua has no concurrent-dispatch primitive: every step runs one handler to completion before the next is dispatched. Composition across concurrent work happens at the workflow level via separate runs sharing artifacts.

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

Fail recovery is authored explicitly: add an `outcome=fail` edge from the node to a recovery target. Absence of a fail-edge is the halt signal — a node that fails with no fail route halts the run with `aborted_exit`. A fail-edge whose target is the `exit` sink is the one graceful exception: it is a sanctioned failure landing the author opted into, so the run reaches the terminal and emits `fact.run_completed` rather than halting. Per-node `retry_target` / `fallback_retry_target` serve goal-gate retargeting (§3.7), not per-node failure.

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

**Goal gates.** A node with `goal_gate=true` must reach `success` before the run can exit. When the run reaches the `exit` node and would emit `fact.run_completed`, the executor first checks every visited gate; if any is unsatisfied, the run retargets to:

1. The failing gate's `retry_target` (then `fallback_retry_target`).
2. The graph-level `retry_target` (then `fallback_retry_target`).
3. Halt — `fact.run_paused{reason:"goal_gate"}` after the failing gate's own `max_retries` retargets are exhausted.

The gate's `max_retries` bounds the chain so a perpetually-failing `retry_target` can't loop forever; it is required on every step authored via `retry:` (E031). Operators raise the live cap via `intent.goal_gate_adjusted` → `routing.max_goal_gate_retries_override`.

### 3.8 Substitution

One token family expands in `prompt:`, `text:`, `run:`, and `exec:` strings before the handler sees them:

| Token | Meaning |
|---|---|
| `${{ inputs.<name> }}` | A typed run input declared in the workflow's `inputs:` block, bound per-run via `--input name=value`. Declared `default:` values apply when a binding is omitted; the validator (E030) flags references to undeclared inputs, and enqueue rejects a missing required input or an out-of-range `choice`. |

The run's free-form positional (CLI trailing args, or `POST /runs` `input`) lands on `routing.input` as the run's description and auto-title seed — it is **not** substituted into prompts. Workflows take their substitutable values through declared `inputs:`.

Cross-node data transfer happens through **shared threads** (§3.3), not through prompt substitution. Two llm steps with the same `thread:` share the LLM conversation — downstream nodes see upstream replies as regular assistant messages in their context. A receiving node may set `summary=low|medium|high` to see a summariser-compressed view of the prior thread instead of the raw history. When the producer doesn't share a thread with the consumer (rare; usually a sign to redesign), the consumer re-derives the data inside its own turn via the `bash` / `read` tools.

Tool nodes (`type: tool`, §3.1) are side-effect-only: exit 0 → `outcome=success`, non-zero → `outcome=fail`. For the `exec:` variant, substitution is per-element with no re-split (see §3.1). They do not feed data forward. Workflows that need to run a deterministic script and reason about its output should call the script from inside an llm step's `bash` tool instead of synthesising a tool-node-then-llm chain.

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
- **Auto-migration of contract drift.** Runs pin an **event-contract version** (`EVENT_CONTRACT_VERSION`) at enqueue — DISTINCT from the DB-migration counter (`CURRENT_SCHEMA_VERSION`): it bumps only when `FactEvent`/`IntentEvent` shapes or reducer fold-semantics change, so projection-only migrations don't trip the resume gate. A mismatch **pauses** the run (recoverable — `fact.run_paused{reason:"engine_incompatible", pinnedVersion, supportedMin, supportedMax}`) rather than auto-upgrading. The payload's window tells the two arms apart: `pinnedVersion > supportedMax` (too new — a downgraded daemon / newer-producer import) heals once a capable daemon runs; `pinnedVersion < supportedMin` (too old) needs an operator rebuild-from-source or cancel. Neither is terminal. At the 0.1.0 baseline `MIN_COMPATIBLE_CONTRACT_VERSION = EVENT_CONTRACT_VERSION = 1`, so the gate is latent. A contract-surface hash test + a `reducers.ts` touch-gate force a conscious bump-or-resnapshot on any fold-contract change (`docs/proposals/event-contract-version.md` §3.3); capability-gated auto-wake for the too-new arm is still deferred.
- **Workflow hot-reload.** `workflow_sha` is pinned at enqueue time.

**Not honored from attractor-spec:**

- **`stack.manager_loop` / `house` shape** (attractor §4.11). Composition lives at the workflow level via separate runs sharing artifacts.
- **`tool_hooks.pre` / `tool_hooks.post`** (attractor §9.7). The agent backend handles tool interception.
- **Interviewer interface** (attractor §6). Replaced by `human` nodes (`type: human`) plus the `intent.human_input` event.
- **`auto_status` node attribute** (attractor §2.6 / Appendix C). Fragua handlers return a typed `HandlerResult`; there is no missing-status path to synthesize. Validator: `W014`.
- **`loop_restart` edge attribute** (attractor §2.7). Context isolation happens at the node level: a node without `thread_id` runs fresh, a threaded node may set `summary=low|medium|high` for a summariser-compressed view. Full restarts happen by enqueueing a new run. Validator: `W014`.
- **Graph-level parallel / fan-in primitive** (attractor §4.8 / §4.9). fragua has no fan-out / fan-in graph primitive, and no concurrent dispatch of any kind — steps run one at a time. Concurrent work is composed at the workflow level via separate runs sharing artifacts.

**Surfaced as warnings, not errors:**

- Unknown attribute names on nodes / edges / graph (`W013`) — the YAML parser accepts any name through index-signature passthrough; the validator catches typos at validate-time.

Validator code lookup table: [`.agents/skills/workflows/references/validator-codes.md`](../.agents/skills/workflows/references/validator-codes.md).
