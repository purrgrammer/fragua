---
title: Project identity off cwd — a stable, committed `id` as the project key
summary: "Move project IDENTITY from the per-machine filesystem path (`run_state.cwd`) onto a stable `id` carried in the version-controlled `.fragua/config.yaml`. cwd survives only as a per-machine LOCATION binding (where worktrees/config/files physically live). Identity becomes portable: a run imported from another machine attributes to the same project even when its cwd differs or is absent. Decided: `project_id` lands in the 0.1.0 baseline; resolution walks up to the nearest config; schedules resolve their spawn cwd at fire time."
status: accepted
maturity: decided
last-reviewed: 2026-05-22
---

# Project identity off cwd

> **Decided.** Every open question in §5 is resolved; this is the settled
> shape for the pre-0.1.0 cleanup, ready to implement. The value of the doc
> is two-fold: the exhaustive identity-vs-location classification in §2 (so
> the implementer knows exactly which call sites move and which stay), and
> the decision record in §5 (so each frozen choice carries its rationale).

## 1. Goal / why

Today the only project identifier is `run_state.cwd` — the absolute path a run
was enqueued from. The UI derives the project list with `SELECT DISTINCT cwd`;
there is no `projects` table. This conflates two distinct concerns:

- **Identity** — *which project is this?* A stable answer that should travel
  with the repo across clones, machines, and people.
- **Location** — *where on THIS box do its files / worktrees / config live?*
  A per-machine binding that is meaningfully different on every checkout.

cwd answers both, badly. Two checkouts of the same repo at different paths read
as two projects. A run imported from a teammate's machine (see
[`db-import.md`](db-import.md)) carries a cwd that may not exist locally, so it
either mis-attributes or orphans.

The fix: a stable `id` lives in `<repo>/.fragua/config.yaml`, which is
committed to git (`init.ts` already emits `!.fragua/config.yaml` as a keep
pattern) and therefore shared by every clone. Identity moves to that `id`. cwd
demotes to a per-machine LOCATION binding — still needed (worktrees need a real
path), never identity.

## 2. Current reliance on cwd — the surface map

Each site is classified **IDENTITY** (must key on `project_id`) or **LOCATION**
(legitimately stays cwd). file:line from grep at `last-reviewed`.

> **Exhaustiveness contract.** The inventory below is meant to be *provably
> complete*: every cwd-bearing or project-identifying site is either a row in
> the per-package tables, or covered by §2bis (workflows) / §2ter (run-scoped
> tables) — both of which carry NO cwd and inherit identity transitively, so
> they have no rows to migrate.

### §2bis Workflows — already project-agnostic

The owner asked to *"clean up the schema — workflows, runs, etc — to point to
project by id."* The honest answer for `workflows`: **nothing to change at the
table level, and adding a `project_id` column there would be wrong.**

- The `workflows` table (`schema.sql:14-19` — `sha, name, source,
  created_at`) is **content-addressed and global**: the primary key is the
  source `sha`. It has no cwd and needs **no** `project_id` — identical sources
  enqueued from different projects share one `sha` *by design*. Confirmed: a
  grep over `packages/store/src` finds no cwd/project key on the table or in
  `workflow-queries.ts` (the only SQL touching it).
- A run's link to its workflow is **`run_state.workflow_sha`** (`schema.sql:36`,
  `NOT NULL REFERENCES workflows(sha)`) — already cwd-free and **portable**: the
  source travels in the `workflows` table (and would ride an import bundle).
  That is the identity link.
- `run_state.workflow_scope` (`'global'|'local'|'path'|'ephemeral'`,
  `schema.sql:56`) + `run_state.workflow_path` (`schema.sql:57-59`) are
  **LOCATION** metadata — where the `.yaml` was found on disk for a
  `local`/`path` workflow. Advisory like cwd; possibly absent or stale on
  import. Written at enqueue by `run.ts:191-196` (`workflowScope`,
  `workflowPath`) and resolved by the multi-source reader
  (`packages/server/src/adapters/multi-source-workflow-reader.ts:40-90`), which
  reads `.yaml` off disk and is therefore irreducibly cwd-keyed.
