# Proposals — index

Active proposals at the top; shipped proposals collapsed at the bottom
as the design record. Each proposal carries YAML front-matter per
[AGENTS.md](../../AGENTS.md) ground rule #1:

- **status** — decision state: `proposed | accepted | in-progress | shipped | deferred | discarded`
- **maturity** — design state: `sketch | designed | specified`

A proposal flips to `shipped` only when [`STATUS.md`](../../STATUS.md)'s
"What swarm delivers today" section can claim its capability without
qualification (drift-lint enforces this). Partially-landed work stays
`in-progress` with the outstanding delta called out in the proposal body.

---

## In progress

| Proposal | Maturity | Outstanding |
|---|---|---|
| [Budget controls](./budget-controls.md) | specified | per-project cost cap cascading from project config |
| [Per-project DB retention](./db-retention.md) | specified | `swarm db prune --project` retention CLI |
| [Periodic introspection workflow](./introspection-workflow.md) | specified | archival path for the synthesised review (route through `ctx.artifacts.put(...)` keyed by date) is the only outstanding piece — workflow + primitives shipped |
| [Extensions — custom tools](./extensions-tools.md) | designed | v0 landed: `@swarm/extension` package, workspace loader (discover + adapter), daemon wiring, `web_fetch` reference extension, 16 unit tests. Outstanding: hot reload, daemon_events, trust config, CLI subcommands, web-bundler renderer integration, Tool component reshape — see proposal |

## Accepted (design done; awaiting scheduling)

| Proposal | Maturity | Notes |
|---|---|---|
| [Daemon UI — stats + feed](./daemon-ui.md) | specified | |
| [Cap-overflow strategy](./cap-overflow.md) | designed | Promoted from sketch by introspect run 01kqsj2z28wv7sxdfh finding C5 (1.41% of runs ≥ 80% of routing cap, peak 6,629 B). Owns the spill / compaction / typed-halt path for `run_state.routing` (8 KB) and `messages.content` (1 MiB); observability lives in `payload-pressure-signal.md` |

## Proposed (under design)

| Proposal | Maturity | Notes |
|---|---|---|
| [Parallel branches as first-class executor citizens (sub-runs)](./parallel.md) | specified | branches today are single-node, opaque to the executor's dispatch loop, and inherit none of its per-turn services (watchdog, budgets, retries, intent fold, HITL, goal gates, edge selection). Concrete production symptom: `review.dot`'s `lens_correctness` spent $1.72 vs $0.30 cap (5.7× over). Approach: each branch becomes a child `run_state` row with `parent_run_id` linkage; reuses 100% of existing executor machinery. P0 extracts `dispatchOne`/`foldIntents`/`claimAndAdvance` from the executor's monolithic loop; P2 cuts `parallel.ts` over to sub-runs; P3 unlocks multi-node branch subgraphs + HITL inside branches. No feature flag; direct cutover with parity tests gating P2 |
| [Extensions — custom tools and hooks (unified)](./project-extensions.md) | designed | folds tools and hooks back into one factory file riding the loader from `./extensions-tools.md`; four hook events — `tool.before_call` / `tool.after_call` / `agent.before_start` (feedback: `block` / mutate `input` / replace `content` / replace `systemPrompt`) and `agent.turn_end` (read-only `AssistantMessage`); ships after tools |
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
| [Custom-provider config in the store](./provider-config-storage.md) | specified | follow-up to the credentials proposal; moves `~/.swarm/models.json` into a `provider_config` table (per-provider JSON blob, Ajv-validated on read); deletes `resolve-config-value.ts` and the last `!cmd`/`env` machinery |
| [Codergen nodes — unbounded wall-clock time](./codergen-unbounded-time.md) | sketch | make `HandlerSpec.maxMs` optional for codergen handlers; per-codergen runs are bounded by tokens and USD spend, not wall-clock; cuts the "999h" ceiling pattern from configs |
| [Multi-account support per provider](./multi-account.md) | sketch | first-class `(provider, account)` credentials with reserved `"default"` account; selection via run intent / schedule / project config / global config; workflows stay account-agnostic. Drivers: billing/org separation, per-run credentials. Composes with deferred [`credentials.md`](./credentials.md) — lower-cost ordering is multi-account first against `auth.json`, credentials-in-DB second with the two-level shape baked in |

## Deferred

| Proposal | Maturity | Rationale |
|---|---|---|
| [Rate-limit fairness](./rate-limit-fairness.md) | sketch | budget cap covers single-project case |
| [Git-object file server](./file-server.md) | sketch | path-walking reads are fine pre-multi-project |
| [Token auth for the harness API](./token-auth.md) | sketch | localhost-no-auth is the v0 default; revisit for shared/remote/browser-hostile cases |
| [Project config extensions](./project-config-extensions.md) | sketch | projects are emergent paths; per-project knobs return when path-keyed config hits a real constraint |
| [Credentials in DB](./credentials.md) | designed | `~/.swarm/auth.json` (already global) is enough for single-user; revisit when extension code can read other projects' state |
| [Honest token count on system-prompt rows](./system-prompt-token-count.md) | sketch | char count is fine for a label; full per-model accuracy needs server routing + provenance lookup, more infra than the UX warrants today |

## Shipped

<details>
<summary>Design records for delivered capability — capability claims live in the root README. Click to expand.</summary>

- [Project config file](./project-config.md)
- [Doc-vs-code drift CI lint](./drift-lint.md)
- [Bound the OCC retry loop](./occ-retry-ceiling.md)
- [Auto-retry for transient LLM provider errors](./provider-auto-retry.md)
- [Harness](./harness.md)
- [Schema additions for project-aware runs](./schema-additions.md)
- [Workflow resolution by name](./workflow-resolution.md)
- [Parallel branch outputs — substitution + UI awareness](./parallel-branch-outputs.md)
- [Recoverable pause unification](./recoverable-budget-pause.md)
- [Watchdog timeout → pause-retry, not abort](./watchdog-timeout-pause-retry.md)
- [Run isolation via worktrees](./run-isolation.md)
- [Agent tool — LLM-spawned sub-agents](./agent-tool.md)
- [Scheduled runs](./scheduled-runs.md)
- [Skill tool](./skill-tool.md)
- [Skills + agents UI + unified discovery](./skills-and-agents-ui.md)
- [Agent definitions — named, reusable sub-agent profiles](./agent-definitions.md)
- [Agent base prompt — sub-agents inherit the parent's framing](./agent-base-prompt.md)
- [Sub-agent crash resilience — resume up to last completed turn](./sub-agent-crash-resilience.md)
- [Codergen maxMs is a runaway backstop, not a typical bound](./codergen-maxms-backstop.md)
- [Provider credentials in the store](./provider-credentials-storage.md)

</details>
