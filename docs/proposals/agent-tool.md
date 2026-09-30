---
title: "`agent` tool — orchestrator-workers inside an `llm` turn"
summary: "An opt-in LLM-callable tool, `agent({ task, … })`, that runs a bounded worker agent loop INSIDE the calling `llm` turn: same run, same worktree, fresh context, a tool subset of the caller's, its own cost cap, its own addressable transcript, and typed outputs back. It is the orchestrator-workers pattern — fan-out whose width the model decides at runtime — placed in the one region of the engine that is already non-deterministic (the handler), so the graph still sees one node, one turn, one `fact.node_completed`. NOT a child run: the motivating consumer (`work::implement` delegating disjoint packages of one plan) needs workers writing into ONE tree, which the Model M child-run spine (isolated worktree per child) cannot hand back without a merge step. Synthesised per call in `@fragua/agent` beside `route` / `emit_output` (workspace cannot see the backend). Worker messages persist in the parent run's `messages` under a reserved synthetic node id, `__agent.<caller>#<iteration>/<tool-call-id>`, the same device the summariser and auto-titler already use for their event envelopes (`__summary.*`), so neither hydration path (`node_id`-matched explicit threads, `(nodeId, iteration, pass)`-matched synthetic threads) can absorb a worker transcript, and the UI folds each worker under its tool call. Cost lands as `cost.recorded` on the calling node through the same emit, so the daemon's existing per-node / per-run enforcement hook counts worker spend live; a per-worker cap is a tool argument with a config-cascade default. Crash mid-worker surfaces to the caller as a dangling non-idempotent tool call (existing `sanitiseUnpairedToolCalls` path), never a silent re-run. No new fact type, no `EVENT_CONTRACT_VERSION`, `ir_version`, or `schema_version` bump; one reserved node-id prefix, one `agent:` config block, one validator warning and one error. Depth is 1 (the worker's toolset strips `agent`). The call takes the `llm` step's own knobs (tools, model / provider / effort, skills, context files, typed `outputs:`, caps), each clamped to the caller's; typed outputs ship in v1, returned in the tool result through the same forced `emit_output` + TypeBox validation an `llm` step uses. Doors: indexed worker outputs, resumable workers, `agent({ workflow })` as runtime Model M, depth > 1, targeted steer."
status: proposal
maturity: sketch
last-reviewed: 2026-09-30
---

# `agent` tool — orchestrator-workers inside an `llm` turn

> **Status: sketch, unreviewed.** Drafted while preparing the agentic-workflows
> workshop, where the pattern table had one hole: orchestrator-workers. Every
> other pattern in Anthropic's *Building Effective Agents* maps to a fragua step
> type or edge shape; this one maps to a **tool inside a step**, and the tool
> does not exist. Additive. One new LLM-callable tool, one reserved synthetic
> node-id prefix, one config block, one warning and one error code. No new node kind,
> no new fact, no migration.

## The problem

`work::implement` realises a plan that names several packages. Today it does so
in one context: every file of every package, every typecheck cycle, every
detour, in one transcript that the reviewer then has to read past. The pattern
that fixes this is the one the article calls **orchestrator-workers**: a
central agent "dynamically breaks down tasks, delegates them to worker LLMs,
and synthesizes their results", and it is "well-suited for complex tasks where
you can't predict the subtasks needed".

fragua has no way to say it. `parallel` is the wrong tool on purpose: its branch
set is static per run, materialised at parse time (SPEC §3.1.1), and its
branches are read-class. The plan is only known after `plan` runs, and the
workers write. `type: workflow` / Model M (`workflow-as-step.md`,
`fan-out-runs.md`) spawn full child runs, each with an **isolated** worktree,
and the parent joins on typed outputs, not on a tree. A worker that edited
`packages/store` in its own worktree has produced a diff the orchestrator would
have to merge; that is `converge.yaml`'s job, not `implement`'s.

What the orchestrator needs is smaller than a run and larger than a tool call:
a **fresh context**, a **bounded budget**, a **narrowed toolset**, **the same
tree**, and a **transcript someone can open afterwards**. That is a worker.

## The design

### Decision: a tool, not a step; in the turn, not a child run

```yaml
implement:
  type: llm
  thread: build
  allowed-tools: [read, write, edit, bash, agent]     # opt-in, like web_fetch
  prompt: |
    Realise the plan. For each package the plan names, delegate that package's
    slice to an `agent` with only what it needs, then integrate and run the
    cross-package typecheck yourself.
```

