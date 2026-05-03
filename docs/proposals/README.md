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
| [One-off migration](./migration.md) | designed | one-shot script for this repo's pre-harness DB; new installs start global |
| [Project tools, hooks, skills](./project-extensions.md) | sketch | trust-boundary risk — biggest open question |
| [Worktree design](./worktree-design.md) | sketch | current state unsatisfying; this doc enumerates why |
| [Sane + configurable handler timeouts](./timeouts.md) | specified | concrete plan; not yet scheduled |
| [Analytics — follow-up roadmap](./analytics.md) | sketch | menu of charts cut from v1 |
| [Cap-overflow strategy](./cap-overflow.md) | sketch | 4 KB / 8 KB / 1 MiB / 16 MiB caps need typed observability + spill paths; routing overflow is the loudest production hazard |
| [Handler discipline rails for extension code](./handler-discipline-extensions.md) | sketch | extend the in-tree lint to user-supplied handlers / tools and the agent backend |
| [Throughput baseline + benchmark suite](./throughput-baseline.md) | specified | close ARCH §14 risk #3; nominal capacity claims have no measurement behind them |
| [Operator-surface contract tests](./operator-surface-tests.md) | specified | catch C6-class drift between skill-taught curl bodies and server validators; pairs with drift-lint |
| [Recoverable pause unification](./recoverable-budget-pause.md) | designed | collapse operator-resumable family to one `paused` status + one reason-discriminated `fact.run_paused` (`operator` \| `provider_error` \| `payment_required` \| `budget`). Default `budget_policy` flips `stop`→`pause`; budget overruns become recoverable. Absorbs `paused_provider_error`, routes 402 to `payment_required`, leaves `paused_hitl` / `paused_*_retry` / `quarantined` untouched |
| [LLM-emit HITL via `<ask>` marker](./llm-emit-hitl.md) | sketch | extend `paused_hitl` so a codergen step can ask the operator a clarification question end-of-turn; answer flows back as a user message on resume. Reuses today's HITL plumbing; adds one parser branch + one resume convention |

## Deferred

| Proposal | Maturity | Rationale |
|---|---|---|
| [Rate-limit fairness](./rate-limit-fairness.md) | sketch | budget cap covers single-project case |
| [Git-object file server](./file-server.md) | sketch | path-walking reads are fine pre-multi-project |
| [Token auth for the harness API](./token-auth.md) | sketch | localhost-no-auth is the v0 default; revisit for shared/remote/browser-hostile cases |
| [Project config extensions](./project-config-extensions.md) | sketch | projects are emergent paths; per-project knobs return when path-keyed config hits a real constraint |
| [Credentials in DB](./credentials.md) | designed | `~/.swarm/auth.json` (already global) is enough for single-user; revisit when extension code can read other projects' state |

## Discarded

_(none yet.)_
