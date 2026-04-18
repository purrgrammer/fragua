# swarm — System Specification

> This document describes what swarm **is**. The companion `PLAN.md` describes how we build it incrementally.

---

## 1. Vision

**swarm** is a universal AI agent orchestrator. It takes a text-first declarative workflow (Graphviz DOT), executes it through a deterministic state machine that drives LLM-based agents across any provider, and produces a complete, replayable audit trail.

Core values, in priority order:

1. **Simple** — small number of primitives, obvious composition
2. **Testable** — pure core, first-class simulation, bit-identical replay
3. **Observable** — every LLM call, tool call, state transition is a typed event
4. **Flexible** — swap providers, models, environments, UIs without touching workflow logic
5. **Efficient** — reuses mature libraries (pi-mono) instead of rebuilding the stack

**North-star requirement:** as soon as the core is minimally functional (end of Phase 3), swarm must **build itself** — new features ship via swarm driving a `build-feature.dot` workflow on its own codebase.

**Non-goals (current scope):**
- Not a data-engineering orchestrator (Airflow / Dagster / Prefect territory)
- Not a cloud-scale workflow service (Temporal territory)
- Not a chat framework (LangChain / Pydantic-AI territory)
- Not a replacement for Claude Code or Codex — it *drives* them

---

## 2. System architecture

### 2.1 Three-layer stack

```
┌─────────────────────────────────────────────────────────┐
│  @swarm/*   Orchestrator layer (our code)               │
│             DOT graphs, handlers, checkpoint, events    │
├─────────────────────────────────────────────────────────┤
│  @mariozechner/pi-agent-core   Agent runtime            │
│             Stateful Agent, tools, steering, events     │
├─────────────────────────────────────────────────────────┤
│  @mariozechner/pi-ai           Unified LLM client       │
│             15+ providers, streaming, thinking, caching │
└─────────────────────────────────────────────────────────┘
```

swarm builds Layer 1 (orchestration) and adopts Layers 2 and 3 as dependencies. `@swarm/agent` is a thin wrapper that adds the pieces pi-agent-core is missing (checkpoint granularity, loop detection, per-tool truncation, permission modes, subagent helper, event sink bridge).

### 2.2 Hexagonal architecture (ports and adapters)

The orchestrator defines **five ports**. Every concrete dependency is an adapter behind one of these ports. The pure reducer core touches none of them directly.

| Port | Purpose | MVP adapter | Later adapters |
|---|---|---|---|
| `CodergenBackend` | Execute an LLM-driven node | `PiCodergenBackend`, `MockCodergenBackend` | Claude CLI subprocess, Codex CLI subprocess |
| `ExecutionEnvironment` | Where tools physically run | `LocalEnvironment`, `WorktreeEnvironment` | `DockerEnvironment`, `RemoteEnvironment` |
| `EventSink` | Where immutable events are written | `JsonlSink`, `InMemorySink` | `PostgresSink`, `OtelSink`, `SseSink` |
| `Interviewer` | Human-in-the-loop I/O | `AutoApprove`, `QueueInterviewer`, `ConsoleInterviewer` | `CallbackInterviewer`, `WebInterviewer` |
| `WorkspaceProvider` | Load workflows, agent profiles, skills | `LocalFsProvider` | `GitProvider`, `DbProvider` |

### 2.3 Package topology

All packages live under `/Users/bandarra/swarm/packages/`. The repo root IS `/Users/bandarra/swarm/`.

```
@swarm/core         Pure orchestrator — DOT engine, handlers, events (no I/O)
@swarm/agent        Thin wrapper on pi-agent-core with swarm middleware
@swarm/workspace    ExecutionEnvironment adapters + safety (blocklist, env-leak gate)
@swarm/events       EventSink adapters (JSONL, in-memory, later Postgres/OTel)
@swarm/cli          Single-command entry: swarm run | validate | replay | resume
@swarm/server       Hono HTTP + SSE (Phase 5)
@swarm/web          React + Vite + AI Elements dashboard (Phase 5)
```

