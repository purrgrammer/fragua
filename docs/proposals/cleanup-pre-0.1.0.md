---
title: Pre-0.1.0 cleanup — remove the agent tool, drop legacy shims, collapse migrations, widen run_id
summary: "A cruft-removal phase BEFORE the CLI-topology line of work. Nuke the `agent` tool and all sub-agent machinery (spawning, discovery, catalogue, agent pages, parent-run plumbing). Remove all legacy / backwards-compat shims (the `config.jsonc` reader + deprecation warnings, etc.) — we are pre-0.1.0, ground rule #11 forbids prior-state references. Collapse the v1→v17 migration chain into a single fresh baseline schema and reset the schema-version baseline. Fold the run_id widening in as a free bonus while the schema is being reset. §7 is the ordered, leaves→roots execution plan."
status: proposed
maturity: designed
last-reviewed: 2026-05-21
parent: cli-topology.md
---

# Pre-0.1.0 cleanup

> **Precursor.** This lands *before* the [CLI-topology](cli-topology.md) line of
> work. It is pure subtraction + a schema reset; it has no dependencies and it
> removes rough edges from several downstream proposals (see §4). 0.1.0 is
> imminent — this is the last cheap moment to cut cruft and reset the schema
> with no migration debt.

## 1. Nuke the `agent` tool and all sub-agent machinery

Distinct from `@fragua/agent` (the `PiLlmBackend` that powers **every** `llm`
step — that stays). This removes the **`agent` *tool*** — the sub-agent
spawning capability — and everything built around it:

- **Tool + spawning:** `packages/workspace/src/agent.ts`, the `agent` tool
  registration in `packages/workspace/src/tools.ts`,
  `packages/daemon/src/spawn-subagent.ts`.
- **Discovery + catalogue:** `packages/workspace/src/agents/{discover,catalog,types}.ts`
  and the boot-time scan; the catalogue injection into llm calls in
  `packages/agent/src/{backend,system-prompt}.ts` and
  `packages/agent/src/handler-bridge.ts`.
- **Server + web:** `packages/server/src/store/agents-routes.ts`; the web
  `Agents` / `AgentDetail` routes, `components/agents/`, and the agent surfacing
  in `RunDetail` / `RunConversation` / `CostInspector`.
- **Parent/sub-agent plumbing:** the `parentRunId` / `parentNodeId` /
  `parentIteration` context + event-payload fields that key a sub-agent's
  transcript under a synthetic `__subagent:<id>` nodeId in the *parent's*
  `messages` table (`packages/daemon/src/spawn-subagent.ts`,
  `packages/agent/src/backend.ts`, `packages/core/src/types/events.ts`,
  `packages/server/src/store/steps.ts`). **Correction (verified against
  `schema.sql:86–148`):** these are *not* `run_state` columns. The `run_state`
  `parent_run_id` / `parent_node_id` / `parallel_index` columns were added at v9
  for the *parallel sub-runs* feature and **already dropped at v13** — the
  current baseline has none of them. So "remove parent-run concerns" = remove
  this *plumbing* + discard the v9-add/v13-drop migration churn (§2); there is
  nothing to drop from the live schema. The web `parallel_index` in
  `GraphView` / `edge.tsx` is **live graph-layout** rendering for parallel
  fan-out edges — *keep it*.
- **Skills/profiles:** the `.agents/agents/` discovery and the
  named-sub-agent-profile catalogue. Skills discovery
  (`packages/workspace/src/skills/`) is a parallel-but-separate path — it
  **stays**; confirm no shared discovery helper before deleting agents'.

Grounding the surface: `rg -l 'subagent|discoverAgents|agent_catalogue'
packages/*/src` spans ~25 files across every package — wide but mechanical.

## 1b. Remove legacy / backwards-compat shims

