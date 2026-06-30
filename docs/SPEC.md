# fragua — Specification

> What fragua **is**. For design detail see [`ARCHITECTURE.md`](./ARCHITECTURE.md); for writing handlers see [`handler-contract.md`](./handler-contract.md).

---

## 1. Vision

**fragua** is a git-native, auditable, local software dark factory — "dark factory" in the lights-out-manufacturing sense: workflows run unattended on the operator's machine, and the operator reviews finished work (inbox, accept/discard) instead of supervising each step. A workflow is a declarative YAML document; fragua executes it through a deterministic state machine that drives LLMs across any provider, and produces a complete, replayable audit trail.

Local-first is a **wager about who the user is**, not a trust virtue we apologise for and not a constraint we hope to lift. The user is a single engineer (or a single agent acting on their behalf) driving their own machine: the same person who owns the repo, holds the provider credentials, reviews the diffs, and lands the work. For that user a shared instance is not a missing feature — it is the wrong shape. They already have the durable shared surface engineering coordinates through: git. fragua deliberately does not duplicate it. The unit of sharing is the **run**, exported as a `.fragua` bundle into another trusted store (SPEC §5), never a live multi-tenant database every collaborator queries at once. We bet this user genuinely never needs a shared instance, and we spend the simplicity that bet buys us — no auth, no tenancy, no hosted control plane — on the engine instead.

That bet is what makes the store the single trusted surface. The store — one SQLite file on the operator's machine — holds every event, message, and artifact, and nothing leaves unless the operator exports it. When execution must happen elsewhere, it happens in ephemeral CI jobs, and trust is delegated to mechanisms the operator already audits: PR review gates the workflow library (no unreviewed graph runs), CI permissions and environments gate the secrets a run can touch. There is no shared runner, no hosted control plane, no third party holding the log — so the multi-tenant authz problem a service would create never has to be solved. This is a deliberate foreclosure, not a roadmap gap: the synchronous `IEventStore` makes a shared/async backing structurally out of scope (SPEC §5, ARCH §4).

Core values, in priority order:

1. **Simple** — small number of primitives, obvious composition.
2. **Testable** — pure core, first-class simulation, deterministic replay of the control plane (state machine, intent fold, edge selection). LLM bodies are best-effort and depend on provider determinism (see ARCH §1.11).
3. **Observable** — every state transition is a typed event in one durable log.
4. **Flexible** — swap providers, models, environments, UIs without touching workflow logic.
5. **Efficient** — reuses mature libraries (`pi-ai`, `pi-agent-core`) instead of rebuilding the stack.

**Non-goals:**

- Not a data-engineering orchestrator (Airflow / Dagster / Prefect territory).
- Not a cloud-scale workflow service (Temporal territory).
- Not a multi-tenant always-on server. Execution is local or in ephemeral CI jobs; there is no shared runner that accepts submitted workflows (see the trust-delegation paragraph above).
- Not a chat framework (LangChain territory).
- Not a replacement for Claude Code or Codex, and it does not drive them — fragua drives the *models*: it is its own harness, running its own agent loop directly against providers.

### How this differs from the nearest systems

- **LangGraph** — interrupts land at checkpoint boundaries, before or after a node executes; in fragua, operator steering is an always-appendable intent that trips the run's `AbortSignal`, hard-aborting the in-flight handler mid-turn, and is folded deterministically into the next dispatch (intent-fold rules R1–R7).
- **Restate / DBOS** (durable execution) — recovery re-executes workflow code against a journal of recorded step results; fragua never re-executes code to recover state — `run_state` is a pure fold over one linear event log, and signals workflow code would have to poll for are instead intents the fold applies at the dispatch boundary (ARCH §1.11, [`intent-fold.md`](./intent-fold.md)).

