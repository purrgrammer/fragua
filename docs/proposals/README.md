# Proposals — index

Per [AGENTS.md](../../AGENTS.md) ground rule #1, every proposal carries YAML
front-matter with two orthogonal tags:

- **status** — decision state: `proposed | accepted | in-progress | shipped | deferred | discarded`
- **maturity** — design state: `sketch | designed | specified`

A proposal flips to `shipped` only when the README "What swarm delivers
today" section can claim its capability without qualification. Until
then, partially-landed work is `in-progress` with the outstanding
delta called out in the proposal body.

---

## Shipped

| Proposal | Maturity | Notes |
|---|---|---|
| [Project config file](./project-config.md) | specified | `<project>/.swarm/config.jsonc` |
| [Doc-vs-code drift CI lint](./drift-lint.md) | specified | `bun run lint:docs` in CI |
| [Bound the OCC retry loop](./occ-retry-ceiling.md) | specified | ceiling=3 with exponential backoff; structured `occ_exhausted` halt |
| [Auto-retry for transient LLM provider errors](./provider-auto-retry.md) | specified | classify 408/429/5xx/529/network as auto; full-jitter exponential or honoured `Retry-After`; new `paused_provider_retry` status |
| [Harness](./harness.md) | specified | `swarm harness` foreground supervisor; default DB `~/.swarm/swarm.db`, default :6767, web bundle auto-build, OSC 8 hyperlink. Discovery via `daemon_lock.{http_url, http_port, harness_version}` |
| [Schema additions for project-aware runs](./schema-additions.md) | specified | `run_state.{cwd, workflow_name, workflow_scope, workflow_path}`, `daemon_lock.{http_url, http_port, harness_version}`; `project_id` + `projects` table removed; schema v4 |
| [Workflow resolution by name](./workflow-resolution.md) | specified | bare names resolve `~/.swarm/workflows/<name>.dot` first, then `<cwd>/.swarm/workflows/<name>.dot` |
| [One-off migration](./migration.md) | specified | `scripts/migrate-pre-harness.ts` ran on this repo on 2026-05-04 |
| [Parallel branch outputs — substitution + UI awareness](./parallel-branch-outputs.md) | specified | P0 (per-branch `fact.node_started`/`fact.node_completed` with `parentNodeId`/`parallelIndex`/`score`; `$<branchId>.output` resolves downstream of a fan-out) + P1 (web graph multi-active states with success accent for fan_in winner; step breakdown branch-row indent + parent summary aggregation) + P2 (conversation split tabs gated on concurrently-running branches; cost panel grouping rides on the same step shape) all complete |
| [Recoverable pause unification](./recoverable-budget-pause.md) | specified | unified non-terminal `paused` status + reason-discriminated `fact.run_paused` (`operator` \| `provider_error` \| `payment_required` \| `budget`); `intent.budget_adjusted` (`POST /runs/:id/budget`) raises caps via `routing.budget_override.<scope>.<metric>`; `paused_provider_error` retired |
| [Agent tool — LLM-spawned sub-agents](./agent-tool.md) | specified | one new LLM-callable tool (`agent`, `defaultDisabled: true`). Sub-agents are NOT runs — they're a tool implementation that runs inline as a fresh codergen call against the parent's event stream, all observability tagged with `subagent_id` on payload. Cost rolls into the parent's `metrics` through the existing accumulation path. Two new observability event types (`subagent.start` / `subagent.end`) bracket each spawn. Parallel-safe — N spawns from one parent message run concurrently, each demuxed by `subagent_id`. Schema v7 drops the v5 conversation-run scaffolding (sub-agents have no `run_state` row, no `kind` discriminator, no parent linkage columns) |
| [Scheduled runs](./scheduled-runs.md) | specified | `(workflow_ref, cwd, interval, optional input)` operator-side schedules at shorthand cadences (`30m`/`1h`/`6h`/`24h`); each fire enqueues a fresh run with `run_state.schedule_id` lineage; default `overlap=skip`; at-most-one catch-up after downtime via `fact.schedule_late`; auto-pause only on parser/validator failure (schema v6) |
| [Skill tool](./skill-tool.md) | stable | built-in `skill({ name, arguments? })` LLM-callable tool, force-included on every codergen call (workflow `allowed_tools` / `denied_tools` cannot exclude it); loads SKILL.md by catalogue name, parses frontmatter (only `name` + `description` honoured), substitutes `$ARGUMENTS` (appends `<invocation>` block when body has no placeholder); structured `{name, description, path, content}` payload rides on `tool.execution_end.data.result.details.data` and drives a dedicated viz card; sub-agent inheritance via the existing `materialiseForChild` filter on `spec.skills` |
| [Agent definitions — named, reusable sub-agent profiles](./agent-definitions.md) | specified | Named sub-agent profiles loaded from `.agents/agents/` + `~/.agents/agents/`, resolved at `agent` tool spawn site. Discovery mirrors skills (project beats user; `.claude/agents/` is a cross-client fallback). Each profile is a flat `.md` with YAML frontmatter (`name`, `description`, optional `model` / `provider` / `allowed_tools`) and a body that becomes the sub-agent's system prompt. Catalogue (`name` + `description` per profile) is appended to the parent's system prompt only when the node's tool pool includes `agent`; the LLM invokes one via `agent({ agent: "<name>", … })`, def's body wins when no inline `system_prompt`, def's `allowed_tools` are normalised to canonical lowercase snake_case, def's `model`/`provider` override the parent's choice on the synthesised child node, and `subagent.start.agent_def` carries the resolved profile name (the free-form `name` label and the resolved `agent_def` are independent fields on the wire — see ARCH §3). Inline form unchanged — named profiles are sugar over it |

