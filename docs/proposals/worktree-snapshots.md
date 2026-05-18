---
title: Worktree snapshots at node boundaries
status: proposed
maturity: designed
last-reviewed: 2026-05-18
---

# Worktree snapshots at node boundaries

> After every `fact.node_completed` (and on every HITL pause), capture
> the run's worktree state as a git tree and pin it under
> `refs/swarm/snapshots/<runId>/<eventIdx>`. No branches, no tags, no
> synthetic refs in the user's namespace. Three immediate payoffs —
> HITL pauses surface a real diff, the UI files/diff view stops
> racing with the running worktree, and later forkability becomes a
> drop-in. Independent of any of them, the diff-on-HITL UX alone
> justifies the work.
>
> Sibling: [worktree-design](./worktree-design.md) enumerates the
> rough edges in the current worktree model; this proposal targets a
> specific gap (no historical snapshot of in-flight state) and uses
> infrastructure that's already mostly there.
> [file-server](./file-server.md) is the larger UI-side endpoint
> proposal; the read endpoints here are a strict subset.

---

## Why now

Three concrete needs converge:

1. **HITL pauses are blind.** Today `fact.run_paused_hitl` carries
   `{ nodeId, label, options[] }`. The operator approving "ship this"
   has no view of *what* they're approving short of opening the
   worktree directory by hand. The dashboard cannot show a diff
   because there's nothing immutable to diff against — the worktree
   is still mounted and may change.

2. **UI files/diff is racy or absent.** The dashboard either reads
   the live worktree (race with the running node) or waits for the
   workflow to commit (most workflows don't commit until the very
   end). There's no honest "what does the tree look like at this
   point" view.

3. **Forkability needs a snapshot.** A separate design conversation
   landed on the property "fork any run at any event index, edit
   schema-valid state, continue." That property is dishonest for any
   workflow touching disk unless filesystem state at the fork point
   is recoverable. Snapshots are the prerequisite.

(1) and (2) each justify the work independently. (3) is a happy
downstream of the same primitive.

---

## Mechanism

Three git plumbing commands do the work:

```
git write-tree         # capture working-tree state as a tree object
git commit-tree        # wrap a tree as a commit, no ref required
git update-ref <NS>    # pin under any namespace
```

The namespace `refs/swarm/snapshots/<runId>/<eventIdx>` is real (so
the object is reachable for `git diff` / `git show` and immune to
`git gc`) but invisible to `git branch` / `git tag` / `git log
--all` of normal porcelain. The user's branch namespace stays
exactly as they left it.

---

## Node-boundary sequence

After the daemon appends `fact.node_completed`, before the next
dispatch:

```sh
WORKTREE=<from run_state.cwd via worktree-provisioner>
RUN_ID=<run_state.id>
EVENT_IDX=<the fact's monotonic index>
NODE_ID=<from the fact payload>
PARENT_SNAP=<previous snapshot for this run, or baseGitSha>

cd "$WORKTREE"

# Stage everything into a sentinel index; do not touch .git/index.
GIT_INDEX_FILE=.git/swarm-index git add -A
TREE_SHA=$(GIT_INDEX_FILE=.git/swarm-index git write-tree)

# Anonymous commit; no porcelain side-effects.
COMMIT_SHA=$(git commit-tree "$TREE_SHA" \
  -p "$PARENT_SNAP" \
  -m "swarm:$RUN_ID:$EVENT_IDX node=$NODE_ID")

git update-ref "refs/swarm/snapshots/$RUN_ID/$EVENT_IDX" "$COMMIT_SHA"

rm .git/swarm-index
```

Wall time: 20-100ms on typical worktrees. Bounded by the size of the
delta since the previous snapshot (git content-addresses unchanged
blobs to zero new bytes).

Practical details that matter:

- **Sentinel index file.** `GIT_INDEX_FILE=.git/swarm-index` keeps
  `git add -A` from clobbering the user's staging area. The snapshot
  index lives parallel to `.git/index` and we never write it back.
- **`.gitignore` honoured by default.** That's usually correct. For
  workflows that generate files `.gitignore` excludes but the
  operator wants captured, a run-level `snapshot_keep` glob list
  converts to `git add --force <pattern>` before the `-A`.
- **No `.git/index.lock` contention.** Parallel index file path
  means snapshotting doesn't conflict with concurrent node-body git
  operations.
- **Daemon owns sequencing.** Snapshot fires *after* the executor
  has written the completion fact, never overlapping with the next
  dispatch. Torn-state captures are not possible if the daemon owns
  the ordering — which it does.

### When to snapshot

Snapshot on:
- `fact.node_completed`
- `fact.run_paused_hitl` (so the operator sees the same state the
  daemon paused on)
- `fact.run_paused_*` more generally? (open question — see below)

Not on `cost_update`, `llm.text_delta`, `subagent.*`, or any of the
high-frequency observability events. Snapshotting at every fact
would balloon storage without buying anything for the use cases
above.