- The per-project workflow **LIST** (WorkflowSelector / `GET /workflows?cwd=`)
  is a filesystem scan under `<cwd>/.fragua/workflows/`
  (`multi-source-workflow-reader.ts:40-49`, `projectCwds()`) → stays
  **LOCATION** (cwd), attributed to a project only via `project_id → cwd`
  resolution.

**Net:** workflows point to a project **only transitively** — through the run's
`project_id`. The `workflows` table itself stays global and content-addressed.
No `project_id` column is added to it.

### §2ter Run-scoped tables — inherit identity through `run_state`

The append-mostly per-run tables — `events` (`schema.sql:107-115`), `messages`
(`schema.sql:135-150`), `artifacts` (`schema.sql:163-172`) — are keyed by
`run_id` (`FK → run_state(run_id) ON DELETE CASCADE`) and carry **NO** cwd.
`blobs` (`schema.sql:157-161`) is content-addressed by `sha256` with no run or
cwd reference at all. They inherit project identity **transitively** through
`run_state.project_id`; **no direct `project_id` column is needed** on any of
them. Confirmed: a grep finds no cwd column on `events` / `messages` / `blobs` /
`artifacts`. Stating this makes the inventory exhaustive — every cwd site is
either a row in §2's per-package tables or covered here.

### `@fragua/store`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| `run_state.cwd` column + comment "Only project identifier" | `schema.sql:49-52` | **both** | Split: add `project_id` (IDENTITY, indexed); keep `cwd` (LOCATION, nullable). |
| `idx_run_state_cwd` | `schema.sql:99` | LOCATION | Keep for location lookups; add `idx_run_state_project_id`. |
| `schedules.cwd` + `idx_schedules_cwd` | `schema.sql:228,244` | **both** | A schedule fires runs *somewhere*; identity is `project_id`, the spawn path is cwd. Add `schedules.project_id`; cwd stays as where to enqueue. |
| `listCwds()` / `CwdSummaryRow` (the projects list) | `run-state-queries.ts:267-285`, `types.ts:844-848` | IDENTITY | Becomes `listProjects()` → `GROUP BY project_id`, with a representative cwd as a location hint. |
| Runs filtered by cwd (`ListRunsOpts.cwd`, `cwd = ?`) | `run-state-queries.ts:113-118,167-169,194-196` | IDENTITY | Filter becomes `project_id = ?`. (A separate `cwd = ?` filter could stay for "runs that physically happened here".) |
| Run-detail select carrying `cwd` | `run-state-queries.ts:43,77,140,211,241` | LOCATION | Keep cwd on the row (where it ran); add `project_id`. |
| GC-by-cwd (`selectGcEligibleSnapshotRuns`, `getGcEligibleSnapshotRuns`) | `run-state-queries.ts:355-368`, `types.ts:768-773` | LOCATION | Snapshot refs live under the worktree path → genuinely cwd-scoped. Stays cwd. |
| `insertRunState` cwd arg | `run-state-queries.ts:380,396,413` | **both** | Writes both `project_id` (resolved at enqueue) and `cwd` (the spawn path). |
| Analytics window predicate (`windowPredicate(..., "cwd")`, `WindowOpts.cwd`) | `analytics-queries.ts:42-69,139` | IDENTITY | Roll-ups are per-project → predicate keys on `project_id`. |
| Schedule queries (`selectSchedulesByCwd`, insert) | `schedule-queries.ts:14,28,39,51,62,74-83,87,99` | IDENTITY | Lookups become by `project_id`; cwd retained as spawn location. |
| `getWorkflowDirectory({ cwd })` | `types.ts:884-888` | LOCATION | Local workflows live under `<cwd>/.fragua/workflows/` — a filesystem fact. Stays cwd. |

