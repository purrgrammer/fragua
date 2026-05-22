---
title: Run import & bundling — make a run completely portable across stores
summary: "Export a run from one store (a CI artifact, an ephemeral fragua-ci .db, a teammate's machine) and import it into another so it can be inspected — and resumed — locally. A run's truth is its events + messages + content-addressed workflow + blobs; the one thing the event log does NOT carry is worktree/tree state (snapshots are git commits in the run's repo, events hold only SHAs), so the bundle packages those git objects as a git-bundle blob. Identity is collision-safe by construction (ULID run_id, content-hashed workflow + blobs). The frozen 0.1.0 schema needs no new column for portability; the work is bundle format + merge logic + the version-axis split."
status: proposed
maturity: designed
last-reviewed: 2026-05-22
parent: cli-topology.md
---

# Run import & bundling

> Child of [`cli-topology.md`](cli-topology.md). Additive (`fragua db
> export` / `fragua db import`); blocks nothing. Consumes the artifact a
> CI run produces. Interlocks with project identity (shipped — cwd is
> a local binding, rebound on import), [`workflow-ir.md`](workflow-ir.md)
> (the workflow link), and [`event-contract-version.md`](event-contract-version.md)
> (the resume gate across versions).

## 1. Problem

A run that executed elsewhere — a CI runner, a teammate's laptop, an
ephemeral fragua — must be consumable later: inspect it, post-mortem it, roll
its cost into a central store, and crucially **reconstruct its worktree and
resume it** (e.g. a CI run that failed at a HITL node — pull it down, see the
exact tree, answer the gate, continue). That means moving everything a run *is*
from one store into another, byte-faithfully and idempotently.

## 2. Most of a run is trivially portable

Walked against `schema.sql`: **`events` PK is `(run_id, seq)`, `WITHOUT
ROWID`, and `seq` is per-run** — there is no global sequence to reassign.
A run is a single self-contained `run_state` row (no `parent_run_id` FK; the
parallel-sub-run columns are gone). Importing run `R` copies, verbatim:

- its `run_state` row (with local fields rebound — §4);
- the content-addressed `workflows` row by `sha` (identical content ⇒ identical
  sha ⇒ idempotent; with [`workflow-ir.md`](workflow-ir.md) the sha is an IR hash,
  making the link parser-version-independent);
- its `events` and `messages` rows, unchanged (each event payload `< 4096` B,
  each message `< 1 MiB`, by column CHECK);
- the `blobs` / `artifacts` rows the events and messages reference.

Identity is collision-safe across machines by construction: `run_id` is a true
ULID (48-bit ms + 80 random bits, no entropy loss — `run-id.ts`), `workflows`
and `blobs` are content-hashed. Merge dedups on those hashes; an `(run_id)` /
`(run_id, seq)` conflict is detected and skipped-if-identical.

## 3. The crux — tree state does NOT live in the event log

Verified against source. A worktree snapshot is a **git commit written into the
run's own repo**: `captureSnapshot` runs `git add -A` into a sentinel index,
`write-tree`, `commit-tree` (parented on the base), and advances
`refs/fragua/snapshots/<runId>` (`packages/daemon/src/snapshotter.ts`). The
events carry **only SHAs** (`SnapshotCapturedData`, `fact.snapshot_recorded`),
and every read shells `git` against `run_state.cwd` — the local repo
(`run-snapshot-reader.ts`, `routes/run-snapshots.ts`).

**So an event-only bundle cannot reconstruct a worktree.** The bytes live as git
objects in the repo's object store, reachable from `refs/fragua/snapshots/<runId>`,
`refs/fragua/heads/<runId>`, and the base/diff-base commits. The frozen *schema*
is fine — no missing column — but the *bundle format* must package those git
objects.

### 3.1 Mitigation — git-bundle-as-blob, exported lazily

Do **not** extract trees into per-file/per-tree blobs: that reimplements git's
content store, loses cross-snapshot delta compression (the Diff scrubber
captures one snapshot per step/HITL boundary — many near-identical trees that
git packs as deltas), and throws away `git diff` / checkout semantics.

