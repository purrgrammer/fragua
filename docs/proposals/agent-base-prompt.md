---
title: Agent base prompt — inherit the parent's system-prompt scaffold
summary: "Sub-agents get a freshly-rebuilt copy of the parent's system-prompt scaffold (env / skills / agents catalogue / context files) with the profile body as the per-node specialisation, instead of running with a naked profile body."
status: proposed
maturity: sketch
last-reviewed: 2026-05-05
---

# Agent base prompt — inherit the parent's system-prompt scaffold

> Today an `agent`-tool sub-agent runs with `skipFrameworkSystemPrompt:
> true` — its profile body becomes the *complete* system prompt, with
> no environment block, no skills catalogue, no agent catalogue, no
> context files. Profile authors have to either re-state project
> conventions in every body or rely on the LLM "just knowing." This
> proposal flips the default: sub-agents get the same shape of system
> prompt the parent gets, rebuilt for the sub-agent's identity, with
> the profile body taking the `perNode` specialisation slot.

## Problem

`packages/agent/src/backend.ts:377`:

```ts
const systemPrompt = input.skipFrameworkSystemPrompt
  ? (perNodeSystemPrompt ?? "")
  : buildSystemPrompt({ global, perNode, contextBlock, skillsCatalog, agentsCatalog, runEnv });
```

The `agent` tool spawns sub-agents with `skipFrameworkSystemPrompt:
true`, so the body of `.agents/agents/<name>.md` *is* the entire
system prompt. Three failure modes follow:

1. **Convention drift.** Profile bodies copy-paste project conventions
   (cwd, conventions, "use the skill tool for X") to compensate for
   the missing scaffold. They then rot independently.
2. **No skill discovery.** Sub-agents can't see the skill catalogue,
   so `skill({ name: "..." })` calls are guesswork. Authors work
   around this by inlining the relevant skill content into the
   profile, defeating the on-demand-loading point.
3. **Nested-agent dead-end.** Sub-agents can't see the agent
   catalogue either, so a `code-reviewer` agent can't delegate to a
   `security-engineer` agent even when `agent` is in its
   `allowed_tools`.

## Design — rebuilt scaffold, profile body as `perNode`

When the parent's `agent` tool spawns a sub-agent, assemble the
sub-agent's system prompt by calling `buildSystemPrompt()` afresh
with the sub-agent's identity:

| Slot | Source |
|---|---|
| `runEnv` | inherited from parent (same cwd / branch / run_id) |
| `contextBlock` | inherited from parent (same project context files) |
| `skillsCatalog` | rebuilt for the sub-agent's `allowed_tools` (skill tool always force-included) |
| `agentsCatalog` | rebuilt **iff** the sub-agent's tool pool includes `agent` — see below |
| `global` | the framework codergen preamble (same as parent) |
| `perNode` | **the profile body** — replaces the global preamble per existing `mergeSystemPrompt` semantics |

The profile body keeps its current role as the specialisation delta —
"you are the X specialist, you do Y" — and stops carrying scaffold
duplication.

### Why rebuilt, not literal-forwarded

A literal copy of the parent's rendered system prompt would inherit
the parent's tool list (which the sub-agent doesn't have), the
parent's `perNode` body (which is a different agent's specialisation),
and the parent's agent-catalogue entries that are filtered by the
parent's tool pool, not the sub-agent's. Rebuilding lets each slot
reflect the sub-agent's actual identity.

It's also cache-friendlier: the parent's prompt and each sub-agent's
prompt become independent stable strings within a run. Calls to the
same sub-agent within a run share a cache key on the assembled base.

### Nested agent catalogue — gated on the `agent` tool

A sub-agent sees the agent catalogue **iff** its resolved
`allowed_tools` includes `agent`. This makes nesting opt-in via the
mechanism that already exists:

- Profile declares `allowed_tools: [read, edit, agent]` → sub-agent
  receives the catalogue, can spawn its own sub-agents.
- Profile declares `allowed_tools: [read, edit]` (or omits `agent`) →
  catalogue is filtered out; the spawn site short-circuits, saving
  ~1 KB per profile in catalogue tokens.

Default behaviour for a profile with no `allowed_tools` is whatever
the codergen backend's default pool is today — if `agent` is in the
default, nesting is on by default. (`packages/agent/src/backend.ts`
already force-includes `skill` regardless of denylists; the same
treatment for `agent` is *not* proposed here — keep the gate
explicit.)

