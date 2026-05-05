---
title: Skill tool
status: shipped
maturity: stable
last-reviewed: 2026-05-12
---

# Skill tool

A built-in `Skill` tool for codergen calls that loads a named skill,
parses its frontmatter, substitutes `$ARGUMENTS`, and returns the
rendered body. Replaces the current "Read the SKILL.md file" loading
convention with an explicit, observable tool call.

The motivation is legibility, not gating: skills are already
universally available via the catalogue prepended to every codergen
call's system prompt. What's missing is a distinct event in the run
timeline ("frontend skill loaded at step 7"), a viz card the operator
can scan, and central frontmatter parsing so the model never wastes
tokens on `---` blocks. A dedicated tool gives all three.

## Goals

- A built-in tool — always available on every codergen call, not gated
  by `allowed_tools`. Zero `.dot` migration required.
- Signature: `Skill({ name: string, arguments?: string })`. Single
  skill per call; the viz card stays 1:1 with the load.
- `$ARGUMENTS` substitution in the skill body, identical to the DOT
  prompt convention in `packages/core/src/engine/substitution.ts`.
- Distinct event variants (`tool.start.skill` / `tool.end.skill`) so
  the web UI renders a Skill card instead of a generic toolCall card.
- Central frontmatter parsing: only `name` + `description` are honoured
  by the catalogue; other keys pass through in the body untouched.

## Non-goals

- **Opt-in gating.** Skills stay available by default; no
  conditional-catalogue logic, no per-node `allowed_tools` flag for
  Skill. We can revisit if a "skills off" use case appears later.
- **Batched multi-skill loads.** One skill per call. Keeps the viz
  1:1 with the load and avoids deciding which skill's body comes
  first in the result.
- **Frontmatter-key parsing beyond `name` + `description`.** No
  `triggers` / `when_to_use` / `requires_tools` honoured by the
  engine. Skills that want richer metadata can put it in the body.
- **In-memory caching of skill bodies.** Re-read each invocation via
  `ExecutionEnvironment.readFile`. Hot edits during a run are visible
  to subsequent calls; the call cost is one filesystem read per load.
- **`.dot` workflow edits.** Built-in means existing workflows pick up
  the tool without touching `allowed_tools`.

## Design

### Behaviour

1. Look up `name` in the existing skills catalogue (project skills
   override global on name collision — already how
   `@swarm/workspace/src/skills/discover.ts` resolves).
2. Read SKILL.md via `ExecutionEnvironment.readFile`. No in-memory
   cache.
3. Parse frontmatter once → `{ name, description }`. Other keys pass
   through unchanged in the body block.
4. Substitute `$ARGUMENTS` in the body with the input string. Empty
   string when `arguments` is absent — same convention as DOT prompts.
5. When the body has no `$ARGUMENTS` placeholder but `arguments` were
   passed, append them as a trailing `<invocation>...</invocation>`
   block so they're never silently dropped.
6. Unknown name → tool error containing a short list of available
   skill names. Cheap recovery path for the model.

### Result shape

To the model:

```
# Skill: <name>
_<description>_

<substituted body>
```

To the event store (durable on `tool.end.skill.payload`):

```ts
{
  name: string;
  description: string;
  path: string;       // resolved SKILL.md path, project or global
  content: string;    // post-substitution body
}
```

The structured payload drives the UI's Skill card; the rendered
markdown above is what flows into the model's tool-result message.

### Catalogue copy change

`renderSkillsCatalog` in `packages/workspace/src/skills/catalog.ts`
flips its load-instruction text:

- Before: "Read the SKILL.md file to load this skill."
- After:  `Skill({ name: "<name>", arguments: "..." })`

Body unchanged otherwise.

### Sub-agents

`materialiseForChild` already filters the parent's catalogue by
`spec.skills`. Skill is built-in for sub-agents the same way it is for
the parent — no per-level opt-in. The filtered catalogue determines
what the sub-agent *can* call; the tool itself is always wired.

## Implementation surface

- `@swarm/workspace/src/skills/` — add `loadSkill(env, name, arguments)`
  helper alongside the existing `parse.ts` + `catalog.ts`. Returns the
  structured payload above.
- `@swarm/workspace/src/skills/catalog.ts` — flip `renderSkillsCatalog`
  load-instruction text.
- `@swarm/agent/src/tool-adapter.ts` — register Skill with pi-ai as a
  built-in tool, present regardless of node `allowed_tools`.
- `@swarm/types/src/events.ts` — declare `tool.start.skill` and
  `tool.end.skill` event variants. **Same-PR obligation**: update
  `docs/ARCHITECTURE.md` §3 (event taxonomy) — this is the event
  envelope.
- `@swarm/web/` — add a Skill toolCall card renderer. Look in
  `src/components/ai-elements/` for the existing toolCall variants.
  Renders skill name + description + truncated args + collapsible
  body.
- `AGENTS.md` — one line under Ground rules pointing at the new tool,
  since "Read SKILL.md" is currently the loading convention encoded in
  prose elsewhere.

## Tests

- `loadSkill` substitution edge cases:
  - body with no `$ARGUMENTS` placeholder + non-empty args → trailing
    `<invocation>` block appended.
  - body with one `$ARGUMENTS` + empty args → empty string
    substituted (no `<invocation>` appended).
  - body with multiple `$ARGUMENTS` → all occurrences substituted.
- Unknown name → tool-error result with available-name list.
- Frontmatter round-trip: parse SKILL.md → render to model → asserted
  shape.
- Sub-agent inheritance: parent loads catalogue {A, B, C}, child spec
  filters to {A}, child can still call `Skill({name: "A"})` and
  cannot call `Skill({name: "B"})` (returns unknown-name error).

## Open questions

None — design fully resolved during brainstorming.

## What shipped vs. what was proposed

Two deliberate deviations from the original sketch:

1. **Tool name is `skill` (lowercase), not `Skill`.** Bare-identifier
   constraint on `ToolRegistry` (`/^[a-z][a-z0-9_]*$/`) — lower-case
   names compose with the existing four-tool surface
   (`read` / `write` / `edit` / `bash`) without a special-case carve-out.
2. **No new `tool.start.skill` / `tool.end.skill` event variants.** The
   tool reuses the existing `tool.execution_start` / `tool.execution_end`
   envelope and the UI dispatches the dedicated card on
   `tool_name === "skill"` — the same precedent every other built-in
   card (bash spill notice, edit diff, web_fetch URL pill, agent
   sub-agent transcript) follows. Avoids fragmenting the event taxonomy
   for what's structurally a UI dispatch concern; the structured
   payload (`{name, description, path, content}`) lands on
   `tool.execution_end.data.result.details.data` exactly as the proposal
   describes, just under the existing event type rather than a new one.
   No `EventType` union edit, no ARCH §3 update.

Everything else landed as written: built-in (force-included by
`PiCodergenBackend` regardless of `allowed_tools` / `denied_tools`),
single skill per call, `$ARGUMENTS` substitution, trailing
`<invocation>` block when the body has no placeholder, central
frontmatter parsing (only `name` + `description` honoured), unknown-name
recovery hint, sub-agent inheritance via `materialiseForChild`, and the
flipped catalog instruction text in `renderSkillsCatalog`.
