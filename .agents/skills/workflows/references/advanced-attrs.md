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

Other graph-level knobs: `budget` / `budget-policy` / `default-retry-policy`.

---

## Retry backoff presets

By default a node that returns `retry` re-enters immediately (no delay). Set `retry-policy:` to engage a named backoff preset:

| Preset | Max attempts | Initial delay | Factor | Jitter |
|---|---|---|---|---|
| `none` (default) | 1 | — | — | no |
| `standard` | 5 | 200ms | 2.0 | yes |
| `aggressive` | 5 | 500ms | 2.0 | yes |
| `linear` | 3 | 500ms | 1.0 | no |
| `patient` | 3 | 2000ms | 3.0 | yes |

```yaml
flaky:
  type: llm
  prompt: Try this operation.
  max-retries: 4
  retry-policy: standard
  next: exit
```

Set `default-retry-policy:` at the graph level as a fallback for every step that omits `retry-policy:`.

Per-step field overrides (replace the named preset's value for that field):

| Key | Type | Overrides |
|---|---|---|
| `retry-initial-delay-ms` | integer | `initialDelayMs` |
| `retry-backoff-factor` | number | `backoffFactor` |
| `retry-max-delay-ms` | integer | `maxDelayMs` |
| `retry-jitter` | bool | `jitter` |

An unrecognised preset name is warned by W014 and falls back to `none` at runtime.

> **No subgraph composition.** Reusable named sub-pipelines are deferred (gated on cross-workflow demand). Today, keep one flat workflow per deliverable (SKILL.md §1).
