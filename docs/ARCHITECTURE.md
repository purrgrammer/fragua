# swarm — Architecture Notes

Companion to `SPEC.md`. Deeper dives, diagrams, and design decisions that don't fit in the spec.

## Reference implementations studied

The following repos are cloned under the swarm root for research and are **not committed** (see `.gitignore`):

- `attractor/` — the three NLSpecs that define the orchestrator, agent loop, and LLM client protocols we implement
- `Archon/` — a production YAML-based harness; source of several stolen ideas (`$nodeId.output`, loop node, env-leak gate, Hono + SSE stack, immutable sessions with parent chain)
- `pi-mono/` — the agent + LLM runtime we adopt (`@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`)

## Key design decisions and rationale

### Why DOT instead of YAML

Archon chose YAML; swarm chose DOT. Trade-off:
- DOT wins on free visualization (Graphviz → SVG)
- DOT matches Attractor spec exactly
- YAML wins on ergonomics (inline prompts, richer attribute types)
- We mitigate DOT's ergonomics loss by allowing prompts to be external `.md` files referenced by path

### Why pi-mono instead of building our own LLM / agent layer

pi-mono is essentially Attractor's Unified LLM + most of Coding Agent Loop, already implemented to production quality, with:
- 15+ providers under one interface (including cross-provider handoff — thinking blocks converted, tool-call IDs normalized)
- Mid-session model / provider swap via simple property assignment
- Deterministic faux provider for tests
- Per-session prompt-cache alignment
- Strict TypeScript + TypeBox schemas

Writing our own would cost 3-4 months and be strictly worse. Our `@swarm/agent` wrapper adds what pi-mono is missing: loop detection, subagents, per-tool truncation rules, checkpoint granularity, permission modes, event sink bridge.

### Why event-log-as-source-of-truth + checkpoint snapshot

Gemini proposed full event sourcing with materialized views. Attractor proposes `events + checkpoint.json after each node`. We chose Attractor's model:
- Operationally simpler (no projection rebuilds, no snapshot coordination)
- Sufficient for our replay / resume needs
- The checkpoint IS the "current-state projection" — no separate view store

### Why git worktrees + command blocklist (not CoW / Docker)

Gemini proposed OverlayFS / APFS native cloning. Industry converged on `git worktree` through 2025-2026 (Claude Code v2.1.50 ships `--worktree`, Archon uses worktree-per-workflow). Portable, proven, cheap.

For parallel runs that touch `node_modules`, symlink or rsync-clone ignored paths; avoid the race-condition rabbit hole.

Default permission mode is `unsafe` (yolo), but the command blocklist refuses the worst commands (`rm -rf /`, `sudo *`, `curl | sh`, writes outside worktree). Zero-cost safety floor; upgrade to classifier / interactive mode in Phase 6.

### Why Vercel AI Elements for the web UI

AI Elements ships production-grade React components for rendering multi-turn conversations with thinking blocks, tool calls, streaming deltas. Using them means:
- Better component quality than we'd build ourselves
- Community-maintained accessibility and UX polish
- Matches the Attractor spec's step-drilldown requirement out of the box

### Why the 5-port hexagonal split

5 ports = 5 axes of variation we want to swap independently:
- `CodergenBackend` — different agent runtimes (pi, Claude CLI, Codex CLI)
- `ExecutionEnvironment` — where tools run (local, worktree, Docker, remote)
- `EventSink` — where events persist (JSONL, Postgres, OTel, SSE)
- `Interviewer` — who answers human questions (auto, console, web, queue, recording wrapper)
- `WorkspaceProvider` — where configs come from (FS, git repo, DB)

Any more ports adds ceremony. Any fewer collapses concerns that legitimately vary.

### Why a swarm-owned MessageStore

pi-agent-core's `sessionId` is a provider-cache hint; it does not restore conversation history. If we relied on it, `fidelity=full` would silently behave like `truncate` — the provider would get cache hits but the agent would see no prior turns. So `@swarm/agent` owns a keyed-by-`thread_id` `MessageStore` that performs actual transcript hydration, and `sessionId` is bucketed per fidelity (`thread_id`, `thread_id:truncate`, `thread_id:compact`, …) to keep caches from cross-contaminating between modes.

