---
title: Agent base prompt — sub-agents inherit the parent's framing
summary: "Sub-agents see the same `<environment>` + `<project-conventions>` + child-filtered skills catalogue the parent saw, with the persona (profile body or inline `system_prompt`) appended last. Project context flows through; nested-agent catalogues deliberately stay out."
status: shipped
maturity: specified
last-reviewed: 2026-05-06
---

# Agent base prompt — sub-agents inherit the parent's framing

> Before: an `agent`-tool sub-agent ran with the persona body as its
> *complete* system prompt — no environment block, no skills
> catalogue, no project conventions. Profile authors had to copy-paste
> AGENTS.md content into every body or rely on the LLM "just knowing".
>
> After (`63c12e9`, 2026-05-06): sub-agents are framed by the same
> environment + project-conventions + skills blocks the parent saw,
> with the persona appended last. The agents catalogue is deliberately
> withheld — sub-agents do not nest.

## What shipped

`materialiseForChild()` in `packages/agent/src/system-prompt.ts:345`
assembles the sub-agent system prompt from the parent's framing
inputs:

| Slot | Source | Order |
|---|---|---|
| `<environment>` | inherited verbatim from parent (`parentRunEnv`: same cwd, bootstrap, runId) | top |
| skills catalogue | filtered to `spec.skills ∩ parentSkills`; rendered as `<available_skills>` only when non-empty | |
| `<project-conventions>` | inherited verbatim (`parentContextBlock`) — same AGENTS.md the parent loaded | |
| persona | `spec.system_prompt` (agent-definition body or inline argument) | bottom |

The spawn site (`packages/daemon/src/spawn-subagent.ts:194`) calls
`materialiseForChild` with the parent's pre-rendered context block +
run env, then forwards the assembled prompt through the backend with
`skipFrameworkSystemPrompt: true` — the *backend* skips its own
framework injection because the *caller* (the spawn site) already did
it. Implementation vector is "caller owns the prompt" rather than the
proposed "rebuild via `buildSystemPrompt`", but the outcome is the
same: project context survives the boundary.

Tested in `packages/agent/test/system-prompt.test.ts:289` against
five scenarios (no persona, persona only, persona + skills filter,
empty skills filter, skills name dropped).

## Deliberate omissions

- **No agents catalogue.** Sub-agents cannot spawn grand-children.
  `agent` is stripped from the child tool pool, and
  `materialiseForChild` passes `agentsCatalog: ""` unconditionally
  (`system-prompt.ts:364`). Rationale: nesting expands the failure
  surface (cost rollups, transcript fan-out, abort propagation) for
  no concrete use case yet. Re-evaluate when one shows up — the lift
  is mechanical at that point (gate the catalogue on
  `spec.allowed_tools.includes("agent")`).
- **No `<protocol>` block.** Sub-agents are tool invocations, not
  workflow nodes. The abort emit contract (`<abort>…</abort>` halts
  the run) is meaningless inside a tool call — emitted text just
  lands as toolResult on the parent's stream. The block is dropped
  via `includeProtocol: false`.

## What this depended on

- `parentContextBlock` + `parentRunEnv` plumbed through
  `SpawnSubagentParentCtx` (`spawn-subagent.ts:46-55`) — the parent's
  pre-rendered `<project-conventions>` and `RunEnvironment` are
  captured at codergen-call time and forwarded to the spawn site
  verbatim.
- `materialiseForChild` was extracted into a separate function so the
  prompt assembly is unit-testable without pi-agent-core in the
  graph.

## Open follow-ups (small)

- **Profile-body strip pass.** Existing `.agents/agents/*.md` bodies
  may still re-state cwd, project conventions, or skill availability
  to compensate for the old missing scaffold. Walk them once, drop
  the duplications. Pure delta on each file; no behavioural change.
- **Nested-agent catalogue (deferred).** If a real "this reviewer
  needs to delegate to that specialist" use case lands, gate the
  catalogue on `spec.allowed_tools.includes("agent")` and recursively
  pass `parentAgents` through `materialiseForChild`. Single
  catalogue source; the current "no agents catalogue" line in
  `system-prompt.ts:364` becomes the conditional.
