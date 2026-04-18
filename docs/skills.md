# Skills — authoring guide

swarm implements the [agentskills.io spec](https://agentskills.io/specification)
with its [progressive-disclosure client pattern](https://agentskills.io/client-implementation/adding-skills-support).
A skill is a directory containing a `SKILL.md` (+ optional scripts,
references, assets). swarm discovers skills on startup, advertises them
in the agent's system prompt, and exposes a `local:load_skill` tool so
the agent can pull the full instructions on demand.

## On-disk layout

```
<skills-root>/
  <skill-name>/
    SKILL.md              # required
    scripts/              # optional — loaded on-demand by local:read_file
    references/
```

Minimal `SKILL.md`:

```markdown
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files.
---

# PDF processing

When the user asks about PDFs, follow these steps…
```

Frontmatter fields:

| Field           | Required | Notes                                                                |
|-----------------|----------|----------------------------------------------------------------------|
| `name`          | yes      | Should match the parent directory name (warning, not enforced).       |
| `description`   | yes      | One line, used in the tier-1 catalog. Skills without it are skipped. |
| `version`       | no       | Displayed in the UI detail view.                                     |
| `allowed_tools` | no       | Advisory — surfaced in the UI detail pane. Does not gate tool calls. |

Unquoted-colon values in `description` (a common cross-client quirk) are
repaired automatically per the agentskills.io leniency rules.

## Discovery

By default, swarm auto-discovers skills from these well-known paths,
project before user (project wins on name collisions):

```
<cwd>/.swarm/skills/          <cwd>/.agents/skills/        <cwd>/.claude/skills/
~/.swarm/skills/              ~/.agents/skills/            ~/.claude/skills/
```

Pin an explicit list in `.swarm/config.yaml` to disable auto-discovery:

```yaml
skills:
  paths:
    - .swarm/skills
    - vendor/agent-skills
  disabled:
    - legacy-thing        # still discovered, hidden from the catalog
  trust_project: true     # default; false to hide project-scope skills
```

## Progressive disclosure

| Tier | What's injected                              | When                                     |
|------|-----------------------------------------------|------------------------------------------|
| 1    | `name` + `description` (+ `location`)         | Every LLM call that has visible skills   |
| 2    | Full SKILL.md body                            | Agent calls `local:load_skill({name})`  |
| 3    | `scripts/*`, `references/*`                   | Agent reads them with `local:read_file`  |

The tier-1 catalog block prepends the agent's system prompt in this order:
`<available_skills>` → `<project-conventions>` (context_files) → base
persona prompt. The behavioural instruction tells the model to call
`local:load_skill(name)` when a task matches a skill's description.

Tier 2 returns the SKILL.md body wrapped in
`<skill_content name="…">` tags and lists bundled resources so the model
can see what's there without eagerly reading anything.

## Node-level scoping

Two `NodeAttrs` narrow the catalog for a single DOT node:

```dot
narrow [skills="pdf-processing,csv-parsing"]   // intersection
noSkills [skills_disabled=true]                // hide all
```

Resolution: node attr → graph attr → config default → all discovered.

## Event durability

Every `llm.start` event carries the tier-1 catalog on `data.skills[]`:

```jsonc
{
  "type": "llm.start",
  "data": {
    "skills": [
      { "name": "pdf-processing", "location": "…/SKILL.md",
        "sha256": "…", "bytes": 1234, "scope": "user",
        "source_dir": "/Users/me/.agents/skills" }
    ]
  }
}
```

Replay harnesses compare the sha256 against the on-disk SKILL.md to
detect drift. Actual activations (tier-2) show up as
`local:load_skill` `tool.execution_start` events and are folded into the
"Used in recent runs" list on `GET /skills/:name`.

## Subagent propagation

`local:subagent` re-runs discovery in the child, so the tier-1 catalog is
identical to the parent's. Activated bodies do NOT propagate by default:
the child reloads what it needs. To skip the round-trip, pass
`preload_skills: ["pdf-processing"]` — the child's system prompt gets the
wrapped SKILL.md body as if it had called `local:load_skill` itself, and
a synthetic entry on the usage projection keeps the recent-runs count
accurate.

## Server + web

- `GET /skills` — catalog metadata. Disabled skills appear with
  `disabled_reason`. `?refresh=1` bypasses the 60-second TTL cache.
- `GET /skills/:name` — full body + metadata, plus a `usage` block
  listing runs that actually loaded the skill (not just saw it).
- Web UI `/skills` — list view; `/skills/:name` — detail view with
  markdown body, allowed tools, and recent activations.
- `StepInspector` on `/pipelines/:id` renders a "Skills catalog" section
  per step mirroring `llm.start.skills[]`.

## Debugging

- `bun run packages/cli/bin/swarm.ts run …` prints discovery warnings
  (collisions, malformed frontmatter) to stderr under `skills:`.
- `curl http://localhost:3000/skills?refresh=1` forces re-scan.
- If a skill is discovered but doesn't show up in the catalog, check
  `disabled_reason` on the `/skills` response — the most common cause is
  `skills.trust_project: false` in config.
