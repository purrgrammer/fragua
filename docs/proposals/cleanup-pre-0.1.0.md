---
title: Pre-0.1.0 cleanup — remove the agent tool, collapse migrations, widen run_id
summary: "A cruft-removal phase BEFORE the CLI-topology line of work. Nuke the `agent` tool and all sub-agent machinery (spawning, discovery, catalogue, agent pages, parent-run linkage). Collapse the v1→v17 migration chain into a single fresh baseline schema (we are pre-0.1.0; no backwards-compat per ground rule #11), which drops the parent-run columns cleanly and resets the schema-version baseline. Fold the run_id widening in as a free bonus while the schema is being reset."
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
- **Run linkage:** the additive linkage columns on `run_state`
  (`parent_run_id`, `parent_node_id`, `parallel_index`, `parent_iteration`) and
  `idx_run_state_parent`, plus the cancel-propagation / cost-rollup paths that
  walk them (`packages/store/src/{run-state-queries,event-queries}.ts`,
  `packages/types/src/{agents,events}.ts`).
- **Skills/profiles:** the `.agents/agents/` discovery and the
  named-sub-agent-profile catalogue.

Grounding the surface: `rg -l 'parent_run_id|subagent|discoverAgents|agent_catalogue'
packages/*/src` spans ~25 files across every package — this is a wide but
mechanical removal.

## 2. Collapse migrations into a fresh baseline

We are pre-0.1.0; ground rule #11 forbids prior-state references and there is no
deployed store to preserve. So:

- Replace the `v1 → v17` `STEP_MIGRATIONS` chain + per-version `run_state`
  rebuilds in `packages/store/src/migrations.ts` with a **single baseline
  `schema.sql`** reflecting current state minus the §1 columns.
- Reset `CURRENT_SCHEMA_VERSION` to `1` (`packages/store/src/pragmas.ts`).
  `migrate()` becomes "create at baseline"; there is no walk-forward chain to
  maintain until the first post-0.1.0 migration.
- This drops the dead linkage columns (§1) for free — no migration to write.

## 3. Widen `run_id` (free bonus)

Since the schema is being reset and `newRunId` is moving to the intent plane
anyway, swap the ULID-*like* generator (base-32 ms + 8 bytes `% 32`, ~40 bits)
for a collision-safe id (true ULID / UUIDv7 — no modulo-32 entropy loss) **now**,
so cross-machine import is collision-safe from the first 0.1.0 store. Closes
[`intent-plane.md`](intent-plane.md) decision #2 and [`db-import.md`](db-import.md)
precondition §3.1.

## 4. What this removes from downstream proposals

- **[`db-import.md`](db-import.md):** the **run-tree** rough edge disappears —
  no `parent_run_id` FK means a run is a single self-contained `run_state` row
  again; import is genuinely a verbatim per-run copy. (Blob references remain a
  real edge — §5.)
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