**Dependency posture.** Core value 5 is a real bet: provider coverage, agent-loop semantics (turn-taking, tool dispatch and interception), and abort propagation all ride `pi-ai` + `@earendil-works/pi-agent-core`. The handler contract insulates handlers from the dependency's *machinery* — they call `ctx.llm` and return a typed `HandlerResult`, never constructing providers or driving the agent loop (see [`handler-contract.md`](./handler-contract.md)) — but not from its *shapes*: `ctx.llm.call` takes pi-ai's `Message` union and the persisted transcript is pi-agent-core's `AgentMessage` (re-exported through `@fragua/types`). The swap surface is deliberately one file: `PiLlmBackend` (`packages/agent/src/backend.ts`) implements `@fragua/core`'s `LlmBackend` interface, so replacing the dependency means rewriting that backend (and migrating the message shapes), not the engine.

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
- **Planes** — the two shared surfaces both the server and the CLI route through, so no two clients can disagree: the **intent plane** (`@fragua/core/intent-plane`) validates + constructs + commits every write; the **read plane** (`@fragua/core/read-plane`) projects every run read (summary / detail / steps / messages / events / snapshots / diff / streaming). The plane's workflow mint **rejects error-severity validator diagnostics at save** — an E-coded graph never reaches the executor through any client (server upload, `fragua run`/`ci`, schedule dispatch); warnings pass, and `fragua validate` remains the surface that shows them.
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

The branch set is **static per run** — materialised at parse time, never grown during dispatch. A dynamic ("fork N at runtime") variant, if ever added, would still materialise the full branch set *before* executing the region (plan-time), never stream branches mid-dispatch — static-per-run is what keeps the possibility space, and the log, a pure fold. `parallel` is composition *within* a run; composition across *runs* still happens via separate runs sharing artifacts. Well-formedness is enforced by validator codes E036–E045 (ARCH §6.2). See [`docs/proposals/fan-out-nodes.md`](proposals/fan-out-nodes.md) for the execution model.

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
- **`paused_human`** — a `human` node yielded. `fact.run_paused{reason:"human"}` carries `text` + `routes: string[]`; awaits `intent.human_input { route, note? }` or `intent.resume`.
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
  | `timeout_retry` | Handler watchdog tripped (`max_ms` / `timeout`); retry budget remains | `attempt`, `delayMs`, `resumeAt`, `maxAttempts`, `attemptedMs` | same |

  The concurrency slot is released during the wait so other queued runs can claim. The wake-pending sweeper emits `fact.run_resumed { fromStatus: "paused_auto" }` once `now >= resumeAt`; the run goes back to `queued` and re-dispatches.

- **`completed`** / **`halted`** / **`cancelled`** — terminal. A single `fact.run_terminated { status }` ends the run (fact-taxonomy.md §3.1); the reducer projects its `status` to the lifecycle value: `completed` → `completed` (payload `finalNode`), `errored` → `halted` (payload `reason` + `detail?`), `aborted` → `cancelled` (payload `intentSeq`).
  - `fact.run_terminated{status:"errored"}.payload.reason` is one of: `budget` (when `budget_policy="stop"`), `error`, `aborted_exit`, `occ_exhausted`, `timeout_exhausted`, `worktree_error`, `route_not_picked`, `route_call_not_isolated`, `edge_no_match`. (A version mismatch is recoverable — `fact.run_paused{reason:"engine_incompatible"}` — not a halt; see §5.)
- **`quarantined`** — startup sweep found an orphan `fact.side_effect_intent` without a matching `done`/`failed`; awaits `intent.unquarantine { resolution: "treat_as_done" | "retry" | "cancel" }`.

Adding a new operator-fixable failure mode is a new `PauseReason` literal — no new status, no schema migration.

### 3.5 Control plane

All operator actions are intent writes. Every endpoint validates its body and rejects 4xx on schema violation before any intent is appended. Route+body shapes are also tabulated in [`ARCHITECTURE.md`](./ARCHITECTURE.md) §7.

| Route | Body | Effect |
|---|---|---|
| `POST /runs/:id/steer` | `{ text: string }` (length > 0) | Injects steering text; aborts the current handler so the next dispatch sees it. |
| `POST /runs/:id/pause` | `{}` | Abort + transition to `paused{reason:"operator"}`. |
| `POST /runs/:id/cancel` | `{ reason?: string }` | Abort + transition to `cancelled`. |
| `POST /runs/:id/human` | `{ route: string, note?: string }` | Wakes `paused_human`. `route` must be one of the node's declared `routes=` names (surfaced on `fact.run_paused{reason:"human"}`). |
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