---

## 3. Core primitives

### 3.1 Workflow (DOT)

A workflow is a Graphviz DOT file describing a directed graph. Nodes represent work; edges represent conditional transitions. swarm uses a strict subset of DOT compatible with the Attractor specification.

**Node shapes map to handlers:**

| Shape | Handler | Purpose |
|---|---|---|
| `Mdiamond` | `start` | Entry point (no-op) |
| `Msquare` | `exit` | Exit point (engine checks goal gates) |
| `box` (default) | `codergen` | LLM-driven task via `CodergenBackend` |
| `diamond` | `conditional` | Pass-through; engine evaluates conditions on outgoing edges |
| `hexagon` | `wait.human` | Pause for human approval via `Interviewer` |
| `component` | `parallel` | Fan-out to multiple branches |
| `tripleoctagon` | `parallel.fan_in` | Consolidate parallel results |
| `parallelogram` | `tool` | Execute a single tool (shell / script, no LLM) |
| `house` | `stack.manager_loop` | Supervisor polling loop (Phase 6) |
| `trapezium` | `loop` | Iterate a single node until a completion tag appears |

**Key attributes:**

- Graph-level: `goal`, `label`, `default_fidelity`, `default_max_retries`, `retry_target`, `fallback_retry_target`, `model_stylesheet`, `tool_hooks.pre`, `tool_hooks.post`
- Node: `prompt`, `model`, `provider`, `fidelity`, `thread_id`, `goal_gate`, `max_retries`, `timeout`, `allowed_tools`, `denied_tools`, `context: fresh|shared`, `reasoning_effort`, `idle_timeout`, `class`
- Edge: `label`, `condition`, `weight`, `fidelity` (override), `thread_id` (override), `loop_restart`

### 3.2 Context

A shared key-value store carried through a run. Always available to every node.

**Reserved namespaces:**

| Prefix | Owner | Purpose |
|---|---|---|
| `graph.*` | Engine | Mirrored graph attributes (`graph.goal`, `graph.run_id`) |
| `internal.*` | Engine | Retry counters, timing |
| `parallel.*` | Parallel handler | Branch results, counts |
| `work.*` | Parallel handler | Per-item context |
| `human.gate.*` | Human interviewer | Question / answer state |
| `context.*` | User | Free-form semantic state |

**Substitution in prompts:**
- `${context.key}` — read context KV
- `$nodeId.output` — reference a prior node's output (stolen from Archon; string substitution, shell-safe variant for bash nodes)
- `$ARGUMENTS`, `$1`, `$2`, `$ARTIFACTS_DIR`, `$LOOP_USER_INPUT` — CLI and loop helpers

### 3.3 Fidelity

Controls how much conversation history flows from one node to the next. Six modes per Attractor spec:

| Mode | Session | Carried | LLM cost |
|---|---|---|---|
| `full` | Reused via `thread_id` | Complete history | None |
| `truncate` | Fresh | `graph.goal` + `run_id` only | None |
| `compact` | Fresh | Tier 1+2: tool-result placeholders + `<scratchpad>` / `<artifact>` extraction | None |
| `summary:low` | Fresh | Deterministic template (~600 tokens) | None |
| `summary:medium` | Fresh | Tier 3 LLM narrative (~1500 tokens) | 1 call |
| `summary:high` | Fresh | Tier 3 LLM with broader scope (~3000 tokens) | 1 call |

**Resolution chain** (highest priority wins): edge attr → target node attr → graph default → hard default (`compact`).

**Session model.** pi-agent-core's `sessionId` is a provider-cache hint only; it does not restore messages. swarm owns a per-backend `MessageStore` (keyed by `thread_id`) that performs the actual transcript hydration:

| Fidelity | Hydrate from store | Persist to store | `sessionId` bucket (cache) |
|---|---|---|---|
| `full` | yes | yes | `thread_id` |
| `truncate` | no | no | `thread_id:truncate` |
| `compact` | no | no | `thread_id:compact` |
| `summary:low` | no | no | `thread_id:summary:low` |
| `summary:medium` | no | no | `thread_id:summary:medium` |
| `summary:high` | no | no | `thread_id:summary:high` |

