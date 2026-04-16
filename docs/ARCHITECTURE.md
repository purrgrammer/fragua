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

## Open questions tracked for later

- **Pipeline composition** — If cross-workflow state-passing becomes necessary, adopt LangGraph's Command-style pattern (explicit inputs / outputs) rather than Temporal's signal-only model. Defer until needed.
- **Summarizer model config** — Default will be `summarizer.model: claude-haiku-4-5` independent of node model, to save ~90 % on compaction costs.
- **Auto-compaction threshold** — Claude Code uses `window - 13K tokens`; we likely follow but treat as a config knob.