We are pre-0.1.0 (ground rule #11: no prior-state references) — every "read the
old form with a deprecation warning" shim should just go:

- **`config.jsonc`** (`packages/cli/src/config.ts`): delete the
  `.fragua/config.jsonc` reader, the JSONC stripper (`parseJsoncBody`), the
  "deprecated — rename to config.yaml" warning, and the "shadowed by .yaml"
  warning. **YAML only.** Update the config-resolution doc comment to drop the
  legacy cascade step.
- **Web config viewer** (`packages/web/src/routes/ProjectDetail.tsx`): drop the
  `CONFIG_PATH_JSONC` branch, the `kind: "yaml" | "jsonc"` discriminant, and the
  "Legacy JSONC parser" — the project config view becomes YAML-only.
- **Sweep for stragglers:** `rg -n 'jsonc|deprecat|legacy|backwards' packages/*/src`
  — most remaining hits are comments mentioning "legacy/forward compatibility";
  remove the dead code paths, leave nothing that reads a superseded format.

## 2. Collapse migrations into a fresh baseline

We are pre-0.1.0; ground rule #11 forbids prior-state references and there is no
*user-facing* deployed store to preserve. (The **local dev store** is a
different matter — see the operational note in Phase 7: this break is in-place
and unrecoverable without a backup.) So:

- Replace the `v1 → v17` `STEP_MIGRATIONS` chain + per-version `run_state`
  rebuilds in `packages/store/src/migrations.ts` with a **single baseline
  `schema.sql`** reflecting current state (the baseline already excludes the v9
  parent columns — they were dropped at v13).
- Reset `CURRENT_SCHEMA_VERSION` to `1` (`packages/store/src/pragmas.ts`).
  `migrate()` becomes "create at baseline"; there is no walk-forward chain to
  maintain until the first post-0.1.0 migration.
- The historical v9-add/v13-drop parent-column churn vanishes with the chain —
  there are no live columns to drop (§1 correction).

## 3. Widen `run_id` (free bonus)

Since the schema is being reset and `newRunId` is moving to the intent plane
anyway, swap the ULID-*like* generator (base-32 ms + 8 bytes `% 32`, ~40 bits)
for a collision-safe id (true ULID / UUIDv7 — no modulo-32 entropy loss) **now**,
so cross-machine import is collision-safe from the first 0.1.0 store. Closes
[`intent-plane.md`](intent-plane.md) decision #2 and [`db-import.md`](db-import.md)
precondition §3.1.

## 4. What this removes from downstream proposals

- **[`db-import.md`](db-import.md):** the **run-tree** rough edge is already
  moot — the baseline `run_state` has no `parent_run_id` FK (dropped at v13), so
  a run is a single self-contained row and import is a verbatim per-run copy.
  Removing the agent-tool plumbing keeps it that way (no path re-introduces a
  parent column). (Blob references remain a real edge — §5.)
- **[`event-contract-version.md`](event-contract-version.md):** the
  "v2…v17 are projection-only" historical argument resets to a **single
  baseline** at version 1. The §2.1 *axis* argument still holds for *future*
  migrations, but there is no legacy chain and no stranded-old-run population to
  reason about at 0.1.0.
- **[`fragua-ci.md`](fragua-ci.md) / executor assembly:** removing the sub-agent
  backend (`spawn-subagent`, `subagentBackend` in `daemon.ts:358`) shrinks the
  executor assembly that has to be extracted into a reusable factory — less to
  untangle.

## 5. Residual edges this does NOT solve

- **Blobs in import.** Events may reference `blobs` / `artifacts`
  (`schema.sql:215,221`); [`db-import.md`](db-import.md)'s copy set must include
  them. Unaffected by this cleanup.
- **Migration ownership / `{migrate:false}` open mode** (cli-store-client) is
  still needed — collapsing the chain doesn't change that a store-client must
  open without bumping.

## 6. Scope / sequencing

- **Depends on:** nothing.
- **Wins independently:** yes — it is strictly subtractive + a schema reset, and
  ships value (smaller surface, no migration debt) regardless of the CLI line.
- **Sequencing:** **first, before everything in the CLI-topology roadmap.** It
  is the cheapest now and never again (post-0.1.0, the migration collapse and
  column drops would need real migrations).

## 7. Decomposition (execution plan)

**Principle 1: remove leaves before roots** (a consumer before the thing it
consumes), so `bun run typecheck` + `bun test` stay green at every phase, and
each phase is one commit. Dependency direction is `web → server → store ←
daemon → core ← agent ← workspace`, so UI comes out first and the event-type /
schema removals come out last.

**Principle 2: simplify aggressively at each step — don't just delete, refactor.**
Removing the agent tool/sub-agents and the legacy shims invalidates assumptions
the surrounding code was written to satisfy: branch points that only existed for
the agent path, indirection that only one caller used, options threaded solely
for sub-agents, defensive handling of formats we no longer read. Collapse them
in the same phase. Leave **no prior-state comments** — no "used to also handle
sub-agents", no "formerly jsonc" (ground rule #11; git is the history). A phase
is done when the code reads as if the removed feature never existed.

**Spec-first gate (ground rule #1):** removing the `agent` tool removes
fragua's *only concurrent-dispatch capability* (SPEC §3.1, §5). That is a change
to what fragua **is**, so the SPEC edit leads — decide and land it before ripping
code (Phase 8a), don't let the docs lag the removal.

> Confidence: the wholesale-delete files below are from a reconnaissance pass;
> treat exact filenames/line numbers as **leads to confirm**, not gospel — a few
> (web test names, `agents/normalise.ts`, `materialiseForChild` lifetime) need a
> look before deletion. The phase *ordering* is the load-bearing part.

**Phase 0 — Legacy shims (§1b). Independent; do first.**
`cli/src/config.ts` (jsonc reader + warnings → YAML only) ·
`web/src/routes/ProjectDetail.tsx` (jsonc branch) · their tests. *Checkpoint:*
typecheck + test `cli`, `web`. Has no overlap with the agent removal, so it can
even land as its own commit ahead of everything.

**Phase 1 — Web (agent pages).** Delete `routes/{Agents,AgentDetail}.tsx`
(+tests), `components/agents/`; remove the `/agents` route from `lib/router.tsx`
and the sidebar entry; remove agent API/query hooks from `lib/api.ts` /
`lib/queries.ts`. **Partial:** strip subagent-specific rendering from
`RunConversation.tsx` / `CostInspector.tsx` while keeping step/cost display
(and keep the `parallel_index` graph-layout code — that's not agents). *Checkpoint:*
`web`.

**Phase 2 — Server.** Delete `store/agents-routes.ts` (+test); unmount it from
`server/src/index.ts`. **Partial:** remove the subagent `parentNode` field
handling in `store/steps.ts`, leaving step projection intact. *Checkpoint:* `server`.

**Phase 3 — Agent backend (partial; `@fragua/agent` stays).** In `backend.ts`:
drop the `agentDefinitions` field, the `renderAgentsCatalog` /
`filterAgentsCatalogueForRun` imports, set the catalogue string to empty, drop
`agentCatalog` from the run context. Decide `materialiseForChild`'s fate — if its
only caller is `spawn-subagent`, it goes in Phase 4. *Checkpoint:* `agent`.

**Phase 4 — Daemon.** Delete `spawn-subagent.ts` (+`subagent`/`budget-pause-
subagent-leak` tests); drop its export from `daemon/src/index.ts`; in
`cli/src/commands/daemon.ts` remove the `spawnSubagentFactory` closure, the
`discoverAgents()` call, and `agentDefinitions` from the backend opts. *Checkpoint:*
`daemon`.

**Phase 5 — Workspace.** Remove `agentTool` from `CORE_TOOLS` + its import in
`tools.ts`; drop the `agent` special-case in `sanitiseUnpairedToolCalls`
(keep the function and `stripAgentTool`); delete `agent.ts` and the `agents/`
dir (`discover`/`catalog`/`parse`/`types`; check `normalise.ts` is agent-only
before deleting). Keep `skills/`. *Checkpoint:* `workspace`.

**Phase 6 — Types / core (events).** Remove `subagent.start|end|resumed` from the
`EventType` union + `ALL_EVENT_TYPES` (`types/src/events.ts`) and the
`Subagent{Start,End,Resumed}Data` interfaces + parent plumbing types
(`core/src/types/events.ts`, `types/src/agents.ts`). Events are read-only after
recording, so this is safe once every emitter (Phases 1–5) is gone. *Checkpoint:*
typecheck **all packages**.

**Phase 7 — Store: migration collapse + run_id widen.**
- Rewrite `schema.sql` to a single baseline (Revision → 1); strip the historical
  migration-history comments.
- `migrations.ts`: empty `STEP_MIGRATIONS`; `migrate()` → create-at-baseline.
- `pragmas.ts`: `CURRENT_SCHEMA_VERSION = 1`, `MIN_COMPATIBLE_SCHEMA_VERSION = 1`.
- `run-id.ts`: widen the generator (true ULID / UUIDv7 — §3).
- Tests: rewrite `migrations.test.ts` to a fresh-DB-only assertion; delete
  per-version tests (e.g. `migration-006.test.ts`); update run_id-format tests
  and the schema-drift property test (`daemon/test/matrix.property.test.ts` P17 —
  it pins an out-of-range version; re-baseline its constants).
- *Checkpoint:* `bun run ci` (full).

> **Operational note — the local dev store breaks here.** Once `CURRENT_SCHEMA_VERSION`
> resets to `1` with an empty chain, the new code **cannot open the existing v17
> `~/.fragua/fragua.db`**: its version is ahead of `CURRENT`, and every existing
> run's pin (17) trips the executor's `schema_drift` gate. The store dies on the
> new code — *including configured `provider_credentials` / `provider_config`*.
> Before landing this phase on any working machine: **back up the DB** (a
> `~/.fragua.backup` copy exists) and either re-run `fragua providers add` on a
> fresh store, or run a **one-shot script** that lifts just the two provider
> tables from the backup into the new baseline DB (run history is disposable
> pre-0.1.0, so providers are the only thing worth carrying). The Phase 8b
> `drift` verification needs a store on the *new* schema with providers present —
> point it at the freshly-seeded DB, not the old one.

**Phase 8 — Docs, skills, and shipped workflows.** The removal touches a wide
doc surface (`agent`/`subagent`/`dispatch` appears 42× in ARCHITECTURE, 35× in
handler-contract). Two parts, bracketing the code work:

- **8a — SPEC, *first* (the spec-first gate above).** `SPEC.md` §3.1 (delete the
  "concurrent dispatch lives in the `agent` tool" paragraph), §5 (rewrite the
  "Graph-level parallel / fan-in" not-honored bullet — fragua now has *no*
  concurrent dispatch at all), and any §3.2 agent-tool mention. This lands before
  the code (Phase 0) because it changes what fragua *is*.
- **8b — everything else, *last* (after Phases 0–7).** Sweep:
  - **Docs:** `ARCHITECTURE.md` (event taxonomy — drop `subagent.*`; schema notes;
    §6.1 executor; the schema-version/migration section → new baseline),
    `handler-contract.md` (agent-tool API), `docs/intent-fold.md`,
    `AGENTS.md` (line 51 `@fragua/workspace` "agent-definition discovery";
    line 60 the `config.jsonc` deprecation sentence; line 64 the entire "Named
    sub-agent profiles" paragraph), `README.md` (workflow table; config; the
    `serve.json` cascade line is cli-topology's, leave it).
  - **Skills:** `.agents/skills/{workflows,backend,operate,postmortem}/SKILL.md`
    — remove agent-tool authoring guidance, sub-agent post-mortem sections, and
    the orchestrator-workers pattern from the workflows skill.
  - **Shipped workflows (functional, not just prose — confirmed in scope):**
    `work.yaml` uses the `agent` tool; rewrite its concurrent step serially (or
    drop it). Check `review.yaml`'s `dispatch` / orchestrator-workers step and
    `analyze.yaml`. A workflow that still references `agent` in `allowed-tools`
    will fail validation once the tool is gone.
  - **Verify:** run the `drift` workflow (it audits arch/spec/skill docs against
    the code) to catch stragglers — fragua auditing its own cleanup.

**Verify before cutting (the recon flagged these):** that nothing live reads a
`run_state` parent column (none should — dropped at v13); that `skills/`
discovery shares no helper with `agents/`; that `materialiseForChild` has no
non-subagent caller; that the web `parallel_index` layout code survives Phase 1.