Non-`full` modes are fresh sessions, so they neither read nor write the store. They do still receive a deterministic **fidelity seed** prepended to the user prompt — a `<swarm-context>` block carrying `graph.goal`, `run_id`, and (for `compact` / `summary:*`) a digest of the prior transcript the thread would have restored. Seeds are pure and deterministic in Wave 2; `summary:medium` and `summary:high` emit a soft `agent.warning` and fall back to `summary:low` behaviour until the summariser backend lands (Wave 2b).

**Node-level overrides:**

- `context = "fresh"` — hard opt-out of any cross-node transcript sharing, even when `fidelity=full` and `thread_id` match. Neither hydrates nor persists; `sessionId` is omitted so the call stands entirely alone.
- `system_prompt = "…"` — replaces the backend's global system prompt for this call (the `<project-conventions>` block from `context_files` is still prepended). Use for reviewer / planner subagents that need a different persona.

**Summarizer config** (Wave 2b): separate model (defaults to Haiku / mini), configurable per project, saves ~90 % vs. using the node's Opus / GPT-5 for summarization. Until it ships, `summary:medium` / `summary:high` are functionally `summary:low`.

**Thread ID resolution:** edge → node → graph-level default → subgraph-derived class → previous node ID.

### 3.4 Tools

Agnostic execution primitives exposed to agents. Tools are registered in a **namespaced registry** to prevent collisions:

- `local:*` — built-in tools (read_file, write_file, bash, grep, glob, edit_file, apply_patch)
- `mcp:*` — loaded from MCP servers (Phase 6)
- `skill:*` — loaded from Claude SKILL.md playbooks (Phase 6)
- `custom:*` — user-registered

**Tool contract (illustrative — TypeBox in code):**
```
{
  name: string,
  description: string,
  parameters: TypeBox schema,
  execute: (args, env) => Promise<ToolResult>,
  idempotent: boolean,      // default false; dangerous tools require human approval on resume
  truncation: {             // char-first-then-line, matching Attractor spec
    max_chars: number,
    mode: "head_tail" | "tail",
    max_lines?: number
  }
}
```

**Default per-tool limits** (from Attractor Coding Agent Loop spec):

| Tool | Max chars | Mode | Max lines |
|---|---|---|---|
| `read_file` | 50 000 | head_tail | — |
| `shell` | 30 000 | head_tail | 256 |
| `grep` | 20 000 | tail | 200 |
| `glob` | 20 000 | tail | 500 |
| `edit_file` | 10 000 | tail | — |
| `apply_patch` | 10 000 | tail | — |
| `write_file` | 1 000 | tail | — |

### 3.5 Events

Immutable records of everything that happens. The event log is the system's backbone — everything else (UI, replay, cost reports, debugging) derives from it.

**Naming convention:** `{domain}.{action}_{state}` (e.g., `workflow.node_started`, `tool.execution_completed`). Easy to grep and aggregate.

**Event types (MVP set):**