The split matters because the two concerns travel on different timescales: cache bucketing is per-call, transcript restoration is per-thread-id across nodes. Collapsing them would break one or the other.

→ see AGENTS.md §"Fidelity modes (what each one actually does)".

### Why fidelity is declarative, not runtime-inferred

The resolution chain (edge attr → target node attr → graph default → hard default `compact`) lets a workflow author reason statically about what an agent will see at each node. A runtime heuristic would be cheaper to implement but would make replay non-deterministic and debugging much harder — the same graph could produce different prompts depending on state the author can't see.

`context = "fresh"` is the escape hatch when an author needs a node to stand entirely alone, regardless of `thread_id` or fidelity.

→ see SPEC.md §3.3 and AGENTS.md §"Fidelity modes".

### Why the summariser is a separate port with its own model

Using the coder model (Opus / GPT-5) to summarise its own prior transcript is ~10× more expensive than using a cheap model (Haiku / mini) for the same job, and the quality difference doesn't matter for compression. A separate `SummariserBackend` port keeps the coder model choice orthogonal to the compression choice, and lets the default be a cheap model without imposing that on teams that want a single-model setup.

Summariser calls ride on synthetic node IDs (`__summary.title`, `__summary.<caller>`) so cost accounting and drilldown bucket cleanly — a node's per-node budget is never charged for compression it didn't ask for. Streaming is via `summary.text_delta` for the same reason the rest of the system streams: the UI shouldn't block waiting for a full summary.

→ see SPEC.md §3.3 (summariser config) and AGENTS.md §"Summariser + auto-title".

### Why budgets are a pure reducer over `cost.recorded`

Everything else in swarm is reconstructable from the event log; budgets should be too. `BudgetLedger` is a pure function from `cost.recorded` events to verdicts — no hidden state, no race conditions on the hot path, trivially replayable. The executor wraps its event sink so every cost delta feeds the ledger automatically; handlers don't need to know budgets exist.

Verdicts are themselves events (`budget.warn`, `budget.stop` under synthetic node `__budget`) so UIs and cost reports render them first-class without bespoke aggregation. Pre-flight budget checks run at `backend.run()` boundaries so a breach fails fast and non-retryably — bypassing goal-gate retry, which would otherwise relaunch the breach.

→ see SPEC.md §3.3b and AGENTS.md §"Budgets (Wave 4)".

### Why the control channel is a file, not an IPC socket

The same reasons checkpoints are files: restart-safety and zero-dependency debuggability. A running `swarm run` can be steered, paused, resumed, or canceled by any other process that can write a line to `.swarm/runs/<run-id>/control.jsonl` — including a human with `echo` and a text editor. No daemon, no port, no auth. The executor tails via `fs.watch`, mirrors each request into `events.jsonl` as `control.requested`, and dispatches at safe boundaries.

A uuid on every request plus `last_applied_control_id` on the checkpoint guarantees no double-application across `--resume`. All four verbs share one channel so transport logic doesn't special-case by command — the differences live in the dispatch step, not the pipe.

→ see AGENTS.md §"Run control (steer / pause / resume / cancel)".

### Why skills use three-tier progressive disclosure

The agentskills.io tier model (catalog in system prompt → body via `load_skill` tool → resources via `read_file`) lets a project carry dozens of skills without paying their full token cost on every call. Tier 1 is ~100 tokens per skill regardless of body size; the agent only pays for the ones it actually invokes.

sha256 on every SKILL.md captured into `llm.start.skills[]` gives replay drift detection for free: if a skill's body changed between the run and a later replay, the hashes differ and the replay harness knows to flag it. We didn't design this — agentskills.io did — we just make sure the per-step durability is there.

→ see AGENTS.md §"Skills (agentskills.io)" and `docs/skills.md`.

### Why `local:subagent` is a tool, not a handler