The model calls it with the `llm` step's own vocabulary — the tool is a full
`llm` step minus the things only a graph node has (a `thread:`, `routes:`, a
`summary:` view, a place in the topology). Every knob is a **subset** of the
caller's:

```jsonc
agent({
  "task": "In packages/store: add the parent_run_id column + migration per the plan. Run `bun test ./packages/store`.",
  "allowed_tools": ["read", "write", "edit", "bash"],   // ⊆ caller's effective set; default = caller's set minus `agent`
  "denied_tools": ["web_fetch"],                        // optional, subtractive
  "model": "claude-sonnet-4-6",                          // optional; default = caller's; must be registered
  "provider": "anthropic",                               // optional; default = caller's
  "effort": "medium",                                    // optional; default = caller's
  "skills": ["backend"],                                 // optional; ⊆ caller's effective catalogue
  "context_files": ["docs/ARCHITECTURE.md"],            // optional; same semantics as the step attr
  "outputs": {                                           // optional; the step `outputs:` grammar, verbatim
    "files_touched": { "type": "array", "items": { "type": "string" } },
    "tests_pass":    { "type": "boolean" }
  },
  "max_cost_usd": 1.50,                                  // optional; default config `agent.max-cost`
  "max_tokens": 200000,                                  // optional
  "timeout_minutes": 10                                  // optional; default config `agent.timeout-minutes`
})
```

and gets back one tool result:

```jsonc
{ "text": "<the worker's final assistant message>",
  "outputs": { "files_touched": ["packages/store/src/schema.sql", "…"], "tests_pass": true },   // present iff `outputs` was declared
  "cost_usd": 0.83, "turns": 14, "tool_calls": 31,
  "worker_id": "toolu_01…",                              // the provider tool-call id; the read plane resolves it
  "status": "completed" | "aborted" | "max_cost" | "max_turns" | "timeout" | "error" }
```

**Typed outputs are in v1.** When `outputs` is declared the worker gets a
forced `emit_output` built from that schema by the same `buildEmitOutputTool`
the `llm` step uses, with the same one corrective re-prompt on a missed exit,
and the struct is validated by the same compiled TypeBox schema before it
reaches the caller. A worker that finishes without a valid struct returns
`status: "error"` with the validation message in `text`; the caller decides —
that is the tool-call analogue of the fail-closed node rule, scoped to the
worker rather than the run. A malformed `outputs` schema in the call (the
E033/E034 grammar violations) is a tool error before any model call. Worker
outputs are **returned, not indexed**: they do not enter the run's `outputs`
index or the `${{ outputs.X.f }}` namespace, because the graph has no node to
address them by; the caller's own `emit_output` is how a value crosses to the
next step.

Why this shape and not the two neighbours:

| | `agent` tool (this) | `parallel` node | child run (Model M) |
|---|---|---|---|
| Who decides N | the model, at runtime | the author, at parse time | the author (`map: over`) |
| Worktree | **shared with the caller** | shared, read-only | isolated per child |
| Writes | yes (author-partitioned) | no (E042) | yes, into its own tree |
| Log | messages under the parent run, own synthetic node id | facts per sub-node | own run, own log |
| Recovery unit | the calling turn | the sub-node | the child's node |
| Graph sees | one node, one fact | a frontier | a parked parent |

The table is the argument. Orchestrator-workers is defined by "N decided at
runtime" and, for the write-class consumer, by "one tree". Neither neighbour
offers both. The cost of getting both is **recovery granularity**: a crash
mid-worker re-enters the calling *turn*, not the worker. That is the same
granularity every long `bash` call already has, and the same trade the handler
contract already names: "a handler is the one place where non-determinism
legitimately enters the loop". The fan-out lives there, so the control plane
stays a pure fold.

What "own event log" becomes under this decision: **own transcript, addressable
by id, inside the parent's log.** A worker has no `run_state`, no facts, no
budget row of its own. It has rows in `messages` under a node id that is
uniquely its own, a cost line per turn, and a status the caller read. If a
consumer later needs a worker with its own run (isolated tree, typed outputs,
lineage), that is the `agent({ workflow })` Door below, and it rides the Model M
spine rather than this tool's.