### `@fragua/server`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| `GET /projects` (`store.listCwds()`, `name: basename(r.cwd)`) | `store/routes.ts:824-833` | IDENTITY | Returns `{ project_id, name, cwdHint }`; `name` from config `name` not `basename(cwd)`. |
| `GET /runs?cwd=` filter | `runs-routes.ts:26-40` | IDENTITY | Accept `?project_id=`; `?cwd=` may remain as a location filter. |
| Enqueue body `cwd` (identity comment) | `store/routes.ts:247-250,297-311,403` | **both** | Server resolves `project_id` from the enqueued cwd's config (or trusts a client-supplied id); stores both. |
| Analytics routes `?cwd=` | `store/analytics-routes.ts:88,101,135-136,213-234` | IDENTITY | `?project_id=`. |
| Skills discovery `?project_cwd=` filter + enumeration `cwd ∪ listCwds()` | `store/skills-routes.ts:62-73,161-162` | LOCATION | Skills are read off the *filesystem* under each cwd → enumeration stays cwd-keyed. The filter param could accept a `project_id` and resolve to its local cwd. |
| Workflow reader `?cwd=` disambiguation, `projectCwds()` | `adapters/multi-source-workflow-reader.ts:40-90`, `index.ts:235-248` | LOCATION | Reads `.yaml` off disk → cwd. |
| Project-tree / blob reader (`list/readBlob(cwd)`) | `adapters/project-tree-reader.ts:51-94` | LOCATION | Serves files under cwd → cwd, irreducibly. |
| Snapshot reader git ops (`lsTree/showFile/diff/refExists(cwd)`) | `adapters/run-snapshot-reader.ts:28-107` | LOCATION | Runs git in the worktree's repo → cwd. |
| accept/discard ports (`(cwd, runId, …)`) | `ports.ts:16-17`, `store/routes.ts:677-716` | LOCATION | Merges happen in the on-disk repo → cwd. |
| `cwd` in run/project schemas | `schemas.ts:65-68,138-144,184-190` | **both** | Add `project_id`; keep cwd as location field. |