Instead: keep snapshots as native git commits and, **at export time**, package
the run's refs with git's own tool and store the result as one content-addressed
fragua blob:

```sh
git bundle create <tmp> \
  refs/fragua/snapshots/<runId> refs/fragua/heads/<runId> \
  <base_git_sha> <diff_base_sha>
# → store <tmp> bytes as a blob; the manifest records its sha256
```

The export is then **self-contained — everything is blobs** (artifact blobs +
the git-bundle blob), uniform to validate, dedup, and merge. **Self-contained by
default**: include the base objects so unbundling never depends on the importer
already having the right commits. A *thin* bundle (snapshot delta only,
base listed as a prerequisite) is an opt-in optimization for the same-repo case
— and stays tiny because git only ships objects the prerequisite doesn't cover.

**Lazy, not eager.** Export reads the refs from the repo on demand
(`fragua db export <run>`); CI exports by default at run terminal (its refs
exist while the runner is alive). `refs/fragua/snapshots/<runId>` live in the
*main* repo's object store — git worktrees share it — so they survive worktree
disposal and are not pruned by `git gc` while the ref exists. Retention caveat:
a run whose repo was deleted can still export events/messages/artifact-blobs but
**not** tree state. An eager mode (write the bundle-blob at terminal) is the
opt-in for "I might delete the checkout but still want to resume."

### 3.2 Import — reconstruct, then rebind

`fragua db import <bundle>`:

1. Merge the DB rows (§2) and write the blob files.
2. Create a local worktree; `git bundle unbundle` the git-bundle blob into its
   repo (a clone of the same repo, or a scratch repo for inspect-only).
3. **Recreate `refs/fragua/{snapshots,heads}/<runId>` locally** so the snapshot
   readers / Diff scrubber work against the local repo.
4. **Rewrite the imported `run_state.cwd`** to the new local worktree path — the
   source cwd is a foreign path. cwd is a local binding (project identity,
   shipped); identity travels in `project_id`.

The `git add -A` snapshot folds committed + uncommitted into one tree, so a
checkout is byte-identical to the paused working state. The worktree is the
*tree*, not the whole resume: resuming a HITL run also needs the imported run
rows (`paused_human`, current node, routing), the transcript, the workflow IR,
the operator's human input — and the **provider credentialed locally** (secrets
never travel; inspection needs no credential).

## 4. Table-by-table portability audit

