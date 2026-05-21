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
| [YAML as canonical config format](./config-yaml-migration.md) | specified | JSONC reader removal is the outstanding piece — the loader and `swarm init` changes are shipped |
| [Budget controls](./budget-controls.md) | specified | per-project cost cap cascading from project config |
| [Per-project DB retention](./db-retention.md) | specified | `swarm db prune --project` retention CLI |
| [Periodic introspection workflow](./introspection-workflow.md) | specified | archival path for the synthesised review (route through `ctx.artifacts.put(...)` keyed by date) is the only outstanding piece — workflow + primitives shipped |

## Accepted (design done; awaiting scheduling)

| Proposal | Maturity | Notes |
|---|---|---|
| [Daemon UI — stats + feed](./daemon-ui.md) | specified | |
| [Cap-overflow strategy](./cap-overflow.md) | designed | Promoted from sketch by introspect run 01kqsj2z28wv7sxdfh finding C5 (1.41% of runs ≥ 80% of routing cap, peak 6,629 B). Owns the spill / compaction / typed-halt path for `run_state.routing` (8 KB) and `messages.content` (1 MiB); observability lives in `payload-pressure-signal.md` |

## Proposed (under design)

| Proposal | Maturity | Notes |
|---|---|---|
| [Worktrees](./worktrees.md) | designed | per-run worktree isolation + tree snapshots at HITL/terminal boundaries + operator-triggered post-run primitives (branch / commit / merge / discard) on two non-porcelain ref namespaces (`refs/swarm/snapshots/<runId>/<eventIdx>` + `refs/swarm/heads/<runId>`); terminal runs with non-empty diff vs base land in an operator **inbox**; clean runs disappear quietly. Replaces [worktree-design.md](./worktree-design.md) and [worktree-snapshots.md](./worktree-snapshots.md) |
| [Worktree design](./worktree-design.md) | sketch | superseded by [worktrees.md](./worktrees.md); kept for context until that lands |
| [Worktree snapshots at node boundaries](./worktree-snapshots.md) | designed | superseded by [worktrees.md](./worktrees.md); kept for context until that lands |
| [Sane + configurable handler timeouts](./timeouts.md) | specified | concrete plan; not yet scheduled |
| [Analytics — follow-up roadmap](./analytics.md) | sketch | menu of charts cut from v1 |
| [Per-workflow analytics](./per-workflow-analytics.md) | sketch | workflow filter on `/analytics`; identity = `(scope, name)` not sha; metric decomposition (input/output/cache-read/cache-write) |
| [Run-detail analytics tab](./run-detail-analytics-tab.md) | sketch | per-node summary tab on `/runs/:id`; aggregates `GET /runs/:id/steps` by `nodeId`; existing `Cost` tab stays as the per-LLM-step drill-in |
| [Throughput baseline + benchmark suite](./throughput-baseline.md) | specified | close ARCH §13 risk #3; nominal capacity claims have no measurement behind them |
| [Operator-surface contract tests](./operator-surface-tests.md) | specified | catch C6-class drift between skill-taught curl bodies and server validators; pairs with drift-lint |
| [LLM-emit HITL via `<ask>` marker](./llm-emit-hitl.md) | sketch | extend `paused_human` so a codergen step can ask the operator a clarification question end-of-turn; answer flows back as a user message on resume. Reuses today's human-node plumbing; adds one parser branch + one resume convention |
| [Structured step outputs](./structured-outputs.md) | sketch | typed per-step `outputs:` (mirroring `inputs:`) + `${{ steps.X.outputs.f }}` substitution, enforced by a forced `emit_output` tool (runtime) + dominance check (validator). Collapses the data-plumbing half of shared-thread usage (`review::scope` emit block, `pr_*` body/PR# scraping); threads stay for conversation / revision loops / dynamic fan-in. Unlocks fact-routing via `routes:` and a bare-tool PR-action path. Evolves AGENTS.md rule 13: cross-node substitution allowed iff producer dominates consumer |
| [LLM-directed routing + unified human-node authoring](./llm-routing.md) | designed | promote LLM-directed routing to a primitive (node declares `routes=`; ephemeral `route` tool synthesised per-node by the backend; edges discriminate by `outcome` or `route` only) AND collapse the 5-step edge-selection priority to a two-case algorithm — deleting `condition` DSL (`condition.ts` + AST module), edge `weight=`, `preferred_label` / `suggested_next_ids` matching, `accelerator.ts`, ~100 lines of `edge-selection.ts`, and the `partial_success` / `skipped` outcome statuses + `context_updates` / `next_node_override` fields. Same primitive replaces the legacy `wait.human` shape: `kind=human` (alias `shape=hexagon`) reuses `routes=`; per-edge `label="..."` covers custom button text. Wire vocabulary moves `hitl` → `human` top to bottom. Collapses `change.dot` + `feature.dot` into one triage workflow. Validator codes E017–E026 contiguous. Sits inside the broader simplification arc (DOT → YAML, fidelity → fresh/full, no graph transforms). |

| [Drift-lint extensions](./drift-lint-extensions.md) | specified | extend `bun run lint:docs` with three audits — HandlerContext block (ARCH §5 vs `handler/types.ts`), proposal-status-vs-code (catch shipped-but-still-`proposed`), JSDoc retry-status (`PauseReason` JSDoc vs `provider-retry-policy.ts`). Drift classes the existing gate doesn't catch; surfaced by the 2026-05-04 introspect run |
| [Payload-cap pressure signal](./payload-pressure-signal.md) | sketch | introspect found `events.payload` writes 5 B from the 4 KB cap; surface near-cap pressure as a daemon event + analytics tile + run-detail warning so operators see the wall before hitting it; `cap-overflow.md` owns the spill/halt path for both `events.payload` and `run_state.routing` |
| [Multi-account support per provider](./multi-account.md) | sketch | first-class `(provider, account)` credentials with reserved `"default"` account; selection via run intent / schedule / project config / global config; workflows stay account-agnostic. Drivers: billing/org separation, per-run credentials. Composes with deferred [`credentials.md`](./credentials.md) — lower-cost ordering is multi-account first against `auth.json`, credentials-in-DB second with the two-level shape baked in |
| [Run store sandbox](./run-store-sandbox.md) | sketch | a daemon-provisioned run's node bodies can still reach the operator's global `~/.swarm/swarm.db`; a run implementing a schema migration bumped its version and bricked the live harness. Sandbox run store access (temp DB / forbid the global store) so a run can't corrupt the coordination DB |
| [Workflow JSON-IR storage + content addressing](./workflow-ir-storage.md) | designed | `sha = hash(canonical IR)` so cosmetic source edits don't mint versions; store + hydrate the IR (drop the YAML at rest, regen it for display); IR cleanup pass (kill `directed`/`AttrScalar`/`timeout`-string/edge `thread_id`/`fallback_retry_target` cruft, decomplect `loc` to a parse-time source-map); hash a representation-version-independent normal form (`irVersion` excluded, upcast on read) so a version means the *workflow* changed, not the IR shape. Closes #26 + absorbs the `dot_source` rename |
| [Event payload versioning + upcast](./event-versioning.md) | designed | retire run schema-pinning + the `schema_drift` halt — if "events are truth" a historical event must replay forever. Per-type `payload_version` + read-time upcasters through one decode boundary; events stay immutable (no rewrite). Sibling to workflow-ir-storage (the run-replay half of "version tracking") |
| [Secret handling — env discovery + redaction](./secret-handling.md) | sketch | **half-baked, safety-critical.** Revive env credential discovery (in-memory, non-persisted → CI audit artifact secret-free by construction) + a store-boundary redaction scrubber (known-value + shape-regex) at `appendMessage`/`appendObservabilityEvents`/blob-preview + `swarm db backup --redacted` |

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

| Proposal | Maturity | Rationale |
|---|---|---|
| [Reserved `fail` sink](./fail-sink.md) | sketch | a route/edge to a `fail` terminal mirroring `exit`. Existing primitives cover every case — `abort(reason)` (llm), loop edges (redo), `exit` (graceful), `intent.cancel(note)` (operator discard-as-failure, which is the lone human-node residual). Kept the four-mechanism terminal model (now in workflows SKILL §1); dropped the primitive. Reopens only if a human rejection must read `halted` not `cancelled` |

## Shipped

<details>
<summary>Design records for delivered capability — capability claims live in the root README. Click to expand.</summary>

- [Graceful sub-agent resume across pause boundaries](./subagent-resume-on-pause.md) — content-addressed FIFO queue: cancelled sub-agent enters a queue keyed by `(parent_run, parent_node_id, iteration, args_hash)`; next spawn with matching args pops the oldest pending entry and resumes it. No LLM cooperation needed. Symmetric with regular-tool rehydrate.
- [Project config file](./project-config.md)
- [Doc-vs-code drift CI lint](./drift-lint.md)
- [Bound the OCC retry loop](./occ-retry-ceiling.md)
- [Auto-retry for transient LLM provider errors](./provider-auto-retry.md)
- [Harness](./harness.md)
- [Schema additions for project-aware runs](./schema-additions.md)
- [Workflow resolution by name](./workflow-resolution.md)
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
- [Codergen nodes — unbounded wall-clock time](./codergen-unbounded-time.md)
- [Provider credentials in the store](./provider-credentials-storage.md)
- [Custom-provider config in the store](./provider-config-storage.md)
- [Per-model CLI ops for custom providers](./provider-model-ops.md)
- [`paused{reason:"max_retries"}` — Stage 3 / max_retries slice](./paused-max-retries.md)

</details>

## Archived

<details>
<summary>Proposals targeting primitives that have since been retired — kept as historical record. Click to expand.</summary>

- [Parallel branches as first-class executor citizens (sub-runs)](./parallel.md) — the parallel/fan_in primitive was removed; concurrent dispatch now lives in the codergen `agent` tool
- [Parallel branch outputs — substitution + UI awareness](./parallel-branch-outputs.md) — substitution + UI surfaces targeted the parallel runtime, which no longer exists
- [Per-parent descendant event stream](./descendant-event-stream.md) — descendant tracking was a parallel-sub-run feature; obsolete now that parallel is retired

</details>
