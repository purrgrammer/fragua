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
| `projectId.ts` — `encode/decodeProjectId(cwd)` = base64url(cwd) | `lib/projectId.ts:1-32` | IDENTITY | Deleted as identity. Route param becomes the literal `project_id` (already URL-safe if minted as UUIDv7). |
| `ProjectDetail` route `:cwdEnc` → `decodeProjectId` | `routes/ProjectDetail.tsx:1-78`, `lib/router.tsx:35` | IDENTITY | Route `projects/:projectId`; tree/blob/config queries resolve cwd server-side from `project_id`. |
| `ProjectLink` (`encodeProjectId(cwd)`, `basename(cwd)`) | `components/ProjectLink.tsx:2-22` | IDENTITY | Links to `/projects/:projectId`; label from project `name`. |
| `Projects` list / `ProjectSelector` (cwd as select value) | `components/analytics/ProjectSelector.tsx:19-47` | IDENTITY | Values become `project_id`. |
| `RunComposer` scope-of-cwd + enqueue `cwd` | `components/RunComposer.tsx:9-11,47-69,104,131` | **both** | Scope (local/global) still compares the workflow's owning cwd to the project's local cwd; enqueue carries cwd (location) and the server attaches identity. |
| Analytics `cwd` filter threading | `types/analytics.ts:96,133,144` | IDENTITY | `project_id`. |
| Skills list `project_cwd` filter / column | `components/skills/skills-list.tsx:20-106` | LOCATION | Skills are filesystem-anchored → cwd column stays (could show project name resolved from id). |
| `WorkflowLink` / `WorkflowSelector` `?cwd=` for local-workflow scoping | `components/WorkflowLink.tsx:6-25`, `components/analytics/WorkflowSelector.tsx:44-88` | LOCATION | Local workflow identity is genuinely `(scope, name, cwd-of-the-yaml)` → cwd. |

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
| `init.ts` seeds `id` | `init.ts:38-40,62-69` | IDENTITY (source of truth) | The seed strategy is the open question (§5). |
| Config cascade `<cwd>/.fragua/config.yaml` | `config.ts:5,245-297` | LOCATION (file) / IDENTITY (`id` field) | The file is per-machine; the `id` field inside it is the identity source. `id` is already in `FraguaConfigSchema` (`config.ts:88-92`) — but the schema comment says "UUIDv7", while `init.ts` writes the dir-name. Reconcile (§5). |
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

1. **The `id` seed — the big one.** `init.ts:40` seeds `id: <dir-name>`, but
   `config.ts:88` already documents it as UUIDv7. These disagree today.
   - *dir-name:* readable, but two unrelated repos both named `api` collide
     into one project across machines. Bad for a shared/central store.
   - *UUIDv7:* collision-free and time-sortable, but opaque (the `name` field
     carries the human label). Matches the existing schema comment.
   - *git-remote-derived* (e.g. hash of `origin` URL): stable across clones of
     the *same* repo automatically, but breaks for repos with no remote or
     after a remote rename, and forks would share an id.
   - **Recommendation:** mint a UUIDv7 at `init` (reconciling `init.ts` with the
     existing schema comment); keep `name` for humans. Collisions become
     impossible-by-construction; the dir-name lives on only as the default
     `name`.
2. **Configs with no `id`.** A pre-existing project that never ran `init`, or a
   config authored before the field — resolves to the `path:<cwd>` fallback
   (§3). A first `fragua init` then mints an `id`; a one-shot
   `fragua project adopt` (out of scope here) could rewrite historical
   `project_id` from `path:<cwd>` to the minted id.
3. **Collision / divergence.** If two checkouts on the same box have the same
   committed `id` (legitimate — same repo cloned twice) they correctly fold into
   one project. `cwd` remains a *secondary* key answering "where did this run
   physically happen" — both checkouts' runs share identity but keep distinct
   cwds.
4. **cwd is irreducible as LOCATION.** Worktrees, file-tree reads, git diff,
   bootstrap config, local-workflow resolution, and skills scans all need a real
   path. Identity moves; LOCATION cwd does not go away. A purely imported
   project (no local checkout) has a `project_id` but no usable cwd — file-backed
   views must tolerate that.
5. **Schedules.** A schedule carries identity (`project_id`) and a spawn cwd. If
   the box's checkout moves, the schedule's cwd goes stale while its identity is
   still correct — needs a re-bind path, or the schedule resolves cwd from the
   project's most-recent run at fire time.
6. **Trust boundary on enqueue.** The server can either trust a client-supplied
   `project_id` or re-resolve it from the enqueued cwd's config. For imported
   runs the id must be trusted (the cwd may not exist); for live `fragua run`
   either works. Pick "trust the client, default to resolve-from-cwd when
   absent" to keep both paths simple.
