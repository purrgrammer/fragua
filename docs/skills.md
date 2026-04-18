# Skills (agentskills.io)

swarm implements the [agentskills.io progressive-disclosure spec](https://agentskills.io/client-implementation/adding-skills-support). Drop a directory with a `SKILL.md` into any of these well-known paths and it's auto-discovered:

```
<cwd>/.agents/skills/<name>/SKILL.md    <cwd>/.claude/skills/<name>/SKILL.md
~/.agents/skills/<name>/SKILL.md       ~/.claude/skills/<name>/SKILL.md
```

## Three tiers of disclosure

1. **Catalog** — `name` + `description` per skill prepended to the system prompt inside `<available_skills>`. Tells the model what exists without paying the body cost.
2. **Instructions** — the agent calls `local:load_skill({name})` to pull the full SKILL.md body (frontmatter stripped, resources listed).
3. **Resources** — `scripts/*`, `references/*` are read on demand via the existing `local:read_file` tool.

## Per-node scoping

Via `NodeAttrs`:

```dot
narrow [skills="pdf-processing,csv-parsing"]   // intersection only
noSkills [skills_disabled=true]                // no catalog, no load_skill
```

## Config override

In `.swarm/config.yaml`:

```yaml
skills:
  paths: [.agents/skills, vendor/agent-skills]   # disables auto-discovery
  disabled: [legacy-thing]                       # drop entirely from discovery
  trust_project: true                            # default
```

## Replay + inspection

`llm.start.skills[]` durably captures the catalog (sha256 per SKILL.md) so replay detects drift. `GET /skills` / `GET /skills/:name` expose the catalog to the web UI at `/skills` (list) and `/skills/:name` (detail + "used in recent runs" reconstructed from `local:load_skill` tool-call events).

## Authoring a skill

A skill is a directory containing a `SKILL.md` (+ optional scripts, references, assets). swarm discovers skills on startup, advertises them in the agent's system prompt, and exposes a `local:load_skill` tool so the agent can pull the full instructions on demand.

### On-disk layout

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