### Skills inheritance

The skill catalogue is rebuilt against the sub-agent's tool pool —
the skill tool itself is force-included (same as the parent), so
sub-agents can always `skill({ name })` to load on-demand domain
context. The catalogue's *content* is the same set of discovered
skills (`~/.agents/skills` ∪ `<cwd>/.agents/skills`), since skills are
project-scoped not agent-scoped.

### Profile frontmatter — no new keys

The existing frontmatter (`name`, `description`, `model`, `provider`,
`allowed_tools`) is enough to drive everything. No new opt-in/opt-out
flag for inheritance — the agent-catalogue gate already keys off
`allowed_tools`, and the rest of the scaffold is universally useful.

If we discover a profile that genuinely wants a clean slate (no env
block, no skills catalogue, no project context), the existing
`skipFrameworkSystemPrompt` escape hatch stays available as the
all-or-nothing override. We don't expose it through frontmatter
unless a real use case shows up.

## Implementation sketch

Two commits:

1. **`[agent]` flip the sub-agent default.** In
   `packages/agent/src/backend.ts`, the `agent` tool's spawn site
   stops setting `skipFrameworkSystemPrompt: true` for named-profile
   invocations. The profile body flows into `perNodeSystemPrompt`;
   `buildSystemPrompt()` does the rest. Inline (LLM-spawned, no
   profile) sub-agents keep the existing behaviour — their "profile
   body" is whatever the LLM passed, and they get the same scaffold.
   Update profile-discovery snapshot tests in
   `packages/agent/test/`.

2. **`[skills,agents]` strip scaffold duplication from existing
   profiles.** `.agents/agents/*.md` bodies that re-state cwd,
   project conventions, or skill availability lose those lines —
   the scaffold now carries them. Pure delta on each file; no
   behavioural change beyond what (1) already produced.

## Cache discipline

`buildSystemPrompt()` already orders blocks: `runEnv` →
`skillsCatalog` → `agentsCatalog` → `contextBlock` → `global` /
`perNode`. The order keeps the most-stable bits (run env, skills,
agents) at the top so prompt-cache breakpoints land naturally between
blocks. The profile body sits at the bottom — varies per agent, but
within a run it's stable per `(agent name, run id)`, which is the
unit of cache reuse we want.

No new cache discipline is required as long as the spawn site uses
`buildSystemPrompt()` for the assembly (i.e. doesn't ad-hoc
concatenate strings around it).

## Anti-goals

- **Not a "shared system prompt" layer.** There is no separate "agent
  base prompt" file — the scaffold *is* what `buildSystemPrompt()`
  produces, same as the parent. No new authoring surface.
- **Not changing inline (LLM-passed-string) sub-agents' semantics
  silently.** Inline agents already accept a string body; they get
  the same scaffold flip as named profiles in (1). If a workflow
  relied on the bare-string behaviour, the migration path is the
  existing `skipFrameworkSystemPrompt` flag at the spawn site.
- **Not propagating the parent's literal rendered prompt.** Rejected
  for the reasons in *Why rebuilt, not literal-forwarded*.
- **Not introducing a new frontmatter key.** Inheritance is the
  default; nesting gates on `allowed_tools` includes `agent`. New
  keys are dead weight until a real escape hatch shows up.

## Open questions

- **Default-pool nesting.** If the codergen backend's default
  `allowed_tools` includes `agent` today, sub-agents that omit
  `allowed_tools` will silently gain nesting after this lands. Worth
  confirming that's intended; if not, the `agent` tool should be
  excluded from the *sub-agent default pool* specifically, while
  staying in the parent's default. Single-line change at the spawn
  site, but worth a deliberate decision rather than a side effect.
- **Token budget impact.** A typical scaffold today is ~2–3 KB of
  prompt. Sub-agents currently ship ~0.5–1 KB (profile body). The
  delta is ~2 KB per sub-agent invocation; cached after the first
  call. Worth measuring on a real run before assuming it's fine.
- **`allowed_tools` resolution for catalogues.** The skill catalogue
  is filtered against `allowed_tools`; should the agent catalogue do
  the same once it ships (e.g. an agent's `allowed_agents:
  [security-engineer]` field)? Out of scope for this proposal —
  flagged as a follow-up under `agent-definitions.md`.