### Event taxonomy

One new fact type:

```ts
type SnapshotRecordedFact = {
  type: 'fact.snapshot_recorded';
  payload: {
    runId: RunId;
    eventIdx: number;             // index of the originating fact
    nodeId: NodeId;
    treeSha: string;
    commitSha: string;
    ref: string;                   // refs/swarm/snapshots/<runId>/<eventIdx>
    parentSnap: string;            // sha
  };
};
```

Keeping snapshot data on a separate event (rather than appending
fields to `fact.node_completed`) means non-snapshottable runs
(bare-cwd, no worktree) emit no snapshot facts at all — cleaner than
ubiquitous nullable fields.

`fact.run_paused_hitl.payload` extends with:

```ts
{
  // existing: nodeId, label, options
  snapshot?: {
    treeSha:    string;
    commitSha:  string;
    baseGitSha: string;
    stat: { filesChanged: number; insertions: number; deletions: number };
  };
}
```

The `stat` is computed once via `git diff --shortstat <baseGitSha>
<commitSha>` (few milliseconds) and embedded so the operator's first
paint includes "127 changes across 8 files" without a server
roundtrip.

### Server endpoints

Thin wrappers over `git ls-tree` / `git show` / `git diff` against
the run's worktree git dir:

```
GET /runs/:id/snapshots/:eventIdx/tree
  → { entries: Array<{ path, mode, size, type }> }

GET /runs/:id/snapshots/:eventIdx/file?path=<repo-relative>
  → file contents (text/plain or application/octet-stream)

GET /runs/:id/snapshots/:eventIdx/diff
  ?against=base | previous | <eventIdx>
  &path=<optional>
  → unified diff (text/x-diff) or structured JSON
```

All three are pure object-database reads. No checkouts, no branches,
no race with the still-running worktree.

This overlaps with [file-server](./file-server.md). The endpoints
above are a strict subset scoped to snapshot reads on the local
machine; the file-server proposal is the broader cross-project
content-addressed surface. They compose: the file-server's
`/api/projects/:id/blob/:sha` ends up reading the same objects.

---

## Storage and lifecycle

Cost is bounded by *changed bytes*, not by snapshot count. A typical
swarm node touches a handful of small text files; each snapshot adds
tens of kB of compressed blobs plus a tree and a commit. 100
snapshots over a run ≈ low-MB of objects.

Lifecycle:

- **Run alive:** snapshots referenced by `refs/swarm/snapshots/<runId>/*`,
  immune to `git gc`.
- **Run terminated, inside retention:** keep refs.
- **Run aged out (existing GC policy in [db-retention](./db-retention.md)):**
  delete the run's snapshot refs in one batch:
  ```sh
  git for-each-ref refs/swarm/snapshots/$RUN_ID/ \
    --format='%(refname)' \
    | xargs -n1 git update-ref -d
  ```
  Next `git gc --auto` reclaims the orphan objects. Pruning is
  decoupled from `git gc` cadence — swarm controls when refs are
  deleted.

For long-running codergen nodes (`max_ms=0`, days-long runs over big
monorepos), per-snapshot cost climbs with the delta. Mitigation:
configurable `snapshot_max_blob_bytes` per run; oversize files get
pointer-replaced (with a manifest line in the event payload) or
excluded outright. v1 can ignore this; revisit if disk pressure
surfaces.

---

## Where this falls down

- **Crashed-mid-execution forks.** If a codergen node crashes mid
  tool-call, no `fact.node_completed` fires, no snapshot is taken,
  and the worktree has half-written files. Either snapshot at
  `fact.node_started` too (so failure is forkable from the
  pre-execution state) or accept that crash forks restore to the
  *previous* node's snapshot. Latter is probably right.

- **Bare-cwd runs.** If a workflow runs against the user's primary
  checkout (no daemon-provisioned worktree) and the user has
  uncommitted changes, `git add -A` would capture the user's work
  along with the workflow's. Mitigation: snapshots only fire when
  the run uses a daemon-provisioned worktree (which is already the
  default). Bare-cwd runs emit no `fact.snapshot_recorded` events
  and the HITL pause payload's `snapshot` field is absent.

- **Parallel branches sharing a worktree.** Today's parallel branches
  share the run's single worktree (see B4 in
  [worktree-design](./worktree-design.md)). Snapshot at the
  `parallel.fan_in` boundary captures the merged state, but
  per-branch snapshots aren't meaningful when branches can't modify
  the tree anyway. The
  [parallel sub-runs proposal](./parallel.md) changes this — once
  branches become sub-runs with their own worktrees, each sub-run
  carries its own snapshot lineage and `fan_in` snapshots reduce
  across them. The two proposals compose; this one does not block on
  parallel sub-runs.