Subagents exist for focused triage — "find which files import `FooBar`" shouldn't pollute the main agent's context with its own scratchwork. The fresh-context invariant (child can't see parent turns) is easier to enforce at the tool boundary than the handler boundary: the child gets its own pi-agent-core session with no shared `thread_id`, and the parent workflow stays a linear readable graph instead of fanning out per invocation.

Skill-body propagation is gated on explicit `preload_skills` for the same reason — the child re-runs discovery so its tier-1 catalog matches the parent's, but activated SKILL.md bodies don't leak unless the caller asks for them.

→ see AGENTS.md §"Subagent tool".

### Why the model stylesheet is CSS-like

Most workflows express intent as "every box node uses Haiku; the `.heavy` class uses Opus with high reasoning; the `#explore` node uses Sonnet." Repeating `[model=…, provider=…, reasoning_effort=…]` on every node is noise and drifts between nodes that were meant to match.

A single `model_stylesheet` string with `#id`, `.class`, `[shape=X]`, and `[attr=value]` selectors expresses the intent once. Node-level attrs still win over the stylesheet, so the escape hatch is obvious. CSS was the closest match to the selector vocabulary we wanted; we took the syntax and left the cascade rules out.

→ see AGENTS.md §"Model stylesheet".

### Why the condition language is intentionally minimal

`=`, `!=`, `&&` and nothing else. DSL creep is the enemy: once the condition language gets operators like `contains`, `matches`, or numeric comparisons, workflow authors start writing logic inside edge labels instead of in handlers where it's testable and debuggable. Keeping conditions boolean-equals means complex decisions push up to a `diamond` / `conditional` node that runs a real handler with access to the full context and outcome.

This is a deliberate inconvenience — it channels complexity into places that are easier to reason about.

→ see SPEC.md §3.8.

### Trust-boundary posture

swarm is a **high-trust harness**. The default permission mode is `unsafe`; the command blocklist refuses the worst patterns (`rm -rf /`, `sudo *`, `curl | sh`, writes outside worktree) and the env-leak gate blocks `.env` files with obvious key patterns. Together these are a *safety floor* — they stop common mistakes — but they are emphatically not a sandbox. A determined agent running under `unsafe` can still do damage inside its worktree.

For production use on untrusted input (tracker-driven workflows, repos you don't own, user-supplied prompts), pair swarm with an isolation layer outside the harness: a dedicated OS user, a container, a VM, or a remote worker. The `ExecutionEnvironment` port already lists `DockerEnvironment` and `RemoteEnvironment` as planned adapters (SPEC.md §2.2); they are the intended path for stricter postures without retrofitting swarm itself into a sandbox it wasn't designed to be.

### Influences

- **Attractor** (`attractor/`) — the three NLSpecs that define orchestrator, coding-agent-loop, and unified-LLM contracts. swarm implements the orchestrator spec; `@swarm/agent` shadows the coding-agent-loop on top of pi-mono.
- **Archon** (`Archon/`) — production YAML-based harness. Source of `$nodeId.output` substitution, loop nodes, env-leak gate, Hono+SSE surface, immutable sessions with parent chain.
- **pi-mono** (`pi-mono/`) — the agent + LLM runtime we adopted rather than rebuilt (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`). See §"Why pi-mono instead of building our own LLM / agent layer".
- **Symphony** — Codex-flavored daemon orchestrator with Linear-tracker polling, per-issue workspaces, and SSH-worker appendix. Not implemented in swarm, but useful as a design contrast when thinking about long-running service mode. swarm's own daemon plan lives in `~/.claude/plans/daemon.md`; the trust-boundary framing above was sharpened by Symphony §15.

## Open questions tracked for later

- **Pipeline composition** — If cross-workflow state-passing becomes necessary, adopt LangGraph's Command-style pattern (explicit inputs / outputs) rather than Temporal's signal-only model. Defer until needed.
- **Auto-compaction threshold** — Claude Code uses `window - 13K tokens`; we likely follow but treat as a config knob.