## In progress

| Proposal | Maturity | Outstanding |
|---|---|---|
| [Run isolation via worktrees](./run-isolation.md) | sketch | branch GC, paused-run base-drift, per-branch parallel isolation, editor co-occupancy — see [worktree-design](./worktree-design.md) |
| [Budget controls](./budget-controls.md) | specified | per-project cost cap cascading from project config |
| [Per-project DB retention](./db-retention.md) | specified | `swarm db prune --project` retention CLI |
| [Periodic introspection workflow](./introspection-workflow.md) | specified | workflow `.dot` ships and runs end-to-end; `find`/`grep`/`ls` primitive tools landed; archival path for the synthesised review pending |
| [Extensions — custom tools](./extensions-tools.md) | designed | v0 landed: `@swarm/extension` package, workspace loader (discover + adapter), daemon wiring, `web_fetch` reference extension, 16 unit tests. Outstanding: hot reload, daemon_events, trust config, CLI subcommands, web-bundler renderer integration, Tool component reshape — see proposal |

## Accepted (design done; awaiting scheduling)

| Proposal | Maturity | Notes |
|---|---|---|
| [Daemon UI — stats + feed](./daemon-ui.md) | specified | |
| [Cap-overflow strategy](./cap-overflow.md) | designed | Promoted from sketch by introspect run 01kqsj2z28wv7sxdfh finding C5 (1.41% of runs ≥ 80% of routing cap, peak 6,629 B). Owns the spill / compaction / typed-halt path for `run_state.routing` (8 KB) and `messages.content` (1 MiB); observability lives in `payload-pressure-signal.md` |

## Proposed (under design)