- **`git lfs` content.** LFS pointers snapshot fine (they're text);
  contents may or may not be in the local object DB. Workflows that
  touch LFS-managed files need explicit policy. Out of scope for
  v1.

- **Submodules.** Git tracks submodule pointers, not contents.
  Snapshots faithfully capture pointer movement; submodule working
  state isn't captured. Probably fine — swarm rarely touches them.

- **Cross-machine reads.** Snapshots live in the local git object
  database. The UI reads them via the daemon's local git dir, which
  is fine. Forks on a different machine would require pushing
  `refs/swarm/snapshots/<runId>/*` somewhere reachable. Out of scope
  for v1; fork-on-same-machine is enough to make the property
  honest.

- **Editor co-occupancy.** B5 in
  [worktree-design](./worktree-design.md). If the user opens the
  run's worktree in their editor while the agent is mid-edit, the
  snapshot captures whatever was on disk at completion time —
  including the user's half-saved file. Same hazard as today's
  in-worktree git operations; snapshots don't make it worse.

---

## Implementation order

Six steps, each independently shippable:

1. **`snapshotter.ts` in `@swarm/daemon`.** Pure utility that
   wraps the plumbing sequence above and returns
   `{ treeSha, commitSha, ref }`. No schema changes. Unit-testable
   against a fixture git repo.

2. **Wire into the recorder.** `packages/daemon/src/recorder.ts`
   appends `fact.snapshot_recorded` immediately after
   `fact.node_completed` lands, when the run uses a worktree
   provisioner. Same-PR contract update on
   `packages/types/src/swarm-events.ts` + ARCH §3 (event taxonomy).

3. **Extend `fact.run_paused_hitl.payload`** with the optional
   `snapshot` field. Daemon computes `stat` once via `git diff
   --shortstat`. Same-PR: `swarm-events.ts`, ARCH §3, the swarm-debug
   skill §8 if it documents the HITL payload shape.

4. **Server endpoints.** Three handlers in `packages/server/src/`
   wrapping `git ls-tree` / `git show` / `git diff`. Long-lived `git
   cat-file --batch` process per run is a tempting optimisation but
   premature — start with one-shot execs and measure. Same-PR:
   swarm-run skill cheat sheet if it lists routes; ARCH §7 routes
   table.

5. **GC hook.** `packages/store/src/store.ts` retention sweep
   batch-deletes `refs/swarm/snapshots/<runId>/*` when a run ages
   out. Same-PR: [db-retention](./db-retention.md) updates to note
   the new ref namespace it cleans.

6. **UI: Files tab + diff view + event scrubber.** Web-side work
   reading from (4). The event scrubber — slider through
   `fact.snapshot_recorded` indices, snapshot view updates — is the
   UX that's hard to imagine without trying. Probably the highest
   leverage piece of the whole proposal.

(7) — forkability — is downstream. Once snapshots exist, `intent.fork_run`
becomes `git worktree add <new-path> <commitSha>` to provision the
fork's worktree from any snapshot, plus a new `runId` with
`provenance: { from, atEventIdx, patch }`. The forking proposal will
need its own design pass on operator UX, dry-run vs live, edit
schemas, and concurrent fork lineages — but the *prerequisite* this
proposal provides is the cheap part.

---

## Open questions

- **Pause-time snapshots beyond HITL.** Should `fact.run_paused_budget`,
  `fact.run_paused_provider_error`, etc. also snapshot? They benefit
  the operator-resumes-with-context UX but add storage. Default to
  yes; trivial to gate by pause reason if cost surfaces.

- **Snapshot at node_started?** Costs roughly 2× storage on a busy
  run. Buys crash-fork honesty and "what did this node change?"
  diffs (snapshot[completed] vs snapshot[started] of the same
  nodeId). Probably worth it; revisit after step (2) ships and we
  see real cost data.

- **Snapshot index in the DB.** Storing `{ runId, eventIdx, treeSha,
  commitSha, ref }` only in the event log means listing snapshots
  for a run requires walking events. Adding a `snapshots` table (or
  a generated column on `events`) makes the list endpoint a single
  SQL query. Defer until the UI's list-snapshots endpoint exists
  and we measure walking cost.

- **Diff against base for the run.** `git diff <baseGitSha>
  <latestSnapshotRef>` answers "what has this run changed in
  aggregate." Useful for run cards in the dashboard. Cheap; add to
  step (4).

- **B9 interaction.** The committed-in-worktree-but-clean-tree bug
  fixed in [worktree-design](./worktree-design.md) §B9 used
  `git rev-list <baseGitSha>..HEAD --count` as the recoverability
  signal. With snapshots, every node-boundary state is already
  reachable by sha — the recoverability check at dispose time
  becomes redundant in the cases snapshots cover. Worth verifying
  during step (2) that the existing B9 fix and the new snapshot
  refs agree on what's recoverable.

- **Snapshot integrity check.** `git fsck` on the snapshot refs at
  startup? Probably not — orthogonal to swarm's correctness. If a
  user runs `git gc --prune=now` and nukes their swarm refs, that's
  user error; the event log still tells the truth about what
  happened.
