---
title: Agent definitions — named, reusable sub-agent profiles
summary: "Named sub-agent profiles loaded from `.agents/agents/` + `~/.agents/agents/`, resolved at `agent` tool spawn site"
status: shipped
maturity: designed
last-reviewed: 2026-05-05
---

# Agent definitions — named, reusable sub-agent profiles

> Promote V1's `agent-tool.md` non-goal "named/file-defined agent
> profiles" to a feature. A sub-agent profile is a markdown file with
> YAML frontmatter declaring `name`, `description`, optional
> `model` / `provider` / `allowed_tools`, and a body that becomes the
> sub-agent's system prompt. The parent's codergen node sees a
> catalogue of available agents in its system prompt and invokes one
> by name through the existing `agent` tool. Inline form keeps
> working — named profiles are sugar over it.

## Goals

- Two well-known scopes mirroring skills: project (`<cwd>/.agents/agents/`)
  and user (`~/.agents/agents/`), with project beating user on name
  collision. `.claude/agents/` scanned as a cross-client fallback.
- File format: flat `.md` with YAML frontmatter — `name` (required),
  `description` (required), optional `model` / `provider` /
  `allowed_tools`. Body becomes the system prompt.
- Discovery happens once at daemon boot, mirrors the skills pattern
  in `packages/workspace/src/skills/`.
- The `agent` tool gains an optional `agent: string` parameter. When
  set, the named def's fields fill in unspecified slots; inline
  params on the same call override the def.
- When the `agent` tool is bound to a codergen node, the parent's
  system prompt gains an "Available agents" block listing every
  discovered profile's `name` + `description`. Bodies are not
  injected into the parent — only into the sub-agent on spawn.
- Tool names in `allowed_tools` are lowercase snake_case (`read`,
  `grep`, `bash`, `web_fetch`, …) per swarm convention. The loader
  normalises any case it sees, including PascalCase multi-word names
  from Claude-style files (`Read` → `read`, `WebFetch` → `web_fetch`),
  so cross-tool imports don't silently fail the intersection check.
- Inherit-by-default for `model` / `provider`: omitted fields fall
  through to the parent's choice. There is no per-call override at
  the spawn site — the def is authoritative once `agent: <name>` is
  passed.

## Non-goals (V3 territory)

Lifted from V1 and explicitly **not** added by this proposal:

- DOT-node integration (declaring `agent: <name>` on a workflow node
  in place of inline `system_prompt:` / `model:` attrs).
- Per-call `model` / `provider` override at the spawn site.
- Persistent memory directories (`memory: user/project/local`).
- Lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`).
- `permissionMode`, `disallowedTools`, `mcpServers` per-agent.
- Plugin / managed scopes — defer until plugins exist.
- Forked agents (full-history inheritance — V1 already excludes this).
- Nested spawning — V1 already strips `agent` from the sub-agent's
  pool; named profiles inherit that constraint.

## File format

```markdown
---
name: code-reviewer
description: Reviews diffs for security, clarity, and convention adherence. Use after edits.
model: claude-haiku-4-5-20251001    # optional; else inherit
provider: anthropic                  # optional; else inherit
allowed_tools: [read, grep, bash]    # optional; else inherit parent's pool
---

You are a senior code reviewer. When invoked:
1. Run `git diff` to see recent changes.
2. Focus on modified files only.
3. Report critical issues, then warnings, then suggestions.
…
```

Frontmatter constraints (mirror skills, lenient validation):

| Field           | Required | Notes                                                                                                       |
| :-------------- | :------- | :---------------------------------------------------------------------------------------------------------- |
| `name`          | Yes      | Lowercase a–z, 0–9, hyphen. Must match filename stem. Max 64 chars.                                         |
| `description`   | Yes      | Plain text, max 1024 chars. Used in the parent's catalogue block.                                           |
| `model`         | No       | Provider-specific model id (e.g. `claude-haiku-4-5-20251001`). Resolved against `~/.swarm/auth.json` provider mapping. |
| `provider`      | No       | Provider name. Inherits when omitted.                                                                       |
| `allowed_tools` | No       | Array of lowercase tool names. Loader lowercases inputs and emits a warning if a non-lowercase name is seen. |

Validation matches skills: warn, never skip — except for missing
`name` or `description`, which skip with a warning (without them the
profile can't be advertised in the catalogue).

## Discovery

```
packages/workspace/src/agents/
  discover.ts   # scan project + user roots, collide by name
  parse.ts      # reuse @swarm/workspace YAML frontmatter parser
  types.ts      # re-export AgentDefinition from @swarm/types
  catalog.ts    # in-memory catalog + lookup-by-name
  index.ts