| Proposal | Maturity | Notes |
|---|---|---|
| [Extensions — custom hooks](./project-extensions.md) | designed | rides the loader from `./extensions-tools.md`; four hook events — `tool.before_call` / `tool.after_call` / `agent.before_start` (feedback: `block` / mutate `input` / replace `content` / replace `systemPrompt`) and `agent.turn_end` (read-only `AssistantMessage`); ships after tools |
| [Worktree design](./worktree-design.md) | sketch | current state unsatisfying; this doc enumerates why |
| [Sane + configurable handler timeouts](./timeouts.md) | specified | concrete plan; not yet scheduled |
| [Analytics — follow-up roadmap](./analytics.md) | sketch | menu of charts cut from v1 |
| [Per-workflow analytics](./per-workflow-analytics.md) | sketch | workflow filter on `/analytics`; identity = `(scope, name)` not sha; metric decomposition (input/output/cache-read/cache-write) |
| [Run-detail analytics tab](./run-detail-analytics-tab.md) | sketch | per-node summary tab on `/runs/:id`; aggregates `GET /runs/:id/steps` by `nodeId`; existing `Cost` tab stays as the per-LLM-step drill-in |
| [Handler discipline rails for extension code](./handler-discipline-extensions.md) | sketch | extend the in-tree lint to user-supplied handlers / tools and the agent backend |
| [Throughput baseline + benchmark suite](./throughput-baseline.md) | specified | close ARCH §13 risk #3; nominal capacity claims have no measurement behind them |
| [Operator-surface contract tests](./operator-surface-tests.md) | specified | catch C6-class drift between skill-taught curl bodies and server validators; pairs with drift-lint |
| [LLM-emit HITL via `<ask>` marker](./llm-emit-hitl.md) | sketch | extend `paused_hitl` so a codergen step can ask the operator a clarification question end-of-turn; answer flows back as a user message on resume. Reuses today's HITL plumbing; adds one parser branch + one resume convention |
| [Drift-lint extensions](./drift-lint-extensions.md) | specified | extend `bun run lint:docs` with three audits — HandlerContext block (ARCH §5 vs `handler/types.ts`), proposal-status-vs-code (catch shipped-but-still-`proposed`), JSDoc retry-status (`PauseReason` JSDoc vs `provider-retry-policy.ts`). Drift classes the existing gate doesn't catch; surfaced by the 2026-05-04 introspect run |
| [Payload-cap pressure signal](./payload-pressure-signal.md) | sketch | introspect found `events.payload` writes 5 B from the 4 KB cap; surface near-cap pressure as a daemon event + analytics tile + run-detail warning so operators see the wall before hitting it; `cap-overflow.md` owns the spill/halt path for both `events.payload` and `run_state.routing` |
| [JSON IR as canonical workflow form](./json-ir-canonical.md) | designed | flip storage from DOT-text to canonical JSON IR; Typebox-first schema published from `@swarm/types`; DOT becomes authoring sugar that lowers at upload; schema v4 → v5 with try-migrate per row; `$ref`/include + DOT-superset features deferred to follow-ups |
| [Codergen maxMs tuning for verify](./codergen-maxms-tuning.md) | designed | feature-run halt at 31m29s on `fact.handler_timeout_leaked` traced to `DEFAULT_MAX_MS = 30 * 60 * 1000` in `handler-bridge.ts`. Layer-1 fix: explicit `max_ms = 5400000` on `verify` in `feature.dot` / `change.dot`. Layer-2: class-keyed defaults (`verify` → 90 min, `commit` → 30 min). Adjacent to but narrower than [`./timeouts.md`](./timeouts.md) — addresses one concrete bug surfaced by run `01kqtna3ewdet7h6bd` |

## Deferred

| Proposal | Maturity | Rationale |
|---|---|---|
| [Rate-limit fairness](./rate-limit-fairness.md) | sketch | budget cap covers single-project case |
| [Git-object file server](./file-server.md) | sketch | path-walking reads are fine pre-multi-project |
| [Token auth for the harness API](./token-auth.md) | sketch | localhost-no-auth is the v0 default; revisit for shared/remote/browser-hostile cases |
| [Project config extensions](./project-config-extensions.md) | sketch | projects are emergent paths; per-project knobs return when path-keyed config hits a real constraint |
| [Credentials in DB](./credentials.md) | designed | `~/.swarm/auth.json` (already global) is enough for single-user; revisit when extension code can read other projects' state |
| [Honest token count on system-prompt rows](./system-prompt-token-count.md) | sketch | char count is fine for a label; full per-model accuracy needs server routing + provenance lookup, more infra than the UX warrants today |

## Discarded

_(none yet.)_