### Cite-and-override — SPEC §5

Two exclusions are in range. Quoted:

> **A manager-loop / supervisor-stack primitive.** Composition lives at the
> workflow level via separate runs sharing artifacts.

> **Non-`wait_all` joins, cross-run fan-in, and dynamic forks.** … And a
> runtime-sized fork is out: a branch set is materialised at parse time, never
> streamed during dispatch.

**Neither is overridden; both are respected by construction.** The `agent` tool
adds no primitive to the graph: no node kind, no edge, no fact, no branch. The
"fork" is inside one handler invocation, invisible to `planTransition`, and the
branch set of every `parallel` node stays static. What §5 protects — dominance,
budget scoping, the log as a pure fold — is untouched because the graph never
learns the workers existed except through `cost.recorded` and `messages`. At
ship time §5 gains one clarifying sentence under the dynamic-forks bullet: *a
runtime-sized fan-out is available inside an `llm` turn via the `agent` tool;
it is a tool call, not a fork — the graph sees one node.* §3.1 needs no change.

### Where it is built — `@fragua/agent`, synthesised per call

`@fragua/workspace` cannot host it: the package depends on `core` and `types`
only, and a worker needs the LLM backend, the model registry, the persist sink,
the emit hook, and the steering registry. The `judge` tool got away with living
in workspace because its client rides `FraguaToolContext`; the agent tool's
dependencies are the backend itself.

So it is built where `route` and `emit_output` are: `PiLlmBackend` synthesises
it per call (`buildAgentTool(...)` beside `buildRouteTool` / `buildEmitOutputTool`
in `backend.ts`), closing over exactly what that call already has in scope —
the effective env (already read-only-wrapped when the caller is read-class),
the caller's effective tool set, `persistMessage`, `emit`, the steering
registry, the abort signal. Unlike `route` / `emit_output` it is **not
force-included**: it appears only when `allowed-tools` names `agent`, on the
same terms as `web_fetch`. A node that lists it but is a `parallel` branch is
allowed — the branch's read-only env wrap applies to the worker too, so a
worker there is a read-only researcher.

Each worker is a second `Agent` (pi-agent-core) constructed by the same
`new Agent({...})` path the caller used, through the same `resolveEnvAndSkills`
/ `buildSystemPromptForCall` / tool-selection helpers, with the call's
arguments standing in for node attrs and every one clamped to the caller:

- **prompt** = `task`; **system prompt** built as for an `llm` step from the
  worker's effective skills and `context_files`.
