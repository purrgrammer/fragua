---
title: Periodic introspection workflow
status: in-progress
maturity: specified
last-reviewed: 2026-05-01
---

# Periodic introspection workflow

> A swarm `.dot` workflow that produces an honest, evidence-based
> assessment of the system: code-vs-docs drift, proposal hygiene,
> runtime-health spot checks, prioritised findings. Designed to be run
> periodically (weekly, or before releases) to catch the kind of drift
> the 2026-05-01 review session uncovered manually.
>
> **Landed:** `.swarm/workflows/introspect.dot` — four codergen nodes,
> read-only, runnable today via `bun run swarm run introspect`.
>
> **Outstanding:** `glob` / `list` primitive agent tools so node prompts
> don't have to fall through `bash` for filesystem enumeration; an
> archival path for the synthesised review (today the report lives in
> the run's transcript, not in a stable file location).

## Shape

`.swarm/workflows/introspect.dot` — four codergen nodes:

1. **`collect`** — load the contract surface (`schema.sql`,
   `swarm-events.ts`, `handler/types.ts`, `intent-fold.ts`), the
   contract docs (SPEC, ARCH, handler-contract, intent-fold, PENDING),
   README, every `docs/proposals/*.md`, and the three `swarm-*` skill
   files (`.agents/skills/swarm-author/SKILL.md`,
   `.agents/skills/swarm-run/SKILL.md`,
   `.agents/skills/swarm-debug/SKILL.md`). Run `git log -30` and the
   per-file commit log. Produces a structured snapshot.

2. **`drift`** — cross-references code-vs-docs surface by surface
   (status enum, intent types, fact types, halt reasons, schema
   columns, fold rules) **plus the swarm-* skill files** against the
   code they document: `swarm-author` against the DOT grammar +
   validator codes + retry presets + substitution tokens; `swarm-run`
   against HTTP routes + intent endpoints + the CLI shape;
   `swarm-debug` against the event taxonomy + halt reasons + run-state
   shape. Tags each finding by severity (CRITICAL / HIGH / MEDIUM /
   LOW). Reads recent commits to flag any contract-file change that
   didn't update its corresponding doc per AGENTS.md rule #1.

   Skill drift is a real exposure: the validator codes (E001–E015,
   W001–W010), the DOT shape table, the substitution tokens, the
   retry-policy preset names, the HTTP route shapes, and the event
   taxonomy each appear inside one or more skills as documented
   contracts. A change to `validator.ts` that doesn't update
   `swarm-author/SKILL.md` will silently mislead the next agent
   loading the skill — exactly the failure mode AGENTS.md rule #1 was
   designed to prevent for `docs/`.

3. **`health`** — read-only `sqlite3 .swarm/swarm.db` queries: cap-
   near-miss rate (events at 80%+ of the 4 KB cap), routing-bytes
   percentiles, halt-reason distribution, leak rate, recently-
   quarantined runs, daemon-event counts by type. Each result tagged
   OK / WATCH / ALERT.

4. **`synthesize`** — consolidates findings, produces the final
   assessment in three sections: findings table grouped by severity
   with file:line refs; ratings (Idea / Architecture / Execution out of
   10) calibrated against the original audit baseline (8.5 / 8 / 7.5);
   top 3–5 prioritised recommendations.

`allowed_tools = "read, bash"` on every node; read-only by construction.
Once `glob` / `list` primitive tools land, the bash dependency for
filesystem enumeration drops away.

Budget: `budget_usd = 5.00` at the graph level; per-node `max_cost_usd`
caps each phase. Cost scales with how much the model needs to re-read.

## Cadence

- **Manual**: `bun run swarm run introspect`. Optional `--input` to
  scope the review (e.g., `--input="focus on the worktree subsystem"`).
- **Periodic**: `/loop 7d` or a cron-driven `swarm run introspect`
  invocation on a chosen schedule. Output ends up in the run's
  transcript and the global SSE feed.
- **Pre-release**: include in the release-checklist; review the
  prioritised findings before tagging.

## Why this is load-bearing

The drift this session uncovered was real and would have grown without
intervention. Catching it manually scaled to roughly one
engineer-day of senior attention; running this workflow weekly is on
the order of $5 of LLM cost and produces equivalent prose output.

The [drift-lint](./drift-lint.md) proposal is the structural-
enforcement counterpart. This workflow is the *narrative* counterpart
— it produces prose suitable for release-readiness review, not just a
pass/fail signal. The two address the same problem from different
angles and complement rather than substitute.

## Open questions

- **Archival path.** Today the synthesised review lives in the run's
  transcript and SSE feed; nothing writes it to a stable filename. A
  follow-up could route the synthesise node's output through
  `ctx.artifacts.put(...)` keyed by date so a `.swarm/analyses/` folder
  accumulates timestamped reviews. Read-only constraint complicates
  this; an opt-out flag may be needed.
- **Duplicate output between this workflow and drift-lint.** When the
  lint exists, the drift node here re-derives the same findings. Could
  trim by having drift consume the lint's JSON output instead of
  re-cross-referencing. Decide once both ship.
- **Cost calibration.** The 5 USD graph budget is a guess. The first
  several runs will tell us whether the four-node split is
  cost-efficient or whether collapsing to two nodes (collect+analyse,
  health+synthesise) makes more sense.
- **Extend AGENTS.md rule #1 to skill files.** The same-PR doc-touch
  table currently names `schema.sql`, `swarm-events.ts`,
  `handler/types.ts`, `intent-fold.ts`. The `swarm-*` skills cite each
  of those plus the validator, the retry-policy presets, and the
  HTTP/CLI surface — they drift in lockstep. A natural extension is to
  add rows mapping `validator.ts` → `swarm-author/SKILL.md`,
  `routes.ts` / `commands/run.ts` → `swarm-run/SKILL.md`,
  and `swarm-events.ts` → `swarm-debug/SKILL.md`. Pending until this
  workflow's first run shows what's actually drifting; the table grows
  in response to evidence rather than speculation.

## What this does not commit to

- **Auto-applying fixes.** The workflow produces findings; humans
  triage and fix. Auto-fix is the [drift-lint](./drift-lint.md)
  territory and even there it's structural-only.
- **Replacing manual review entirely.** Hard problems
  ([worktree-design](./worktree-design.md), proposal prioritisation)
  need a human; this workflow surfaces them but doesn't decide them.
- **Cross-project introspection.** Single-project; the
  [harness](./harness.md) brings multi-project later.
