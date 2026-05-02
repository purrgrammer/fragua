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

## In progress

| Proposal | Maturity | Outstanding |
|---|---|---|
| [Schema additions for project-aware runs](./schema-additions.md) | specified | `workflow_name` / `_scope` / `_path`, `project_context_sha`, `parent_run_id`, `events.project_id` |
| [Run isolation via worktrees](./run-isolation.md) | sketch | branch GC, paused-run base-drift, per-branch parallel isolation, editor co-occupancy — see [worktree-design](./worktree-design.md) |
| [Budget controls](./budget-controls.md) | specified | per-project cost cap cascading from project config |
| [Per-project DB retention](./db-retention.md) | specified | `swarm db prune --project` retention CLI |
| [Periodic introspection workflow](./introspection-workflow.md) | specified | workflow `.dot` ships and runs end-to-end; `find`/`grep`/`ls` primitive tools landed; archival path for the synthesised review pending |

## Accepted (design done; awaiting scheduling)

| Proposal | Maturity |
|---|---|
| [Workflow resolution by name](./workflow-resolution.md) | specified |
| [Daemon UI — stats + feed](./daemon-ui.md) | specified |

## Proposed (under design)

| Proposal | Maturity | Notes |
|---|---|---|
| [Harness](./harness.md) | designed | architectural commitment point; everything below depends on it |
| [Credentials in DB](./credentials.md) | designed | threat model resolves before project-extensions ship |
| [Migration tool](./migration.md) | designed | blocked on harness + global DB |
| [Project tools, hooks, skills](./project-extensions.md) | sketch | trust-boundary risk — biggest open question |
| [Worktree design](./worktree-design.md) | sketch | current state unsatisfying; this doc enumerates why |
| [Sane + configurable handler timeouts](./timeouts.md) | specified | concrete plan; not yet scheduled |
| [Analytics — follow-up roadmap](./analytics.md) | sketch | menu of charts cut from v1 |
| [Cap-overflow strategy](./cap-overflow.md) | sketch | 4 KB / 8 KB / 1 MiB / 16 MiB caps need typed observability + spill paths; routing overflow is the loudest production hazard |
| [Handler discipline rails for extension code](./handler-discipline-extensions.md) | sketch | extend the in-tree lint to user-supplied handlers / tools and the agent backend |
| [Throughput baseline + benchmark suite](./throughput-baseline.md) | specified | close ARCH §14 risk #3; nominal capacity claims have no measurement behind them |
| [Auto-retry for transient LLM provider errors](./provider-auto-retry.md) | designed | backoff for 429 / 5xx / network reset, manual escape preserved. Brainstorm 2026-05-02 surfaced 9 open corners — see proposal §Open questions before implementation |
| [Operator-surface contract tests](./operator-surface-tests.md) | specified | catch C6-class drift between skill-taught curl bodies and server validators; pairs with drift-lint |
| [Recoverable budget pause](./recoverable-budget-pause.md) | designed | new `budget_policy="pause"` (default) + `paused_budget` status; budget overruns suspend for operator decision instead of halting. Empirical motivation: the introspect workflow ate two budget halts this session, each abandoning $0.50 of upstream work |
| [LLM-emit HITL via `<ask>` marker](./llm-emit-hitl.md) | sketch | extend `paused_hitl` so a codergen step can ask the operator a clarification question end-of-turn; answer flows back as a user message on resume. Reuses today's HITL plumbing; adds one parser branch + one resume convention |

## Deferred

| Proposal | Maturity | Rationale |
|---|---|---|
| [Rate-limit fairness](./rate-limit-fairness.md) | sketch | budget cap covers single-project case |
| [Git-object file server](./file-server.md) | sketch | path-walking reads are fine pre-multi-project |

## Discarded

_(none yet.)_