| Category | Events |
|---|---|
| Pipeline | `pipeline_started`, `pipeline_completed`, `pipeline_failed` |
| Node | `node_started`, `node_completed`, `node_failed`, `node_retrying`, `node_skipped` |
| Edge | `edge_selected` (with the 5-step priority rule that matched) |
| Checkpoint | `checkpoint_saved` |
| Interview | `interview_started`, `interview_completed`, `interview_timeout` |
| Agent (bridged from pi) | `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end` |
| LLM (bridged from pi) | `llm_start`, `text_delta`, `thinking_delta`, `toolcall_delta`, `llm_done`, `llm_error` |
| Tool | `tool_execution_start`, `tool_execution_update`, `tool_execution_end` |
| Steering | `steering_requested`, `steering_injected` |
| Cost | `cost_recorded` (per turn, from pi's `usage.cost`) |

**Event schema** (stored as JSONL, one per line):
```
{
  "run_id": string,
  "session_id": string,
  "node_id": string | null,
  "type": string,
  "timestamp": ISO8601,
  "workflow_sha": string,    // for post-hoc reproducibility
  "schema_version": number,  // envelope version (current: 1)
  "data": { ... type-specific }
}
```

`schema_version` is optional on read. Pre-versioned JSONL (runs from before P6/Wave-1) omits the field; consumers treat `undefined` as `1` for back-compat. Additive field changes to `data` do **not** bump the envelope version — only incompatible renames/removals on the envelope itself do. Runtime validation is available via `@swarm/events` → `validateEvent(raw, { checkPayload })`; the envelope check is always strict, the per-`type` payload check is opt-in so a single payload rename doesn't break replay of older fixtures.

**Observability invariant:** the event log is the single source of truth. Everything a debugger or replayer needs must be on an event — no out-of-band state. Two payloads carry the LLM-call inputs so nothing is "in memory only":

- `node.started.data` — static, pre-substitution inputs (`node_type`, `prompt_template`, `context_keys`, `node_outputs_in_scope`, `model`, `provider`, `thread_id`, `fidelity`, `allowed_tools`, `denied_tools`, `context_files`). One per node execution.
- `llm.start.data` — the resolved call snapshot emitted by the backend before `agent.prompt()`. Fires once per `backend.run()` (once per codergen node, N times for a loop node with N iterations). Post-Wave-1 shape:
  - Always: `provider`, `model`, `prompt`, `system_prompt`
  - When present: `thread_id`, `allowed_tools`, `denied_tools`
  - `iteration: { n, max }` on every loop-originated call
  - `messages: MessageSnapshot[]` — prior turns visible to the agent when `thread_id` restored an existing pi-agent-core session (omitted on fresh sessions)
  - `settings: { temperature?, max_tokens?, top_p?, reasoning_effort?, stop? }` — any generation knob set on the node
  - `context_files: { path, sha256, bytes, truncated, status }[]` — per-file records for every entry in `node.attrs.context_files` (drift-detectable on replay via sha256)
  - `budget: { cumulative_cost_usd, cumulative_tokens, max_cost_usd?, run_max_cost_usd? }` — read-only snapshot; only emitted when a ceiling is configured (Wave 4 will start emitting unconditionally with real cumulative counters)

`node.started` deliberately does NOT carry the resolved prompt, because loop handlers resolve a different prompt per iteration; the resolved text belongs on `llm.start`. `context_keys` lists scope keys without values to keep payloads bounded and avoid accidental secret leaks — debug modes can opt into value capture. The `context_files` array on `node.started` carries raw paths only (workflow-author intent); the resolved records with hashes live on `llm.start.context_files`.

**Duplication policy:** events are optimised for stateless replay, so some redundancy is tolerated — `duration_ms` on `node.completed` is derivable from timestamps, `retry_count` from counting prior `node.retrying` events, both kept for reader ergonomics. `outcome.notes` duplicates the agent's final assistant text that also streams through `llm.text_delta` / `agent.message_*`; the duplication is load-bearing because `$nodeId.output` substitution and `<promise>` / `<abort>` markers run against `notes`. UIs that render a conversation should read from the message stream, not from `notes`.

### 3.6 Checkpoint

Written atomically after every node transition to `.swarm/runs/<run-id>/checkpoint.json`. Enables crash recovery and resume-from-arbitrary-point debugging.

```
{
  "run_id": string,
  "workflow_sha": string,
  "current_node": string,
  "completed_nodes": string[],
  "node_outcomes": { [nodeId]: Outcome },
  "context": { ... },
  "retry_counts": { [nodeId]: number },
  "pi_sessions": { [threadId]: SerializedSession }
}
```

**Resume degradation rule** (per Attractor spec): if a node used `fidelity=full` and we're resuming after a crash, the first resumed node degrades to `summary:high` (in-memory LLM sessions can't always be serialized perfectly).