### `@fragua/web`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| `projectId.ts` — `encode/decodeProjectId(cwd)` = base64url(cwd) | `lib/projectId.ts:1-32` | IDENTITY | Deleted as identity. Route param becomes the literal `project_id` (already URL-safe as a UUIDv7). |
| `ProjectDetail` route `:cwdEnc` → `decodeProjectId`; tree/blob/config queries pass `cwdEnc` | `routes/ProjectDetail.tsx:1-8,30,38-39,46-47,59-78,148`, `lib/router.tsx:35` | IDENTITY | Route `projects/:projectId`; runs filter + tree/blob/config queries pass `project_id`, server resolves cwd. Title `name` from project `name` not `basename(cwd)`. |
| `ProjectLink` (`encodeProjectId(cwd)`, `basename(cwd)`) | `components/ProjectLink.tsx:2,21-22` | IDENTITY | Links to `/projects/:projectId`; label from project `name`. Callers: `Projects.tsx:71`, `Workflows.tsx:91`, `RunDetail.tsx:306`. |
| `Projects` list route (one row per `run_state.cwd`, `row.cwd` as key + `ProjectLink cwd=`) | `routes/Projects.tsx:1-9,69-82` | IDENTITY | Rows key on `project_id`; `name` from config, `cwd` shown only as a location hint column. |
| `ProjectSelector` (cwd as select value; `cwdToProjectSelectValue` / `projectSelectValueToCwd` / `ALL_PROJECTS_VALUE`; `p.cwd` item value) | `components/analytics/ProjectSelector.tsx:14,19-25,38,47` | IDENTITY | Select values become `project_id`; helpers map `project_id ↔ ALL`. |
| Query factories keyed on cwd — `queries.runs.list(filter.cwd)`, `queries.projects.tree/blob(id=cwdEnc)`, `queries.analytics.workflows(cwd)`, `queries.skills.list(projectCwd)` | `lib/queries.ts:23,130-135,181-199,247-252` | mixed | Run/project/analytics keys split on `project_id`; skills key stays `projectCwd` (LOCATION). `projects.tree/blob` already take an opaque `id` arg — becomes `project_id`. |
| API client cwd plumbing — `getProjectTree/Blob(projectId)` (already opaque), `listRuns({cwd})`, enqueue `{cwd}`, `getWorkflows(?cwd=)`, skills `project_cwd=`, run/project response `cwd` fields | `lib/api.ts:193,240,487,505-517,636,642,791,804,911,1038` | mixed | IDENTITY plumbing sends `project_id`; LOCATION fields (skills, workflow source) keep cwd; response rows gain `project_id` alongside cwd. |
| `RunComposer` scope-of-cwd + enqueue `cwd` | `components/RunComposer.tsx:9-11,33,47-69,104,131` | **both** | Scope (local/global) still compares the workflow's owning cwd to the project's local cwd; enqueue carries cwd (location) and the server attaches identity. |
| `RunDetail` project breadcrumb (`ProjectLink cwd={detail.cwd}`, `projectBasename`) | `routes/RunDetail.tsx:24,303-308` | IDENTITY | Link by `detail.project_id`; label from project `name`. (RunRow itself renders no project link — `components/RunRow.tsx`.) |
| Analytics `cwd` filter threading (`effectiveCwd`, `summaryReq.cwd`, `slice.cwd`, `DrillDownDrawer` `requestArgs.cwd`) | `routes/Analytics.tsx:49-69,123,134,152`, `types/analytics.ts:96,133,144`, `components/analytics/DrillDownDrawer.tsx:106` | IDENTITY | `project_id`. (Effective filter still *derived* from the local workflow's owning cwd — a LOCATION→IDENTITY resolution.) |
| Skills list `project_cwd` filter / column | `components/skills/skills-list.tsx:20-106`, `routes/Skills.tsx:7-29` | LOCATION | Skills are filesystem-anchored → cwd column stays (could show project name resolved from id). |
| `WorkflowLink` / `WorkflowSelector` / `WorkflowDetail` `?cwd=` for local-workflow scoping | `components/WorkflowLink.tsx:6-25`, `components/analytics/WorkflowSelector.tsx:44-88`, `routes/WorkflowDetail.tsx:45-48,154-155`, `routes/Workflows.tsx:73-91` | LOCATION | Local workflow identity is genuinely `(scope, name, cwd-of-the-yaml)` → cwd. |

**Web cutover checklist.** (1) Router: rename the param from `:cwdEnc` to
`:projectId` (`lib/router.tsx:35`, `ProjectDetail.tsx:38`). (2) Delete
`lib/projectId.ts` *as an identity codec* — the route param is now the literal
`project_id`, no base64url(cwd) round-trip. (3) Query factories: re-key the
IDENTITY caches on `project_id` (`queries.runs.list`, `queries.projects.*`,
`queries.analytics.*`); leave the skills/workflow-source caches on cwd
(LOCATION). (4) Link + select *values*: `ProjectLink`, the `Projects` list, and
`ProjectSelector` emit `project_id`; their *labels* come from the project
`name`, not `basename(cwd)`. (5) Server resolves `project_id → cwd` for the
file/tree/blob/config views (`getProjectTree/Blob` and the config-yaml read in
`ProjectDetail.tsx`), degrading to "not checked out here" for an imported-only
project with no local cwd (§3, §5 #5).

### `@fragua/daemon`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| Worktree provisioner — worktrees under `<run.cwd>/.fragua/worktrees/<run_id>/`; `isGitRepo(cwd)`; `LocalEnvironment{cwd}` | `worktree-provisioner.ts:28-251`, `executor.ts:457-458` | LOCATION | Irreducible: a worktree needs a real path. Reads `state.cwd`. |
| Per-run bootstrap from `<run.cwd>/.fragua/config.yaml` | `worktree-provisioner.ts:39-151`, `daemon.ts:373-409` | LOCATION | Config-on-disk is per-machine → cwd. (Note: the *same* config file also holds `id` — see §3.) |
| Skills auto-scan over `cwd ∪ listCwds()` | `daemon.ts:197-203,332` | LOCATION | Filesystem scan → cwd. |
| Schedule dispatcher resolves workflow under `<cwd>/.fragua/workflows/` and enqueues with `row.cwd` | `schedule-dispatcher.ts:110,176,205-227` | **both** | Resolution is cwd (location); the fired run's identity is the schedule's `project_id`. |

### `@fragua/cli`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| `run.ts` enqueue `cwd: resolve(cwd)` (`= process.cwd()`) | `run.ts:118,192` | **both** | Walk up from `process.cwd()` to the nearest config (git-root ceiling, §3); **refuse if no `id`** (§5 #3); send `project_id` + `project_name` + `cwd` = the *resolved project root* (§5 #11), not the invocation dir. |
| `init.ts` mints `id` | `init.ts:43-44,66-77` | IDENTITY (source of truth) | Mints a UUIDv7 `id` + dir-name `name` (§5 #1, resolved). |
| Config cascade `<cwd>/.fragua/config.yaml` | `config.ts:5,245-297` | LOCATION (file) / IDENTITY (`id` field) | The file is per-machine; the `id` field inside it is the identity source. `id` is in `FraguaConfigSchema` (`config.ts:88-92`); `init.ts:43` mints a UUIDv7 into it, matching the schema comment (§5 #1). |
| `validate.ts`, `daemon.ts` store path, `schedule.ts` — `process.cwd()` for path resolution | `validate.ts:12`, `daemon.ts:56-127`, `schedule.ts:52` | LOCATION | Filesystem resolution → cwd. |

### `@fragua/core` / `@fragua/types`

| Site | file:line | Class | Becomes |
|---|---|---|---|
| Handler `ctx.env.cwd()`, tool spawn cwd | `core/.../handler/handlers/tool.ts:95-196`, `types/execution.ts:17-53` | LOCATION | Execution happens at a real path → cwd. Untouched. |
| `routing.input` (free-form description / auto-title seed) | `core/types/summariser.ts:25`, `types/events.ts:246` | neither | Not an identity carrier. Untouched. |
| Typed run inputs (`inputs:`) | `run.ts:97-99,200` | neither | Workflow params, not identity. Untouched. |
| `ToolResultFact.cwd` (observability) | `types/index.ts:70-85` | LOCATION | Where the tool ran → cwd. Untouched. |
| `skills.ts project_cwd` | `types/skills.ts:46-56,94-97` | LOCATION | Filesystem anchor. Untouched. |

## 3. Target model

- **Source of truth.** `<repo>/.fragua/config.yaml` `id`. Committed → shared by
  every clone.
- **Resolution at enqueue — walk up to the nearest config, bounded by the git
  root.** `fragua run` (or the daemon, when dispatching a schedule) walks up from
  `cwd` to the **nearest** `.fragua/config.yaml`, **stopping at (and including)
  the git repo root** (`git rev-parse --show-toplevel`). A root config gives the
  whole repo one identity even when you run from `repo/packages/api`; a
  subdirectory opts into being its own project by dropping its own
  `.fragua/config.yaml` with its own `id` (the walk stops at the first one found,
  deepest-first). The git-root ceiling is load-bearing, not just ergonomic: it
  stops the climb before it escapes the repo into a parent directory's config —
  in particular `~/.fragua/config.yaml`, which is the **global** config cascade
  (defaults / blocklist / concurrency), *not* a project config, and must never be
  read as a project's identity. **Outside a git repo there is no safe ceiling, so
  resolution is exact-cwd only** (no walk-up). If an `id` is found, that's the
  run's `project_id`; the `cwd` is sent untouched as the location. (The config
  loader reads the exact cwd today — see §5 #8 for the resolution-rule change.)
- **Init writes at the git root by default.** `fragua init` mints the config at
  the git toplevel so a fresh repo gets one repo-wide identity that the walk-up
  resolves from any subdirectory; `fragua init` run inside a subdirectory that
  wants to be its own project writes there instead (an explicit opt-in).
- **The resolved project root is the run's `cwd` — not the invocation dir.**
  Walk-up lets you invoke from `repo/packages/api` while identity resolves to the
  root config, so `process.cwd()` and the project root diverge. The run's stored
  `cwd` is the **dir holding the matched config** (the project root), not the
  invocation dir. This is load-bearing: it keeps all of `.fragua/` — config,
  workflows, runtime (`worktrees/`, `blobs/`), and the gitignore coverage `init`
  wrote — in **one** place per project, and keeps worktree provisioning
  (`<cwd>/.fragua/worktrees/<run_id>`) anchored there rather than scattering an
  un-gitignored second `.fragua/` into a subdir. The invocation subdir only seeds
  the walk and is discarded after resolution. (A subdir that wants its own runtime
  root becomes its own project by holding its own config — the walk stops there.)
- **`init` is required — no `id`, no run.** When resolution finds no `id` (no
  config in the walk-up, or a config without one), `fragua run` **refuses** with
  *"run `fragua init` first"* rather than synthesizing a fallback. Every run
  therefore carries a real minted identity by construction — there is no
  second-class `path:<cwd>` run, and no later adopt-migration to write. The same
  gate applies to web-initiated enqueue (the server resolves or rejects) and to
  schedule creation. See §5 #3.
- **Commit gate (gate 2).** fragua can enforce that the config *exists* but
  cannot commit it for you, and portability requires the `id` to be committed to
  git (so every clone shares it). So `fragua run` additionally **warns** when the
  resolved config is present but uncommitted — *"commit `.fragua/config.yaml` to
  make this run portable"* — without blocking. See §5 #4.
- **Projection.** `run_state` gains `project_id TEXT NOT NULL` (IDENTITY,
  indexed) — `NOT NULL` is now honest because the require-init gate guarantees a
  value on every enqueue path (`fragua run`, schedule fire, import). `cwd TEXT`
  stays nullable (LOCATION). Schedules gain `project_id TEXT NOT NULL`.
- **Projects list** keys on `project_id` (`SELECT DISTINCT project_id` or a
  `projects` table — §4). Display `name` from config `name`, not
  `basename(cwd)`.
- **Web** routes on `/projects/:projectId` — no base64url(cwd). File/tree/blob
  reads resolve `project_id → a local cwd` server-side (the most-recent cwd seen
  for that id); if no local cwd exists (imported-only project), the file views
  degrade gracefully (empty/"not checked out here").
- **Import** ([`db-import.md`](db-import.md)) preserves `project_id` verbatim
  and treats the incoming `cwd` as advisory — possibly a path that does not
  exist locally. Same id → same project across machines, by construction.

## 4. Schema sketch (edit the baseline in place — no version bump)

Pre-0.1.0 we do **not** bump `schema_version` or register a step-delta. The
baseline `schema.sql` (`schema.sql:1-7`, single canonical shape pinned at
version 1) is edited **in place** and the local dev store is recreated — the
same clean-break model the migration collapse used. No walk-forward chain, no
backfill of existing rows: pre-release run history is disposable (ground rule
#11). `schema_version` stays `1` until 0.1.0 ships; the first real migration
arrives only post-0.1.0.

Add to the baseline shape directly (inline columns + indexes, not `ALTER`):

```sql
-- run_state: project_id is IDENTITY (indexed); project_name is a denormalized
-- display label; cwd stays as the LOCATION binding (the resolved project root)
project_id   TEXT NOT NULL,         -- alongside the existing `cwd TEXT`
project_name TEXT NOT NULL,         -- display label, value at enqueue
CREATE INDEX IF NOT EXISTS idx_run_state_project_id ON run_state(project_id);
-- schedules: same split
project_id TEXT NOT NULL,
CREATE INDEX IF NOT EXISTS idx_schedules_project_id ON schedules(project_id);
```

`project_id` is `NOT NULL`: the require-init gate (§3, §5 #3) guarantees a minted
`id` on every enqueue path, so the invariant "every run has a project identity"
holds at the schema level — no `path:<cwd>` fallback value, no nullable column to
defend against. `project_name` is `NOT NULL` for the same reason (§5 #11) and is
resolved at enqueue from the config `name`, falling back to the project-root
basename. No row backfill (the store is recreated).

**`projects` table — deferred; `project_name` denormalized instead.** A
`projects` table is **not** added for 0.1.0. The naming gap it would solve: the
list would otherwise read `name` from the project's `.fragua/config.yaml`, but an
**imported-only project has no local checkout** — no config to read — so the list
would show a bare UUID. Fix without a table: the `project_name` baseline column
(above) is written at enqueue and **carried in the bundle** (§db-import), so the
label rides every run and `SELECT DISTINCT project_id, project_name` labels
imported-only projects too. A `projects` table stays a later optimization (a
durable name for a zero-run project, a canonical last-seen cwd); defer it. The
denormalized `project_name` is the *value at enqueue time* — a later config
rename won't retro-update old runs, which is acceptable (it's a label, and the
per-run value is honest history).

## 5. Decisions

Every item below is **decided** for the pre-0.1.0 freeze. Each carries the
rationale so the frozen choice is auditable later.

1. **The `id` seed — UUIDv7 minted by `init`.** `init.ts:43` mints a UUIDv7 `id`
   (via `@fragua/core`'s `uuidv7()`) and writes the directory name as the human
   `name` (`init.ts:43-44,72-73`), aligning with the `config.ts:88` schema
   comment. Rationale: a UUIDv7 is collision-free across a store that aggregates
   many repos (two unrelated repos both named `api` no longer fold into one
   project), time-sortable, and opaque — identity is the id, the human label
   rides the separate `name` field. The dir-name survives only as the default
   `name`.
2. **`project_id` lands in the 0.1.0 baseline — DECIDED.** The `run_state` and
   `schedules` `project_id` columns + their indexes go into the baseline
   `schema.sql` **now** (§4), edited in place under the clean-break policy — no
   `schema_version` bump, no migration step, the dev store is recreated. The
   columns are additive and inert until the resolver writes them. This is the
   whole reason project-id is a pre-0.1.0 item: doing it now means **zero
   identity-migration debt at launch**, vs. making the very first post-release
   migration be identity plumbing. Resolves the lone freeze-window column
   question that [`db-import.md`](db-import.md) §7 #2 flagged *for `project_id`*
   (the `workflows.ir` / `ir_version` half of that question stays open — see
   [`workflow-ir.md`](workflow-ir.md)).
3. **`init` is required before a run — hard-fail, no fallback.** When resolution
   (§3 walk-up) finds no `id`, `fragua run` **refuses** with *"run `fragua init`
   first"*; the server rejects an id-less enqueue likewise; schedule creation
   requires a resolved id. There is **no** `path:<cwd>` synthesized fallback and
   **no** `fragua project adopt` migration — both are deleted. Rationale: every
   run carries a real minted identity by construction, so `project_id` is
   `NOT NULL` (§4) and portability is the default rather than a second-class
   upgrade. The cost — `fragua run` in a never-init'd dir errors instead of just
   working — is a one-time, one-command friction (`fragua init`), acceptable
   pre-0.1.0 and worth the elimination of the entire fallback code path. (fragua
   can enforce that the config *exists*; committing it is gate 2, #4.)
4. **Commit gate — warn, don't block (gate 2).** The require-init gate (#3)
   guarantees the config *exists*; it cannot guarantee the `id` is **committed**,
   and portability needs it committed so every clone shares it. So `fragua run`
   (and the daemon when dispatching a schedule) **warns** when the resolved config
   is present but uncommitted — *"commit `.fragua/config.yaml` to make this run
   portable"* — without blocking, since a local-only run is still valid. For the
   CI-bundle future this is the real setup precondition: CI must build from a repo
   whose `.fragua/config.yaml` is committed, else its exported runs carry an `id`
   no other clone recognizes.
5. **Same `id` on one box → one project, by design.** Two checkouts on the same
   box with the same committed `id` (a repo cloned twice) correctly fold into one
   project. `cwd` stays a *secondary* key answering "where did this run
   physically happen" — both checkouts' runs share identity but keep distinct
   cwds.
6. **cwd is irreducible as LOCATION.** Worktrees, file-tree reads, git diff,
   bootstrap config, local-workflow resolution, and skills scans all need a real
   path. Identity moves; LOCATION cwd does not go away. A purely imported project
   (no local checkout) has a `project_id` but no usable cwd — file-backed views
   must tolerate that and degrade to "not checked out here".
7. **Schedule spawn cwd — resolve at fire time.** A schedule carries identity
   (`project_id`) plus a spawn `cwd` *hint*. At fire time the dispatcher resolves
   the spawn cwd from the **project's most-recent run cwd**, falling back to the
   schedule's stored cwd. This is self-healing: when a checkout moves, the next
   fire lands in the current location with no operator action. The stored cwd is
   advisory, never authoritative — no `fragua schedule rebind` command is needed.
8. **Trust boundary on enqueue — trust the client, resolve-from-cwd when absent.**
   The server trusts a client-supplied `project_id`, and re-resolves it from the
   enqueued cwd's config (§3 walk-up) only when none is supplied. Imported runs
   *must* be trusted (their cwd may not exist locally); live `fragua run` works
   either way. This keeps both paths simple.
9. **Monorepo / id resolution — walk up to the nearest config, bounded by the git
   root.** Resolution walks up from `cwd` to the nearest `.fragua/config.yaml`,
   stopping at (and including) the git toplevel (§3). Rationale: a root config
   gives the whole repo one identity (running from `repo/packages/api` resolves to
   it), while a subdirectory opts into its own identity by placing its own config
   (walk stops deepest-first). The git-root ceiling is **load-bearing**: it stops
   the climb before it reads `~/.fragua/config.yaml` — the *global* config
   cascade, not a project config — as identity. Outside a git repo there is no
   safe ceiling, so resolution is **exact-cwd only**. The config loader reads the
   exact cwd today; this is the one resolution-rule change the implementer adds.
10. **Fork divergence — inherit by default, re-mint by explicit confirmation.** A
    fork inherits the parent's committed `id` (it's in the cloned config), so the
    fork's runs attribute to the parent project — correct for "a clone of the same
    project", wrong for "a hard fork that is now its own thing". `id` is immutable
    *by convention* (the config comment says so; nothing enforces it — editing it
    forks the project's history). The escape is explicit: `fragua init` detects an
    existing `id` and re-mints **only on confirmed fork** (or a future `fragua
    project reset-id`). **Never auto-re-mint** — that would silently fork every
    clone.
11. **`cwd` is the resolved project root, not the invocation dir.** A direct
    consequence of walk-up (#9): the run's stored `cwd` is the dir holding the
    matched config, so all of `.fragua/` (config, workflows, `worktrees/`,
    `blobs/`, gitignore coverage) lives in one place per project and worktree
    provisioning stays anchored there (§3). Storing the literal `process.cwd()`
    instead would scatter an un-gitignored second `.fragua/` into whatever subdir
    you happened to invoke from. The invocation dir only seeds the walk.
12. **`project_name` is a denormalized baseline column, `NOT NULL`.** Added to the
    0.1.0 baseline in the same window as `project_id` (§4), written at enqueue
    from the config `name` (fallback: project-root basename) and carried in the
    bundle. This is what lets an **imported-only project show a real label, not a
    bare UUID**, without a `projects` table. It's a display value-at-enqueue, not
    identity — a later rename doesn't retro-update old runs (honest history).

**Consequences to carry into implementation** (not contradictions — fallout of
the above):

- **First-run UX & docs.** Require-init (#3) means `fragua run` in a never-init'd
  dir errors — including running a *global* workflow from an un-init'd cwd. SPEC,
  the quickstart, and the harness onboarding must state "init first."
- **Every `enqueueRun` call site gains `project_id` + `project_name`.** Both are
  `NOT NULL`; the store insert, the schedule-fire path, the server enqueue, and
  **all test fixtures** must supply them. Mechanical but broad — grep
  `enqueueRun(` across `packages/`.
- **Enqueue now shells `git rev-parse --show-toplevel`** for the walk ceiling
  (#9). Cheap (enqueue is not hot), degrades to exact-cwd when git is absent.
- **Non-git projects** resolve exact-cwd, init warns-and-proceeds, and the commit
  gate (#4) *always* warns (nothing to commit to) — acceptable, just noisy.
- **Schedule first fire before any run** has no most-recent-run cwd to resolve
  from (#7), so it uses the stored cwd — the intended fallback, no gap.