- **tools** = `select({ allow: args.allowed_tools ?? callerEffective, deny: args.denied_tools })`
  ∩ caller's effective set, then **strip `agent`** (depth 1), strip `route`
  (a worker has no edge to select), add `emit_output` iff `outputs` was
  declared, keep `abort` re-bound so that a worker `abort` ends the *worker*
  with `status: "aborted"` and the reason in `text` — it never halts the run.
  `judge`, `skill`, and materialised `mcp__*` tools pass through under their
  existing terms (a worker may narrow the caller's MCP set, never widen it).
- **model / provider / effort** = the call's, else the caller's; the model must
  resolve in the registry or the tool returns `status: "error"` before any call.
- **skills** = the call's list ∩ the caller's effective catalogue.
- **no `thread`, no `summary`, no `routes`.** Continuity across workers is the
  caller's context; a worker is one bounded conversation that ends.
- **node id for persistence** = `agentSyntheticNodeId(callerNodeId, iteration, toolCallId)`
  → `__agent.<caller>#<n>/<toolCallId>` (below).

### Transcript — a reserved synthetic node id, not a column

The hazard is precise, and it has two faces because fragua has two hydration
paths (`handler-bridge.ts`):

- an **explicit `thread:` member** hydrates by `node_id` match
  (`loadPriorMessagesForThread`: rows whose `nodeId === threadId`, falling back
  to **every row in the run** when none match);
- a **threadless node** hydrates by `(nodeId, iteration, pass)`
  (`loadPriorMessagesForNode`).

`work::implement` is `thread: build`, so it is the first path that matters. A
worker row stamped with the caller's `node_id` would hydrate into `build` — for
`implement` *and* for `review`, which shares the thread — on the next resume,
and a row stamped with any id that happens to match nothing would still arrive
through the graph-level fallback.

The engine already solved this once. The summariser and the auto-titler run a
nested model loop inside a turn and persist under a **reserved synthetic node
id**: `__summary.<caller>#<n>` / `__summary.title`
(`SYNTHETIC_NODE_PREFIX` in `packages/core/src/types/summariser.ts`), which
"lets the UI render it as a lightweight step without it participating in graph
routing". Workers take the same device:

- **`__agent.<caller>#<iteration>/<toolCallId>`** on every worker row,
  `iteration` and `pass` copied from the caller. `__agent` joins `__summary` as
  a reserved prefix; the parser rejects an authored step id starting with `__`
  (it already reserves `start` / `exit`; this generalises the rule — one new
  E-code).
- **Both hydration loaders exclude synthetic-prefixed rows explicitly** — a
  shared `isSyntheticNodeId(nodeId)` predicate beside `NON_LLM_CONTEXT_ROLES`.
  This is what closes the graph-level fallback. It is new work, not a
  port: the summariser never writes to `messages` at all (it emits
  `summary.*` / `cost.recorded` events under its synthetic id and keeps its
  turns in memory), so workers are the **first** nested loop whose rows land
  in the table, and the first for which the fallback would leak. The
  predicate is the one behavioural change to existing code.
- **No `thread_id` column.** `deterministic-thread-id.md` designed that column
  for a different problem (two concurrent branches on one explicit thread) and
  it remains independent; the worker discriminator is the node id, and nothing
  in GC, export, or scrubbing keys on `node_id` (messages cascade on `run_id`;
  export is per run), so worker rows travel and die with the run exactly as
  the caller's do.
- **Read plane / UI**: the messages projection already carries `node_id`; the
  conversation view folds rows whose `node_id` starts with `__agent.` under the
  caller's `agent` tool-call bubble (collapsed, `status` + `cost_usd` in the
  header), matched by the `<toolCallId>` suffix ⇄ the tool call's id.
  `fragua runs tail` prints them indented.

### Accounting

A worker emits `cost.recorded` through the same `input.emit` the caller uses
(the `costPayload` emit on `message_end` in `backend.ts`). The daemon's
`onCostRecorded` hook (`dispatch-turn.ts`) mirrors every one of those into the
node bucket and the run total and **aborts the steer controller when the node
`max-cost` or the run `budget` is breached**, mid-turn. So the caps compose
without new plumbing, innermost first:

1. **Per worker** — `max_cost_usd` argument, default `agent.max-cost` from the
   config cascade (global `~/.fragua/config.yaml`, project override). Enforced
   inside the tool by summing the worker's own `message_end` costs; the worker
   stops with `status: "max_cost"` and the caller decides.
2. **Per node** — the caller's own `max-cost`. Worker spend lands in the same
   node bucket the hook reads, so the cap now bounds caller plus workers.
3. **Per run** — `budget` / `budget-policy`. A breach trips the run's abort,
   which reaches every worker through the tool-adapter signal (below).
   Run-global, as SPEC §3.1.1 already rules for `parallel`.

`agent.max-turns` (config, default 50) and `agent.timeout-minutes` (config,
default 15) bound a worker that spends little but never stops; both surface as
their own `status`. `fact.node_completed.costUsd` for the caller therefore
equals caller turns plus worker turns, and `breakdownByModel` attributes worker
spend to the worker's model.

### Abort, steer, crash

- **Abort.** `toAgentTool` already threads the per-call `signal`; the tool
  wires it to `worker.abort()` exactly as `executePromptLoop` does for the
  caller. Pause / cancel / budget are run-global and reach the worker in one
  hop.
- **Steer.** `SteeringRegistry` already holds a live set per run so that
  multiple agents each calling `beginRun(runId, agent)` coexist. Workers
  register with a `SteerTarget` carrying the caller's `{ nodeId, iteration }`
  plus the worker id. v1 delivers an `intent.steer` to the **caller only** (the
  worker's context is the caller's to manage); targeting a worker is a Door.
- **Crash mid-worker.** The `agent` tool is `idempotent: false`,
  `idempotentOnReplay: false`. On daemon restart the caller rehydrates with an
  unpaired `agent` toolCall; `sanitiseUnpairedToolCalls` does what it does for
  `bash`: surfaces an error toolResult — *"worker <id> interrupted; its partial
  transcript is in the run; the tree may hold partial edits"* — and the caller
  decides whether to re-delegate. Worker rows written before the crash are
  durable and excluded from hydration by prefix, so the operator can open them
  and the caller never re-reads them as its own. Resuming the worker itself is
  a Door.