**Non-idempotent tools on resume:** if the last event is `tool_execution_start` without matching `tool_execution_end` for a tool declared `idempotent: false`, engine raises `ResumeRequiresApproval` and routes to `Interviewer`.

### 3.7 Outcome

Every handler returns an `Outcome`:
```
{
  status: "success" | "partial_success" | "fail" | "retry" | "skipped",
  context_updates: { [key]: value },
  preferred_label: string,      // for edge selection by label match
  suggested_next_ids: string[], // for edge selection by target match
  notes: string,
  failure_reason?: string,
  next_node_override?: string,  // bypass edge selection entirely
  non_retryable?: boolean       // fail must NOT trigger a goal-gate retry
}
```

**Agent self-abort (`<abort>…</abort>`).** Agent-backed nodes can signal an intentional stop by emitting `<abort>reason</abort>` anywhere in their final message. The agent backend parses it and returns a `fail` outcome with `non_retryable: true` and `failure_reason = reason`. Workflows route aborts with `condition="outcome=fail"` edges to a terminal node; the `non_retryable` flag prevents the goal-gate retry machinery (§4) from relaunching the pipeline after an explicit stop. Use this for "target is missing / contradictory / blocked" situations — it's the machine-readable counterpart to human-readable markers like `PLAN_BLOCKED:` / `EXPLORE_BLOCKED:`.

### 3.8 Edge selection (5-step deterministic priority)

When a node completes, the engine picks the next edge using this exact order:

1. **Condition-matched edges** (`condition` expression evaluates true against context + outcome)
2. **Preferred label match** (outcome's `preferred_label` matches an unconditional edge's `label` after normalization)
3. **Suggested next IDs** (outcome's `suggested_next_ids` contains an unconditional edge's target)
4. **Highest `weight`** among remaining unconditional edges (default 0)
5. **Lexical tiebreak** on target node ID

**Condition expression language:** minimal by design — `=`, `!=`, `&&` only. Example: `outcome=success && context.tests_passed=true`.

### 3.9 Interviewer

Single interface for all human-in-the-loop, including `wait.human` nodes, tool approval gates, and resume approvals:
```
interface Interviewer {
  ask(question: Question): Promise<Answer>
  ask_multiple(questions: Question[]): Promise<Answer[]>
  inform(message: string, stage: string): void
}
```

Built-in implementations:
- `AutoApproveInterviewer` — always YES; default for CI / automated runs
- `QueueInterviewer` — pre-filled answers; deterministic tests
- `ConsoleInterviewer` — CLI prompts with timeout + default
- `CallbackInterviewer` — delegate to async callback (web UI, Slack, etc.)
- `RecordingInterviewer` — wrapper that logs all exchanges for later replay

---

## 4. Execution model

### 4.1 Lifecycle

```
PARSE → TRANSFORM → VALIDATE → INITIALIZE → EXECUTE → FINALIZE
```

1. **Parse** DOT into a typed AST
2. **Transform** — apply model stylesheet, expand variables, custom AST transforms
3. **Validate** — lint rules catch orphans, missing fail-edges, cycles without exits, undefined refs
4. **Initialize** — create run dir, seed context from graph attrs, first checkpoint
5. **Execute** — traverse from start node, dispatching to handlers (see 4.2)
6. **Finalize** — write final checkpoint, emit completion events, cleanup worktree

### 4.2 Execution loop (pseudocode)

```
loop:
  if is_terminal(current_node):
    # `non_retryable` failures (e.g. agent <abort>) bypass goal-gate retry
    # and propagate the original failure reason untouched.
    if any_outcome.non_retryable and any_outcome.status == "fail":
      return that_outcome
    if not goal_gates_ok():
      current_node = retry_target or fallback_retry_target
      continue
    return success

  outcome = execute_with_retry(current_node)
  completed_nodes.append(current_node.id)
  node_outcomes[current_node.id] = outcome
  context.apply(outcome.context_updates)
  context.set("outcome", outcome.status)
  emit("node_completed", ...)
  save_checkpoint()

  next_edge = select_edge(current_node, outcome, context)
  if not next_edge:
    return outcome.status == "fail" ? fail : success
  if next_edge.loop_restart:
    restart_run(start_at=next_edge.target)
    return
  current_node = next_edge.target
```

