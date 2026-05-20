# Advanced attributes

Beyond the common kebab-case keys in SKILL.md §7. These don't ship in a day-one workflow but are worth reaching for once the shape is second nature.

> **Note on casing.** The common keys (`model`, `provider`, `thread`, `allowed-tools`, `max-cost`, …) are kebab-case and lowered to the engine's snake_case by the parser. The advanced keys below are **authored snake_case** — they aren't in the rename table, but the validator knows them and the agent backend reads them. W013 still flags genuine typos.

---

## System-prompt extension

| Key | Type | What |
|---|---|---|
| `context_files` | string[] | Repo-relative paths whose contents prepend to the system prompt as `<project-conventions>` blocks. `AGENTS.md` is auto-prepended, so you rarely need to list it. |
| `system_prompt` | string | Replace the global system prompt for this step entirely. Rare — usually you want `context_files`, not a full override. |
| `skills_disabled` | bool | Drop the skills catalogue from this step's system prompt. |

```yaml
implement:
  prompt: |
    Implement the plan.
  context_files: [docs/handler-contract.md]   # snake_case, array
```

Keep `context_files` lean — the system prompt has a byte cap; one file with hard constraints beats three with background. (`AGENTS.md` is already in; don't re-list it.)

---

## Retry policy presets

`retry_policy` (step) and `default_retry_policy` (graph, snake_case) pick a backoff preset for **handler-level** retries — how the executor re-runs a single step when its outcome is RETRY or it throws a retryable error. Combine with `max-retries`.

| Preset | maxAttempts | initial | factor | maxDelay | Use for |
|---|---|---|---|---|---|
| `none` (default) | 1 | 0 | 1.0 | 0 | Fail immediately. |
| `standard` | 5 | 200ms | 2.0 | 60s | General-purpose flake. |
| `aggressive` | 5 | 500ms | 2.0 | 60s | Unreliable upstreams. |
| `linear` | 3 | 500ms | 1.0 | 500ms | Fixed-delay polling. |
| `patient` | 3 | 2000ms | 3.0 | 60s | Long-running ops. |

```yaml
fetch:
  prompt: |
    Fetch the upstream feed.
  retry_policy: aggressive
  max-retries: 5
```

- **`non_retryable`** (Outcome flag a handler sets) short-circuits retries — auth/4xx/validation failures don't retry.
- Backoff happens *outside* the executor slot: a retrying run goes `paused_auto{reason:"handler_retry"}`, frees its slot, and the wake-pending sweeper re-queues it after the timer. Heavy backoff doesn't starve other runs.
- A preset typo silently falls back to `none` — there's no longer a validator warning for it (the old W008 was retired), so spell the preset right.

This is **handler-level** retry of one step, distinct from the two control-flow loop idioms in SKILL.md §5 (edge-cycle `max-retries` back-edges; goal-gate `retry:` retargets).

---

## Graph-level cascades

The `defaults:` block (SKILL.md §2/§9) is the YAML way to set step attrs once for the whole workflow — it replaces the old DOT `model_stylesheet`. There are no CSS-style selectors and no node "classes"; `defaults:` applies to every `llm` step that omits the key, and a step overrides by setting the key itself.

```yaml
defaults:
  provider: anthropic
  model: claude-sonnet-4-6
  thread: dev          # every llm step joins `dev` unless it sets its own thread
```

Other graph-level knobs: `budget` / `budget-policy`, `max-goal-gate-retries`, `retry_target` / `fallback_retry_target` (snake_case; the graph-level legs of the goal-gate retarget chain, SPEC §3.4), `default_retry_policy`.

> Subgraph composition (reusable named sub-pipelines) is **not** a feature — it's a deferred proposal (`docs/proposals/subgraphs.md`, gated on cross-workflow demand). Today, share logic by keeping one flat workflow per deliverable (SKILL.md §1).