### Concurrency — honest, not isolated

pi-agent-core runs an assistant message's tool calls in parallel unless a tool
declares `executionMode: "sequential"`. The `agent` tool does **not** declare
it: an orchestrator that emits four `agent` calls in one message gets four
concurrent workers, bounded by `agent.concurrency` (config, default 4; excess
calls queue). They share one worktree. `write` / `edit` already serialise per
path through the env's mutation queue; `bash` does not serialise anything.
Partitioning is the prompt's job ("one package per worker"), exactly as it is
for a human lead handing out tickets. This is weaker than `parallel`'s
read-only guarantee and the doc says so; the workflow author opted in by
listing the tool.

### Validation

- **W023** — `allowed-tools` names `agent` on a node with no mutator tool
  (`bash` / `write` / `edit`). Legal (read-only researchers), but usually the
  author meant a `parallel` node, which is cheaper to reason about; the
  warning says so.
- **E058** — an authored step id starts with `__` (reserved for synthetic node
  ids: `__summary.*`, `__agent.*`). Today nothing stops `steps: { __summary.x: … }`.
- Nothing else. No new attribute (W013 stays quiet), no new kind, no new edge.

### Contract cost

- **`EVENT_CONTRACT_VERSION`: unchanged.** No new fact type; `cost.recorded`
  and `fact.node_completed` payloads are byte-identical in shape.
  `MIN_COMPATIBLE_CONTRACT_VERSION` untouched.
- **`ir_version`: unchanged.** v1 adds no `NodeAttrs`; opt-in is a tool name
  in the existing `allowed_tools` list, and caps live in config.
- **`schema_version`: unchanged.** The discriminator is a value in the
  existing `node_id` column.
- **Config schema** (`packages/cli/src/config.ts`): an `agent:` block beside
  `judge:` — `max-cost`, `max-turns`, `timeout-minutes`, `concurrency` (kebab,
  matching `bash.env-passthrough` / `auto-title`).
- **Core**: `agentSyntheticNodeId` + `isSyntheticNodeId` beside
  `summarySyntheticNodeId`; the hydration predicate in `handler-bridge.ts`.

## Doors (deferred, each additive)

- **Indexed worker outputs** — landing a worker's struct in the run's
  `outputs` index under an addressable name, so a *later step* can read it
  without the caller re-emitting. Needs a node-like identity for a worker in
  the substitution namespace; deferred until a consumer wants it.
- **Resumable workers** — persist the worker's tool-call id on a durable row
  and rehydrate the worker on the caller's resume instead of surfacing an
  error. Needs the worker's own `(iteration, pass)` epoch.
- **`agent({ workflow, inputs })`** — a runtime Model M child run: isolated
  worktree, typed outputs back, `parent_run_id` lineage, its own log. This is
  `workflow-as-step.md` with the model choosing N. It should reuse that spine
  when it lands, not fork it; the tool result would carry `child_run_id`.
- **Depth > 1** — keep `agent` in the worker's toolset behind `agent.max-depth`.
  Nothing structural blocks it; the budget maths and the node-id suffix both
  nest. Withheld until a consumer needs it.
- **Targeted steer** into a worker.

## Ship-time doc edits

- `docs/SPEC.md` §5 — the clarifying sentence under dynamic forks; §3.1 — the
  reserved `__` prefix beside `start` / `exit`.
- `docs/handler-contract.md` § Agent tools — a row for `agent`; § Replay
  semantics — the crash paragraph.
- `.agents/skills/workflows/SKILL.md` § The toolset — a row; § 1 Patterns —
  orchestrator-workers gains a fragua shape; `references/validator-codes.md`
  — W023, E058.
- `STATUS.md` — under Agents.

## Acceptance

`work.yaml::implement` on a three-package feature plan delegates one worker per
package; the run's conversation view shows three collapsed worker transcripts
under `implement`; `fact.node_completed.costUsd` equals the sum of caller plus
worker `cost.recorded`; a daemon kill mid-worker resumes `implement` with the
interrupted-worker toolResult in its transcript and **no `__agent.*` row in its
hydrated context**; and `review`, sharing `build`, hydrates none either.