### 4.3 Parallelism

Parallel handlers clone context per branch, execute branches (isolated via git worktrees in Phase 3+), and merge only via `outcome.context_updates`. `parallel.fan_in` aggregates branch outcomes, optionally using an LLM to rank candidates.

**Join policies:** `wait_all` (default) or `first_success`.

### 4.4 Permissions pipeline

Every tool call flows through a middleware chain:

```
tool_call → blocklist → env_leak_check → permission_mode → execute
```

**Permission modes:**
- `unsafe` (MVP default) — run everything the blocklist allows
- `classifier` (Phase 6) — cheap model evaluates alignment with user intent, denies misaligned calls, 3-consecutive-denial halt
- `interactive` (Phase 6) — route via `Interviewer` for every non-trivial call

**Default blocklist patterns** (refused outright, no prompting):
- `rm -rf /*`, `rm -rf ~*`, `rm -rf .`, `rm -rf ..`
- `sudo *`
- `curl *| *sh`, `wget *| *sh`
- Writes outside the session's worktree
- `git push --force` to protected branches

**Env-leak gate:** when registering a codebase, scan `.env` for patterns matching `*_API_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_CREDENTIAL`. Block unless explicitly allowed. Cheap security; catches real mistakes.

---

## 5. Observability

### 5.1 Event log

Append-only JSONL at `.swarm/runs/<run-id>/events.jsonl`. One line per event. Fully replayable: `swarm replay events.jsonl --dry-run` reconstructs final state deterministically.

### 5.2 CLI

```
swarm run <workflow.dot> [--input=...] [--interviewer=auto|console|queue]
swarm validate <workflow.dot>
swarm replay <events.jsonl> [--dry-run]
swarm resume <run-id>
swarm steer <session-id> "<message>"
swarm approve <session-id> [response]
swarm dashboard                  # Ink TUI (Phase 5)
swarm serve [--port=3000]        # HTTP + Web UI (Phase 5)
```

### 5.3 TUI (Phase 5)

Ink-based terminal UI. Top pane: live DOT graph with active node highlighted. Bottom pane: streaming text deltas + tool calls + cost ticker. Keybinds for steering, approving, aborting.

### 5.4 Web UI (Phase 5)

React + Vite + Tailwind. The web surface standardizes on **Vercel AI Elements** end-to-end:
- **Graph view** — AI Elements `Workflow` (`Canvas` / `Node` / `Edge` / `Connection` / `Controls` / `Panel` / `Toolbar`) with active-node highlight and clickable nodes
- **Step drilldown** — AI Elements `Conversation`, `Message`, `Response`, `Reasoning`, `Tool`, `Task`, `Chain of Thought`, `Sources` reconstruct each node's full session (turns, thinking, tool calls, results)
- **Steering / human-in-the-loop** — AI Elements `Checkpoint`, `Confirmation`, `Suggestion`, `Queue`, `Prompt Input`
- **Dashboard shell** — persistent sidepanel (Home / Workflows / Pipelines / Settings) + cost panel; streaming visualization with progressive disclosure

The `Graph` data shape (from `@swarm/core`) is the stable contract; the renderer is an AI Elements component and replaceable without touching the data layer.

**Real-time updates** via Server-Sent Events from `@swarm/server` (`GET /api/runs/:id/events`).

### 5.5 Cost attribution

Every `AssistantMessage` from pi-ai carries `usage.cost` (input / output / cache read / cache write, all in dollars). swarm aggregates per: run, node, session, model, tool. Cost reports reconcile with provider billing within 1 %.

---

## 6. Testing strategy