| Table | Class | On import |
|---|---|---|
| `workflows` | CONTENT-ADDRESSED | co-travels (FK target of `workflow_sha`); dedup by sha |
| `run_state` | MIXED | `project_id` + `project_name` are the portable IDENTITY/label — both `NOT NULL`, so the bundle **must** carry them (verbatim); same id ⇒ same project on any machine, and the name labels an imported-only project without a local checkout (project identity); metrics / routing / title / status portable; `cwd` rebound to local worktree; `inbox_status` → `pending` (you haven't acted locally); `accepted_sha` cleared (a local branch tip); `branch` / `base_git_ref` advisory; `schedule_id` dangles harmlessly (already non-FK); `workflow_scope` / `workflow_path` advisory (sha is the link); git-state SHAs portable but inert without the git objects (§3); `schema_version` is the resume gate (§5) |
| `events` | PORTABLE | verbatim; per-run PK; merge by `(run_id, seq)`; some payloads reference blob shas → co-travel |
| `messages` | PORTABLE | verbatim; large content spills to blobs → co-travel |
| `blobs` | METADATA + bytes-on-disk | **bytes live under `blobsDir`, not in SQLite** — the bundle must carry the files; content-addressed → dedups |
| `artifacts` | PORTABLE | FK → blobs; co-travel |
| `daemon_lock` | MACHINE-LOCAL | EXCLUDE (pid / hostname / http_url) |
| `daemon_events` | MACHINE-LOCAL | EXCLUDE (autoincrement audit) |
| `schedules` | LOCAL | EXCLUDE (a run carries `schedule_id` as informational lineage only) |
| `provider_credentials` | SECRET | NEVER bundle; resume precondition: provider credentialed locally |
| `provider_config` | MACHINE-LOCAL | resolve locally; the run's events carry provider/model *identity* (strings) |

## 5. Cross-version resume — the gate that bites

Every run pins `run_state.schema_version` at enqueue; the executor refuses an
out-of-range pin with a **terminal** `fact.run_halted { reason: "schema_drift" }`.
At the 0.1.0 baseline `MIN_COMPATIBLE = CURRENT = 1`, so nothing is rejected and
the gate is **latent** — it goes live only once a post-0.1.0 store bumps the
counter. The danger for import: a run from a *newer* producer carries a pin
above the target's `CURRENT` → permanent halt on resume.

[`event-contract-version.md`](event-contract-version.md) is the fix and a hard
dependency for cross-version import: (1) gate resume on an **event-contract
version** that bumps only when fact/intent payloads or reducer semantics change
(rare) — decoupled from the DB migration counter, so the window almost never
rejects; (2) make the drift trip a **recoverable park**, not a terminal halt, so
a too-new import resumes once the local binary catches up instead of dying. The
manifest carries `fragua_version`, `schema_version`, the event-contract version,
and `ir_version` so import validates compatibility up front (clear error / park,
never a silent later halt).

## 6. Bundle manifest

A portable manifest + a blob payload:

- **Carries:** version stamps (above); `workflows` row (source + IR); the
  portable `run_state` subset; `events`; `messages`; `artifacts`; the `blobs`
  manifest (sha256 + size) with the bytes alongside, including the git-bundle
  blob (§3.1).
- **Excludes:** `daemon_lock`, `daemon_events`, `schedules`,
  `provider_credentials`, and local operator state (`inbox_status`,
  `accepted_sha`) — reset on import.
- **Validate on import:** version compatibility; every referenced blob present
  and its bytes hash to its sha256; FK closure (no dangling blob/workflow ref);
  `run_id` idempotency.
- **Merge:** content-addressed dedup for `blobs` + `workflows`; upsert the run by
  `run_id` (skip-if-identical, conflict-detect); `events` by `(run_id, seq)`.
- **Re-export determinism:** canonical row ordering + stable serialization, so
  re-exporting an imported run yields an equivalent manifest — bundles compose
  cleanly across any number of stores.

## 7. Schema changes to make BEFORE stone

The adversarial verdict: **the frozen 0.1.0 schema needs no structural column
added for portability.** Tree portability is bundle-format work (git objects as
a blob), not a schema change; identity is already collision-safe; every
machine-local field is nullable or excludable. The only pre-freeze items are
*contract decisions*, not columns:

1. **Record the snapshot invariant in SPEC before freeze:** tree state lives as
   git objects in the run's repo (`refs/fragua/snapshots/<runId>`); the store
   keeps only SHAs; we deliberately do **not** add a `snapshots` table — bundles
   carry the git objects as a blob.
2. **`project_id` — SHIPPED: in the 0.1.0 baseline, `NOT NULL`.**
   Project identity is implemented: `run_state.project_id` /
   `schedules.project_id` are in the baseline (auto-init mints a real id on
   every enqueue path, so `NOT NULL`), making identity portable across import by
   construction —
   the incoming `cwd` is advisory and rebound (§4). The **workflows `ir` /
   `ir_version`** half of this freeze-window question remains the only open column
   decision, pending [`workflow-ir.md`](workflow-ir.md).
3. **Verify** (done — none found) that no `NOT NULL` local-binding column blocks
   importing a stripped run.

Everything else — the `git bundle` export/import, the manifest format, merge
logic, the version-axis split — is the import *leg* and does not constrain the
freeze.

## 8. Scope / dependencies / MVP

- **Depends on:** the snapshot git objects existing at export (lazy, repo-alive);
  [`event-contract-version.md`](event-contract-version.md) for cross-version
  resume.
- **Wins independently:** yes — additive `fragua db export` / `import`.
- **MVP:** export the DB-row subset + blobs + a self-contained git-bundle blob;
  import = merge rows + write blobs + unbundle + recreate local refs + rebind
  cwd; PK-conflict skip-if-identical; refuse (or park) a too-new pin with a clear
  message. The version-axis split is its own proposal; resume-after-import is the
  MVP's reach goal, inspect-after-import the floor.
