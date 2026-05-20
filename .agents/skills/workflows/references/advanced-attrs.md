# Advanced attributes

Beyond the common keys in SKILL.md §7. These don't ship in a day-one workflow but are worth reaching for once the shape is second nature. All authoring keys are **kebab-case** (the parser lowers them to the engine's snake_case); a typo trips W013.

---

## System-prompt extension

| Key | Type | What |
|---|---|---|
| `context-files` | string[] | Repo-relative paths whose contents prepend to the system prompt as `<project-conventions>` blocks. `AGENTS.md` is auto-prepended, so you rarely need to list it. |
| `system-prompt` | string | Replace the global system prompt for this step entirely. Rare — usually you want `context-files`, not a full override. |
| `skills-disabled` | bool | Drop the skills catalogue from this step's system prompt. |

```yaml
implement:
  prompt: |
    Implement the plan.
  context-files: [docs/handler-contract.md]
```

Keep `context-files` lean — the system prompt has a byte cap; one file with hard constraints beats three with background. (`AGENTS.md` is already in; don't re-list it.)

---

## Graph-level cascades

The `defaults:` block (SKILL.md §2/§9) sets step attrs once for the whole workflow. There are no selectors and no node "classes"; `defaults:` applies to every `llm` step that omits the key, and a step overrides by setting the key itself.

```yaml
defaults:
  provider: anthropic
  model: claude-sonnet-4-6
  thread: dev          # every llm step joins `dev` unless it sets its own thread
```

Other graph-level knobs: `budget` / `budget-policy`.

> **No retry-policy presets.** Backoff-preset machinery (`retry_policy`) was retired — the executor no longer reads it. Handler-level retry is just `max-retries` (a flat cap, no backoff). The two control-flow loop idioms are in SKILL.md §5: edge-cycle (`on: {fail: <upstream>}` + `max-retries`) and goal-gate (`retry:`).

> **No subgraph composition.** Reusable named sub-pipelines are a deferred proposal (`docs/proposals/subgraphs.md`, gated on cross-workflow demand). Today, keep one flat workflow per deliverable (SKILL.md §1).
