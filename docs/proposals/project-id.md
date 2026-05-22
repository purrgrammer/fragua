---
title: Project identity off cwd — a stable, committed `id` as the project key
summary: "Move project IDENTITY from the per-machine filesystem path (`run_state.cwd`) onto a stable `id` carried in the version-controlled `.fragua/config.yaml`. cwd survives only as a per-machine LOCATION binding (where worktrees/config/files physically live). Identity becomes portable: a run imported from another machine attributes to the same project even when its cwd differs or is absent."
status: proposed
maturity: sketch
last-reviewed: 2026-05-22
---

# Project identity off cwd

> **Sketch.** This is a surface map plus a target shape, not a scheduled
> workstream. The owner is hand-waving the new leg; the value here is the
> exhaustive identity-vs-location classification in §2, so the eventual
> implementer knows exactly which call sites move and which stay.

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

- The `workflows` table (`schema.sql:14-19` — `sha, name, dot_source,
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
| `run.ts` enqueue `cwd: resolve(cwd)` (`= process.cwd()`) | `run.ts:118,192` | **both** | Resolve `project_id` from `<cwd>/.fragua/config.yaml` at enqueue; send both `project_id` + cwd. |
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
- **Resolution at enqueue.** `fragua run` (or the daemon, when dispatching a
  schedule) reads `<cwd>/.fragua/config.yaml` → `id`. If present, that's the
  run's `project_id`. The `cwd` is also sent, untouched, as the location.
- **Fallback when `id` is absent** (config missing, or config without `id`):
  proposal — fall back to a synthesized id `path:<cwd>`. This keeps the
  one-project-per-path behavior we have today for un-`init`-ed dirs, is stable
  per-machine, and is visibly distinct from a real minted id, so a later
  `fragua init` can migrate the project's runs by rewriting `project_id` from
  `path:<cwd>` to the new `id`.
- **Projection.** `run_state` gains `project_id TEXT` (IDENTITY, indexed) while
  `cwd TEXT` stays nullable (LOCATION). Schedules gain `project_id`.
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
-- run_state: project_id is IDENTITY, indexed; cwd stays as the LOCATION binding
project_id TEXT,                    -- alongside the existing `cwd TEXT`
CREATE INDEX IF NOT EXISTS idx_run_state_project_id ON run_state(project_id);
-- schedules: same split
project_id TEXT,
CREATE INDEX IF NOT EXISTS idx_schedules_project_id ON schedules(project_id);
```

No row backfill (the store is recreated). The `path:<cwd>` form is purely a
**runtime** enqueue fallback (§3) for a config with no `id` — not a migration
artifact.

**`projects` table — warranted?** Probably not yet. `SELECT DISTINCT
project_id` plus a representative cwd hint covers the list. A table buys: a
durable display `name` decoupled from any run, and a canonical "last-seen cwd"
per id. But config already holds `name`, and the daemon re-reads config on
discovery — so a table is an optimization, not a correctness need. Recommend
deferring it; revisit if the projects list needs metadata that outlives all
runs (e.g. a project with zero runs that should still appear).

## 5. Open questions / risks

1. **The `id` seed — RESOLVED.** `init.ts:43` now mints a UUIDv7 `id` (via
   `@fragua/core`'s `uuidv7()`) and writes the directory name as the human
   `name` (`init.ts:43-44,72-73`), aligning with the `config.ts:88` schema
   comment that already documented it as UUIDv7. Rationale: a UUIDv7 is
   collision-free across a store that aggregates many repos (two unrelated
   repos both named `api` no longer fold into one project), time-sortable, and
   opaque — identity is the id, the human label rides the separate `name`
   field. The dir-name survives only as the default `name`.
2. **Configs with no `id`.** A pre-existing project that never ran `init`, or a
   config authored before the field — resolves to the `path:<cwd>` fallback
   (§3). A first `fragua init` then mints an `id`; a one-shot
   `fragua project adopt` (out of scope here) could rewrite historical
   `project_id` from `path:<cwd>` to the minted id.
3. **Portability precondition.** A run enqueued from a cwd whose
   `.fragua/config.yaml` has no committed `id` falls back to the runtime
   `path:<cwd>` form (§3) and is therefore **not portable** — on import to
   another machine ([`db-import.md`](db-import.md)) `path:<cwd>` can't attribute
   to a project that lives at a different path (or nowhere) locally. So
   `fragua run` (and the daemon, when dispatching a schedule) should **warn
   loudly** when enqueuing from a config with no committed `id` — *"this run
   won't be portable; run `fragua init`"*. For the CI-bundle future this is a
   hard setup precondition: CI must build from a repo that has a committed `id`,
   else the exported runs orphan on import.
4. **Collision / divergence.** If two checkouts on the same box have the same
   committed `id` (legitimate — same repo cloned twice) they correctly fold into
   one project. `cwd` remains a *secondary* key answering "where did this run
   physically happen" — both checkouts' runs share identity but keep distinct
   cwds.
5. **cwd is irreducible as LOCATION.** Worktrees, file-tree reads, git diff,
   bootstrap config, local-workflow resolution, and skills scans all need a real
   path. Identity moves; LOCATION cwd does not go away. A purely imported
   project (no local checkout) has a `project_id` but no usable cwd — file-backed
   views must tolerate that.
6. **Schedules.** A schedule carries identity (`project_id`) and a spawn cwd. If
   the box's checkout moves, the schedule's cwd goes stale while its identity is
   still correct — needs a re-bind path, or the schedule resolves cwd from the
   project's most-recent run at fire time.
7. **Trust boundary on enqueue.** The server can either trust a client-supplied
   `project_id` or re-resolve it from the enqueued cwd's config. For imported
   runs the id must be trusted (the cwd may not exist); for live `fragua run`
   either works. Pick "trust the client, default to resolve-from-cwd when
   absent" to keep both paths simple.