```

Roots scanned, in order (project always wins on `name` collision;
within a scope, earlier root wins):

| Order | Path                       | Scope   |
| :---: | :------------------------- | :------ |
|   1   | `<cwd>/.agents/agents`     | project |
|   2   | `<cwd>/.claude/agents`     | project |
|   3   | `~/.agents/agents`         | user    |
|   4   | `~/.claude/agents`         | user    |

The daemon scans both layers at boot, alongside the existing skills
scan. Re-scan triggers and a hot-reload story track skills' (none
today; restart picks up changes) — don't add a new mechanism here.

## Tool surface change

`packages/workspace/src/agent.ts` adds one optional param:

```ts
agent({
  agent?: string,                 // ← NEW: name of a discovered profile
  description?: string,
  prompt: string,
  system_prompt?: string,
  allowed_tools?: string[],
  disallowed_tools?: string[],
  skills?: string[],
  max_iterations?: number,
})
```

Semantics when `agent: <name>` is passed:

| Sub-agent field   | Resolution                                                                                          |
| :---------------- | :-------------------------------------------------------------------------------------------------- |
| `system_prompt`   | inline `system_prompt` ?? def body ?? inherit parent                                                |
| `allowed_tools`   | (inline `allowed_tools` ?? def `allowed_tools` ?? parent's pool) ∩ parent's pool, minus `agent`     |
| `disallowed_tools`| inline only (def has no `disallowed_tools`)                                                         |
| `skills`          | inline only (def has no `skills`)                                                                   |
| `model`           | def `model` ?? inherit parent                                                                       |
| `provider`        | def `provider` ?? inherit parent                                                                    |
| `max_iterations`  | inline only (def has no `max_iterations`)                                                           |
| `description`     | def `description` (used as the spawn label on `subagent.start`)                                     |

If `agent: <name>` is passed and no profile with that name exists,
the tool call fails with a structured error listing the discovered
names. No silent fallback to inline form.

When `agent` is omitted, behaviour is identical to V1.

## Catalogue injection

`packages/agent/src/system-prompt.ts` already builds the per-run
system prompt. When the run's tool pool includes `agent` and at
least one profile is discovered, append:

```
## Available sub-agents

Spawn one of these by calling the `agent` tool with `agent: <name>`.
Their full system prompts are loaded only when spawned, not here.

- `code-reviewer` — Reviews diffs for security, clarity, and convention adherence. Use after edits.
- `researcher` — Reads docs and codebase to answer factual questions. Returns a summary, no edits.
- …
```

Cost: `name + description` for every discovered profile, on every
spawn-capable codergen node. Token bound: 1 KB per profile × N
profiles. With 50 profiles this is ~50 KB on the prompt — acceptable
for v1; revisit with `payload-pressure-signal.md` if it bites.

Catalogue is **all-discovered**, not node-declared. A node opts out
of catalogue cost the same way it opts out of the tool: drop `agent`
from `allowed_tools`.

## Resolution + spawn flow

`packages/daemon/src/spawn-subagent.ts` (already in flight per `git
status`) gains a `resolveAgentDef(name)` lookup against the catalog
loaded at boot. On a call with `agent: <name>`:

1. Look up the def. Missing → fail the toolcall with a structured
   error and the list of available names.
2. Merge def fields into the spec per the table above.
3. Continue the existing V1 spawn flow (synthesise child node,
   wrap emit, run backend, emit `subagent.{start,end}`).

The `subagent.start` event payload gains an optional `name: string`
(the resolved profile name) so the UI can group spawns by profile and
so analytics can attribute cost per profile later.

## Tool name normalisation

The loader normalises every entry in `allowed_tools` before storing,
emitting a warning for any input that wasn't already in canonical form.
Two rules, applied in order:

1. Insert `_` between any lowercase→uppercase boundary
   (`WebFetch` → `Web_Fetch`).
2. Lowercase the whole string (`Web_Fetch` → `web_fetch`).

Worked examples:

```yaml
allowed_tools: [Read, Grep, WebFetch]
# accepted; warning emitted per non-canonical entry;
# stored as [read, grep, web_fetch]
```

Same rule applies on inline `allowed_tools` passed to the `agent`
tool — keeps the surface symmetric and prevents Claude-style names
(`WebFetch`, `Bash`, …) from silently failing the intersection check
against swarm's canonical pool (`web_fetch`, `bash`, …).

## Schema

No schema additions. Profile catalog is in-process; agent file
contents and parsed metadata are not persisted to the store.

## Same-PR doc obligations (per AGENTS.md §1)

| File touched                                          | Same-PR doc update                                                                                          |
| :---------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| `packages/types/src/index.ts` — new `AgentDefinition` | None — types-only addition, not a contract enum.                                                            |
| `packages/workspace/src/agent.ts` — new `agent` param | Update this proposal's "Tool surface change" if param renamed; no other contract surface.                   |
| `packages/agent/src/system-prompt.ts` — catalogue injection | None — internal prompt assembly.                                                                       |
| `packages/daemon/src/spawn-subagent.ts` — def resolution | `agent-tool.md` "Goals" line saying "no named/registered profiles" must be updated to point here as V2.  |
| `packages/types/src/events.ts` — `subagent.start.name` field | `docs/ARCHITECTURE.md` §3 explanatory note on sub-agent events.                                        |
| New `.agents/agents/` directory pattern               | `AGENTS.md` codebase map (skills paragraph extends to mention agents).                                      |
| Capability claim                                      | `STATUS.md` "What swarm delivers today" — name profiles + catalogue.                                        |

## Open questions for review

None blocking. Two worth flagging:

1. **Frontmatter key for the system prompt.** Currently the body
   *is* the prompt (matches Claude). Considered: a `system_prompt:` key
   in frontmatter, body unused. Body-as-prompt wins on ergonomics —
   markdown lints / preview / multi-paragraph editing all just work.
   Locked unless review prefers otherwise.

2. **Catalogue token budget.** 50 KB on a node's prompt is the worst
   case at 50 profiles. Acceptable now; if this becomes the dominant
   prompt cost we can compress to `name — first-sentence-of-description`.
   Filed under `payload-pressure-signal.md` as a watch item, not a
   v1 blocker.