Fail recovery is authored explicitly: add an `outcome=fail` edge from the node to a recovery target. Absence of a fail-edge is the halt signal — a node that fails with no fail route halts the run with `aborted_exit`. A fail-edge whose target is the `exit` sink is the one graceful exception: it is a sanctioned failure landing the author opted into, so the run reaches the terminal and emits `fact.run_terminated{status:"completed"}` rather than halting. Per-node `retry_target` serves goal-gate retargeting (§3.7), not per-node failure.

**Outcome shape.** Every handler returns an `Outcome` (defined in `packages/core/src/types/outcome.ts`):

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "fail" \| "retry"` | Terminal disposition. `retry` re-enters the same node with backoff. |
| `notes` | string | Free-form diagnostic. |
| `failure_reason` | string? | Human-readable failure detail, surfaced as `fact.run_terminated{errored}.detail`. |
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

**Goal gates.** A node with `goal_gate=true` must reach `success` before the run can exit. When the run reaches the `exit` node and would emit `fact.run_terminated{status:"completed"}`, the executor first checks every visited gate; if any is unsatisfied, the run retargets to the failing gate's `retry_target`. If that's unset, or once the failing gate's `max_retries` retargets are exhausted, the run pauses `fact.run_paused{reason:"goal_gate"}` (operator-resumable; raise the cap via `intent.goal_gate_adjusted` → `routing.max_goal_gate_retries_override`). Single-step retarget — there is no graph-level retarget and no fallback chain.

The gate's `max_retries` bounds the loop so a perpetually-failing `retry_target` can't burn the run forever; it is required on every step authored via `retry:` (E031).

### 3.8 Substitution

Two token families expand in `prompt:`, `text:`, and `run:` strings before the handler sees them:

| Token | Meaning |
|---|---|
| `${{ inputs.<name>[.<field>…] }}` | A typed run input declared in the workflow's `inputs:` block, bound per-run via `--input name=value` (or the whole object via `--input-json`). Scalars (`string`/`number`/`boolean`/`choice`) interpolate as text; `object`/`array` inputs are dot-read into their fields (`${{ inputs.config.env }}`). Declared `default:` values apply when a binding is omitted. Dotted reads are **lenient**: an unresolvable path collapses to `""` (unlike the fail-closed `outputs.` reads). The validator (E030) flags references to undeclared inputs and rejects a dotted sub-reference into a *scalar* input (it can never resolve); enqueue rejects a missing required input or an out-of-range `choice`. |
| `${{ outputs.<producer>.<field>[.<sub>…] }}` | A typed step output emitted by an upstream `llm` node that declared `outputs:`. A scalar leaf interpolates as its value; a record/array as JSON; a dotted leaf reaches a scalar inside a structure. **Reads fail closed** — referencing a field the producer never populated on the taken path fails the consuming node (a recorded fact), never a silent `""`. The validator hard-errors on a broken/dead reference (E035) and warns when the producer may not run on every path (W015) or when a read reaches through an `optional:` field the producer may omit (W016). A value that is *always* read but sometimes empty is modelled as a **required field carrying a sentinel** (e.g. `"none"`), not `optional:`; `optional:` is for fields read inside a record/array consumed **whole** (absence is just omitted JSON there, never a fail-closed read). A direct read of an optional leaf has no fallback syntax yet, so W016 stays advisory. |

Workflows take their substitutable values through declared `inputs:` (the only run input surface is typed `routing.inputs`) and typed `outputs:`.

**Structured step outputs.** An `llm` step declares typed `outputs:` over a small type grammar shared with `inputs:` — scalars, `choice`, records (`fields`), arrays (`items`); no recursion, no `$ref` — a subset of JSON Schema sized to what provider strict-mode enforces, compiled to TypeBox. The step emits them through a single force-included `emit_output` tool whose schema is the declaration (validated post-emit; a missing or invalid emission fails the node). Like the `route` exit, `emit_output` must be called in isolation — it terminates the turn, so a tool sharing its batch would run blind to it; an emission paired with other tool calls fails the node. The emitted struct rides `fact.node_completed.payload.outputs`, spilling to the blob CAS when it exceeds the event cap; the executor folds it into an `(run_id, node_id)` index that the substitution resolver reads. `outputs:` is `llm`-only and mutually exclusive with `routes:`; `tool` and `human` steps consume outputs but do not produce them. See [`docs/proposals/structured-outputs.md`](proposals/structured-outputs.md).

**Run-level outputs.** A workflow declares a top-level `outputs:` block that **projects** step outputs into the run's typed result: `outputs: { verdict: { from: review.verdict } }`. `from:` is a `<node>.<path>` reference with the same addressing as the `${{ outputs.<node>.<field> }}` token, minus the wrapper; a bare `from: review` projects the producer's whole struct, a dotted suffix selects a leaf/sub-record, and the run-output's type is the referenced field's type (no new type surface). The egress envelope is **typed-partial, not fail-closed** — this is the run *boundary*, distinct from the in-graph consumer read: it carries exactly the declared outputs whose producer ran; an unproduced one is **absent** (key omitted), never `""` and never a halt (absent is distinct from present-`null`). Only a `completed` run has an envelope; a producer that ran more than once resolves to its **latest** emission. It is a read-plane projection over the workflow IR + the rebuildable outputs index, surfaced as `RunDetail.outputs` and carried in the export bundle — no new fact. The top-level `outputs:` block is a new IR-core attr (`ir_version` bump + converter). The validator hard-errors on a broken projection (E046: `from:` names a node with no `outputs:`, or a path the producer's schema doesn't declare) and warns when the producer may not run on every completing path (W018). See [`docs/proposals/structured-outputs.md`](proposals/structured-outputs.md) §11.

**Conversation** still moves through **shared threads** (§3.3), not substitution. Two llm steps with the same `thread:` share the LLM conversation — downstream nodes see upstream replies as regular assistant messages; a receiving node may set `summary=low|medium|high` for a summariser-compressed view. Reach for `outputs:` for a typed machine hand-off (a value a `tool` runs, a struct a synthesiser aggregates); reach for the thread for conversation; re-derive on-disk state via the `bash` / `read` tools.

Tool nodes (`type: tool`, §3.1) are side-effect-only: exit 0 → `outcome=success`, non-zero → `outcome=fail`. They do not *produce* data forward (they consume `${{ … }}` in `run:`). Workflows that need to run a deterministic script and reason about its output should call the script from inside an llm step's `bash` tool instead of synthesising a tool-node-then-llm chain.

### 3.9 Budgets

| Attribute | Scope | Effect |
|---|---|---|
| `budget_usd` | graph | Cumulative USD ceiling across the run. |
| `budget_tokens` | graph | Cumulative input+output+cache token ceiling across the run. |
| `max_cost_usd` | node | Cumulative USD ceiling for all iterations of one node. |
| `max_tokens` | node | Same for tokens. |
| `budget_policy` | graph | `"pause"` (default) → `fact.run_paused{reason:"budget"}`; `"stop"` → `fact.run_terminated{status:"errored",reason:"budget"}`; `"warn"` → emit `budget.warn` / `budget.stop` events without pausing/halting. |

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

### 3.11 Executor decision/effect boundary

The daemon's executor is split into a **pure decision core** and an **effectful driver**, and the seam between them is a rule, not an accident.

- **Decision core** — `planTransition` (`packages/daemon/src/transition-planner.ts`) for a successful turn, `planAbort` (`packages/daemon/src/abort-planner.ts`) for the abort arm. Each takes a plain input record and returns a plan. It performs **no I/O**: no store reads or writes, no clock (`now` is a parameter, not a `Date.now()` call), no randomness (`random` is an injected `() => number`), no subprocess, no network.
- **Driver** — `runOne` / `runFanout` and their helpers in `packages/daemon/src/executor.ts`. The driver owns **all** effects: it applies the plan to the store under the OCC discipline (I3), runs the worktree / subprocess / provider effects, and handles timers and the run's `AbortSignal`.

The decision core may order only a fixed **plan vocabulary** — the shape of `TransitionPlan` / `AbortPlan`:

| Plan field | Meaning |
|---|---|
| `facts: FactEvent[]` | The `fact.*` events to append (the driver commits them under OCC). |
| `routingPatch?: Record<string, unknown>` | An optional routing patch (key → value) merged into `run_state.routing`. |
| `advanceAppliedTo?: number` | The applied-intent watermark advance — how far the intent fold has been consumed. |
| `observability: PlannedObservability[]` | Observability events drained into the run's buffer before the facts commit. |
| `outcome` *(abort arm only)* | A commit-strategy tag — `halt \| pause \| timeout_retry \| abort_step` — the driver switches on to pick the commit sequence. |

`TransitionPlan` carries the first four; `AbortPlan` carries `facts`, `routingPatch`, `advanceAppliedTo`, and `outcome`.

**Why it matters.** Keeping the decision core pure makes the control plane deterministic and replayable: the same input always yields the same plan, so every fact-list-rewrite rule (exactly-one-terminal, `node_completed` preserved under a budget halt, a retry pause swapping `node_started`, …) becomes a property over generated input (ARCH §10). And because the core only ever emits facts + a routing patch + a watermark + observability, an alternative executor implementation could be substituted behind the same store ABI — as long as it emits the same facts, the rest of the system (reducer, read plane, UI) can't tell the difference.

---

## 4. Invariants

| # | Invariant |
|---|---|
| **I1** | Every write is one SQLite transaction; events + projection updated together. |
| **I2** | No handler state outside the projection. |
| **I3** | Intents always-appendable; facts OCC-checked. |
| **I4** | Handlers receive `AbortSignal`; respecting it is contract. |
| **I5** | External side effects carry a provider idempotency key; orphan `INTENT` quarantines the run on crash-replay. |
| **I6** | `run_state.routing` ≤ 8KB — a defense-in-depth **tripwire**, not a functional budget: payload lives in messages/artifacts, and reads go through bounded, typed accessors (`packages/core/src/routing.ts`) over the flat dotted bytes, so the CHECK should never fire in correct operation. Kept as a backstop that catches a payload leaking into a variable-length namespace. |
| **I7** | Event payloads ≤ 4KB. |
| **I8** | Raw tool output addressed by sha256 in `blobs`; artifacts are named refs scoped by `(run, node, iteration, key)`. |
| **I9** | LLM-visible preview (`messages`) is distinct from system-recorded raw (`artifacts`). |
| **I10** | Seq assignment is O(1) via per-run counter; never scanned. |
| **I11** | A `parallel` region is single-entry/single-exit: `wait_all` is its only join, pause is run-global (one shared `AbortSignal` aborts every branch), and the per-branch active set is a log-derived **diagnostic** — the scalar `run_state.status` stays the sole lifecycle authority. Branches commit through the one daemon writer (the commit unit is the branch-step, not a synchronised superstep). |
| **I12** | The executor's decision core (`planTransition` → `TransitionPlan`, `planAbort` → `AbortPlan`) is pure: no store I/O, no clock (`now` is a parameter), no RNG (`random` is injected), no subprocess/network. It may order only the fixed plan vocabulary — `fact.*` events, an optional routing patch, an `advanceAppliedTo` watermark advance, observability events (`TransitionPlan` only), and (abort arm only) a commit-strategy `outcome` tag. The driver (`runOne` / `runFanout`) owns every effect: OCC commit, worktree/subprocess/provider work, timers, and `AbortSignal`. See §3.11. |

Enforced by structural lints (`packages/store/test/lint.test.ts`, `packages/core/test/handler/discipline.test.ts`) and the property-test matrix ([`ARCHITECTURE.md`](./ARCHITECTURE.md) §10).

---

## 5. Not in scope

**Out of scope by design:**

- **Multi-machine deployment.** Everything assumes one machine, one SQLite file. The `IEventStore` interface is synchronous (matching `bun:sqlite`); a Postgres backing would require async-ifying the interface and every callsite.
- **Blob encryption.** Single-user local tool; DB read = full read anyway.
- **Auto-migration of contract drift.** Runs pin an **event-contract version** (`EVENT_CONTRACT_VERSION`) at enqueue — DISTINCT from the DB-migration counter (`CURRENT_SCHEMA_VERSION`): it bumps only when `FactEvent`/`IntentEvent` shapes or reducer fold-semantics change, so projection-only migrations don't trip the resume gate. A mismatch **pauses** the run (recoverable — `fact.run_paused{reason:"engine_incompatible", pinnedVersion, supportedMin, supportedMax}`) rather than auto-upgrading. The payload's window tells the two arms apart: `pinnedVersion > supportedMax` (too new — a downgraded daemon / newer-producer import) heals once a capable daemon runs; `pinnedVersion < supportedMin` (too old) needs an operator rebuild-from-source or cancel. Neither is terminal. The governing rule is **write the newest version, read all versions**: the daemon emits only the current contract's facts, but the reducer + read-plane fold the whole range `[MIN_COMPATIBLE_CONTRACT_VERSION, EVENT_CONTRACT_VERSION]` — so a current daemon never parks on an older run; only the *downgrade* direction parks (an older daemon meeting a newer pin). `EVENT_CONTRACT_VERSION` is at `4` (parallel fan-out's frontier facts, then the structural-halt partial-spend fields, then the fact-taxonomy collapse) while `MIN_COMPATIBLE_CONTRACT_VERSION` stays `1`. Dropping a fact type from *emission* (as the taxonomy collapse did) does **not** move the floor: the retired type is kept as a read-only, never-emitted member of the union with its fold path intact. `MIN_COMPATIBLE` ratchets — stranding every run pinned below it — only by deliberate act, when a historical format becomes genuinely un-foldable. A contract-surface hash test + a `reducers.ts` touch-gate force a conscious bump-or-resnapshot on any fold-contract change; capability-gated auto-wake for the too-new arm is still deferred.
- **Schema downgrade (DB-structure axis).** The DB-migration counter (`CURRENT_SCHEMA_VERSION`) walks forward automatically under the daemon lock and refuses to open a store newer than the binary. **Downgrade is supported but never automatic:** each `SCHEMA_MIGRATIONS` step carries an optional `down` inverse, and `fragua db migrate --to <lower>` walks them — backed up first, refusing an irreversible step, a data-losing step (without `--allow-data-loss`), or a live daemon. It is run by the *newer* binary that defines the `down` steps. This is the schema axis only, orthogonal to the contract-drift gate above: it does **not** make a newer-contract run resumable on an older daemon. See `docs/proposals/reversible-migrations.md`.
- **Workflow hot-reload.** `workflow_sha` is pinned at enqueue time.

**Team topology.** The unit of sharing is the run, never the store. Each store is single-user and stays private to its machine; runs travel between trusted stores as `.fragua` bundles (`fragua runs export` / `fragua import`). A bundle carries the run's event log, transcript, canonical workflow, and artifact blobs — never the provider/credential tables — and text payloads are scrubbed on export; a live credential embedded verbatim in a *binary* blob is not scrubbed, and export warns loudly that the bundle is secret-bearing. CI is the one delegated execution context: an ephemeral job runs against its own throwaway store, with secrets gated by the CI platform's permissions/environments (see the non-goals in §1).

**Also excluded by design:**

- **A manager-loop / supervisor-stack primitive.** Composition lives at the workflow level via separate runs sharing artifacts.
- **Pre/post tool hooks as workflow attributes.** The agent backend handles tool interception.
- **A blocking interviewer interface.** Human input is `human` nodes (`type: human`) plus the `intent.human_input` event — the executor parks the run, it never blocks on a person.
- **An `auto_status` node attribute.** Fragua handlers return a typed `HandlerResult`; there is no missing-status path to synthesize. Validator: `W014`.
- **A `loop_restart` edge attribute.** Context isolation happens at the node level: a node without `thread_id` runs fresh, a threaded node may set `summary=low|medium|high` for a summariser-compressed view. Full restarts happen by enqueueing a new run. Validator: `W014`.
- **Non-`wait_all` joins, cross-run fan-in, and dynamic forks.** The intra-run `parallel` fork-all → `wait_all` primitive ships (§3.1.1), but `wait_any` / `race` / `quorum` joins are excluded **by design** — they break the single-entry/single-exit invariant that keeps dominance (and thus budget / goal-gate scoping) well-defined. Fan-*in* across runs is likewise out of scope: composition across runs stays artifact-sharing, not a graph join. And a runtime-sized fork is out: a branch set is materialised at parse time, never streamed during dispatch.

**Surfaced as warnings, not errors:**

- Unknown attribute names on nodes / edges / graph (`W013`) — the YAML parser accepts any name through index-signature passthrough; the validator catches typos at validate-time.

Validator code lookup table: [`.agents/skills/workflows/references/validator-codes.md`](../.agents/skills/workflows/references/validator-codes.md).