### 6.1 Test pyramid

1. **Unit tests** on every pure function — >90 % coverage target for `@swarm/core` and `@swarm/agent`
2. **Property-based fuzz tests** on all parsers (DOT, conditions, substitutions) using `fast-check`
3. **Integration tests** with `PiMockBackend` + `QueueInterviewer` — zero API cost, fully deterministic, run in seconds
4. **E2E tests** against real Claude Haiku on nightly CI — gated behind `ANTHROPIC_API_KEY`
5. **Self-hosting test** (Phase 3+) — swarm implements a new feature in swarm via `build-feature.dot`, nightly

### 6.2 Invariants we test

- **Reducer purity:** running the engine with identical inputs produces identical outputs
- **Event log replay:** any run's JSONL replayed produces the same final state
- **Checkpoint round-trip:** stop at any node, serialize, load into fresh engine, resume → identical end-state
- **Provider equivalence:** the same workflow running on Claude / GPT-5 / Gemini produces the same structural event log (types and order; content differs)
- **Worktree isolation:** three concurrent runs on the same repo don't corrupt each other

### 6.3 Performance budget

- `@swarm/core` test suite: < 5 s
- `@swarm/agent` test suite (mocked): < 30 s
- Full E2E suite: < 5 min
- DOT parse: < 10 ms for 100-node graphs
- Checkpoint write: < 20 ms

### 6.4 Mock strategy

- **LLM layer:** pi-ai's `registerFauxProvider()` — scripts exact `AssistantMessage` returns, including thinking blocks, tool calls, cache hits
- **Agent layer:** `PiMockBackend` wraps faux provider and exposes scripted `(request) => response` API
- **Environment layer:** `MockExecutionEnvironment` — in-memory JSON filesystem, scripted command outputs
- **Interviewer:** `QueueInterviewer` — prefilled answer queue

---

## 7. Dependencies

### 7.1 Adopt (don't build)

| Package | Role | Phase |
|---|---|---|
| `@mariozechner/pi-ai` | Unified LLM client (15+ providers, streaming, thinking, caching) | 2 |
| `@mariozechner/pi-agent-core` | Agent runtime (stateful Agent, tools, steering, 22 event types) | 2 |
| `@sinclair/typebox` | Runtime schemas for tool params, events, checkpoints | 1 |
| `pino` | Structured logging (`{domain}.{action}_{state}` naming) | 2 |
| `chalk` | Terminal output | 2 |
| `fast-check` | Property-based fuzz testing | 1 |
| `cac` | CLI framework | 2 |
| `ink` + `ink-spinner` + `ink-big-text` | TUI | 5 |
| `hono` + Bun adapter | HTTP server | 5 |
| `react`, `react-dom`, `vite` | Web UI | 5 |
| Vercel **AI Elements** | End-to-end web UI vocabulary: `Workflow` graph, Chatbot drilldown, human-in-the-loop steering | 5 |
| `tailwindcss`, `@shadcn/ui`, `zustand` | Web UI support | 5 |
| `pg` | Postgres adapter | 6 |
| `@modelcontextprotocol/sdk` | MCP adapter | 6 |

### 7.2 Version pinning policy

All adopted packages pinned to **exact** versions via `package.json`. `bun.lock` committed. Bumps require CHANGELOG review + a passing full test suite.

### 7.3 Runtime

- Bun ≥ 1.2 (primary target) — native TypeScript, fast startup, built-in test runner
- Node ≥ 20 (compatibility) — must remain supported for pi-mono peer-dep reasons

---

## 8. Resuming after interruption

If any session is interrupted, the full project state is in:
- `docs/SPEC.md` (this file) — what the system is
- `docs/PLAN.md` — the phased build plan with verification bars
- `AGENTS.md` at the repo root — conventions and commands
- Every run's `.swarm/runs/<id>/events.jsonl` — full audit trail of what was tried
- `package.json` pinned versions — prevent drift

A new agent (human or AI) with these docs and `git log` has the complete picture.
