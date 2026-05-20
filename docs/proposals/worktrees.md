---
title: Worktrees
status: proposed
maturity: designed
last-reviewed: 2026-05-20
---

# Worktrees

> Per-run worktree isolation, tree snapshots at meaningful boundaries,
> and operator-triggered post-run primitives (branch / commit / merge
> / discard) — all on top of two non-porcelain ref namespaces. The
> user's `git branch` / `git log` output stays clean; nothing
> swarm-authored leaks into porcelain unless the operator asks for it.
> Terminal runs with recoverable changes are promoted to an **inbox**
> the operator works through; runs that end clean disappear quietly.
>
> Replaces the earlier `worktree-design.md` and `worktree-snapshots.md`
> proposals.

---

## Why now

Three concrete pains converge on one substrate:

1. **HITL pauses are blind.** `fact.run_paused_human` carries
   `{ nodeId, text, routes[] }`. The operator approving "ship this"
   has no view of *what* they're approving short of opening the
   worktree directory by hand. The dashboard can't show a diff because
   there's nothing immutable to diff against — the worktree is still
   mounted and may change.

2. **UI files/diff is racy or absent.** The dashboard either reads
   the live worktree (race with the running node) or waits for the
   workflow to commit (most workflows don't until the very end).
   There's no honest "what does the tree look like at this point"
   view.

3. **Dispose makes policy decisions it shouldn't.** Today dispose
   inspects the worktree and decides whether to preserve a
   `swarm/runs/<run_id>` branch. That mechanism leaks synthetic refs
   into porcelain, has no GC story (B1 in the old design doc), and
   silently dropped work when workflows committed in-tree (B9 — fix
   landed, but the underlying coupling stays). Operators also have
   no notification surface for "this run finished and left work
   behind that needs attention."

Snapshots + operator primitives + an inbox address all three with
one mechanism.

---

## Goals / non-goals

**Goals:**
- Per-run worktree isolation (already the default; unchanged).
- Snapshots of tree state at every step (on by default,
  delta-suppressed), HITL pauses, and terminal status — visible in the
  UI as a per-step Diff scrubber, and the per-step tree-delta substrate
  for future evals.
- Operator-driven post-run primitives: branch, commit, merge, discard.
- Runs with recoverable agent work surface in an **inbox**; clean runs
  (and read-only reviews) don't.
- A foundation for fork-from-snapshot (separate downstream proposal).

**Non-goals:**
- Auto-created porcelain refs. Nothing swarm writes appears in
  `git branch` / `git tag` / `git log --all` of normal porcelain.
- Dictating workflow shape. Workflows that commit in-tree as they
  progress remain first-class; the snapshot/heads cursor captures
  whatever the workflow does.
- Per-branch isolation in parallel shapes (orthogonal; deferred).
- Rebase-on-wake for long-paused runs (orthogonal; separate doc).

---

## Mechanism

Three git plumbing commands do the snapshot work:

```
git write-tree         # capture working-tree state as a tree object
git commit-tree        # wrap a tree as a commit, no ref required
git update-ref <NS>    # pin under a non-porcelain namespace
```

Two ref namespaces, both under `refs/swarm/` (invisible to porcelain,
reachable for `git diff` / `git show`, immune to `git gc` while
referenced):

| Namespace | Lifecycle |
|---|---|
| `refs/swarm/snapshots/<runId>` | **One tip ref per run.** Moves forward to each new snapshot commit; because the lineage is parented, this single ref keeps every prior snapshot in the chain reachable (and safe from `git gc`). Intermediate snapshots are addressed by their `commitSha` — recorded in the `snapshot.captured` / `fact.snapshot_recorded` payload — never by a per-eventIdx ref. |
| `refs/swarm/heads/<runId>` | Live cursor on the worktree's HEAD; updated at each snapshot boundary; survives dispose only when `HEAD != base_git_sha`. |

The snapshot ref captures **tree state including uncommitted dirt**.
The heads ref captures **the worktree's HEAD sha** — workflow-authored
commit history, ready to be promoted by an operator primitive.

Two refs per run, not N: the parent chain is what lets a single tip ref
pin the whole history, so a busy run with dozens of steps adds two refs,
not dozens. This is the answer to loose-ref bloat — see GC.

### Snapshot capture sequence

After the daemon appends a snapshot-eligible fact, before the next
dispatch:

```sh
WORKTREE=<from run_state.cwd via worktree-provisioner>
RUN_ID=<run_state.id>
EVENT_IDX=<the fact's monotonic index>
PARENT_SNAP=<previous snapshot ref for this run, or baseGitSha>

cd "$WORKTREE"

# Sentinel index. In a LINKED worktree `.git` is a file, not a dir,
# so `.git/swarm-index` does not exist — resolve the per-worktree
# gitdir path explicitly. Seed it from the real index so the stat
# cache is warm and `add -A` only re-hashes changed files; an empty
# sentinel forces a full-tree rehash and the delta-cost claim is lost.
SWARM_INDEX=$(git rev-parse --git-path swarm-index)
cp "$(git rev-parse --git-path index)" "$SWARM_INDEX"
GIT_INDEX_FILE="$SWARM_INDEX" git add -A
TREE_SHA=$(GIT_INDEX_FILE="$SWARM_INDEX" git write-tree)

COMMIT_SHA=$(git commit-tree "$TREE_SHA" \
  -p "$PARENT_SNAP" \
  -m "swarm:$RUN_ID:$EVENT_IDX")

# Move the single per-run tip forward. PARENT_SNAP was this ref's prior
# value (or baseGitSha for the first snapshot); the parent chain keeps
# every earlier snapshot reachable under this one ref. COMMIT_SHA is
# recorded in the event so intermediate snapshots stay addressable.
git update-ref "refs/swarm/snapshots/$RUN_ID" "$COMMIT_SHA"

# Live HEAD cursor: tracks any in-workflow commits AND in-workflow
# checkouts. No-assumption — whatever HEAD points to at this boundary.
HEAD_SHA=$(git rev-parse HEAD)
if [ "$HEAD_SHA" != "$BASE_GIT_SHA" ]; then
  git update-ref "refs/swarm/heads/$RUN_ID" "$HEAD_SHA"
fi

rm -f "$SWARM_INDEX"
```

Seeding warms the *hash* cache, so hashing is delta-bounded — but
change *detection* is an `lstat()` over every tracked path, O(tracked
files), not O(delta). On a small/medium tree that's the 20–100ms
quoted; on a 50k-file monorepo it's a few hundred ms. Still <1% on an
LLM-paced step, and `snapshot_per_step: false` is the escape hatch for
pathological trees, but the cost scales with file count, not just the
change. The separate `GIT_INDEX_FILE` means snapshotting touches
`swarm-index.lock`, never `.git/index.lock`, so it doesn't conflict
with concurrent node-body `git add` or the user's staging area. The
sentinel lives inside the per-worktree gitdir
(`.git/worktrees/<name>/swarm-index`), so a crash between `add` and `rm`
leaks nothing durable — `git worktree remove` at dispose deletes it with
the gitdir.

`git add` writes new blobs into the **shared** object database (linked
worktrees share the parent repo's ODB) *before* delta-suppression can
decide anything — so a transient large file a node creates then deletes
still bloats the ODB until `git gc`. `.gitignore` keeps `node_modules` /
build artefacts / `.DS_Store` out by default; for the rest, the
`snapshot_max_blob_bytes` guard (below) runs **before** `add -A` and is
**in v1**, not deferred — per-step-by-default makes oversize capture
routine, not rare.

Concurrent runs share one ref store, so the two `update-ref` calls
contend on `packed-refs` / loose-ref locks (not the index). Wrap them
in a bounded retry/backoff rather than letting a lock collision fail
the boundary.

At **HITL pauses** and **terminal status** boundaries, the snapshotter
additionally records the worktree's HEAD ref and a drift bit, then
computes the change stat against an *honest* base:

```sh
HEAD_REF=$(git symbolic-ref --short HEAD 2>/dev/null || echo "")   # "" = detached

# Honest diff base: base when the workflow committed on top of it,
# the fork point when the workflow checked out an unrelated line.
# merge-base(base, HEAD) == base exactly when base is an ancestor of
# HEAD, so DIFF_BASE == BASE_GIT_SHA ⟺ not relocated — no separate bool.
DIFF_BASE=$(git merge-base "$BASE_GIT_SHA" HEAD)

# committed delta (what branch / ff-merge promote)
git diff --shortstat $DIFF_BASE $HEAD_SHA
# uncommitted delta (agent dirt — what commit promotes)
git diff --shortstat $HEAD_SHA $COMMIT_SHA
# → "  8 files changed, 127 insertions(+), 14 deletions(-)"
```

`DIFF_BASE` is the signal that a fetch/checkout workflow (e.g. a review
run that checked out `feature-x`) doesn't get surfaced with a
multi-thousand-line diff against the wrong base. The two `git diff`
runs feed `change_stat.{committed, uncommitted}`. `{ headRef,
diffBaseSha, committed, uncommitted }` are embedded in the originating
fact's payload (HITL) or the snapshot fact's payload (terminal).
Few-ms cost.

### When to snapshot

- `fact.node_completed` — **per step, on by default.**
- `fact.run_paused_human`
- Every terminal status fact (`fact.run_completed`,
  `fact.run_cancelled`, `fact.run_halted`, etc.)

Per-step snapshots are the substrate for **observability and future
evals** — a top priority: every step's tree change is captured so the
machine (event log) and the human (a Diff scrubber, below) can both
answer "what did this step change?" That makes per-step the default,
not a deferred add-on.

**Delta-suppression.** A per-step snapshot is emitted only when its
`treeSha` diverges from the previous snapshot's. Read-only steps
(planning, routing, review-reads) change nothing, so they cost a
seeded stat-walk + `write-tree` (tens of ms, zero new git objects on a
content-address hit) and write **no** fact, ref, or commit. The probe
is cheap relative to inference and writes nothing when idle; we do not
gate it on a "did a mutating tool run?" heuristic — tools may be
user-authored, so any such guess is unsound, and being wrong is more
expensive than always probing.

**HITL + terminal always record**, even on an unchanged tree: they are
meaningful boundaries (the operator paused here / the run ended here)
and carry the `committed`/`uncommitted` stats + `headRef` + `diffBaseSha`
the per-step events omit. They `commit-tree` a fresh commit (new commit
sha, possibly identical tree sha) so lineage stays intact. HITL emits a
`snapshot.captured` event (and embeds the same data on
`fact.run_paused_human.payload.snapshot` for first-paint); terminal
emits the `fact.snapshot_recorded` fact that drives the projection.

**Knob.** Run-level `snapshot_per_step: true` (default) disables
per-step capture when set false; HITL + terminal snapshots are
unconditional and not affected by the knob.

Never on `cost_update`, `llm.text_delta`, `subagent.*`, or other
high-frequency observability events.

### `.gitignore` and overrides

`git add -A` honours `.gitignore` by default — usually correct. A
run-level `snapshot_keep` glob list converts to `git add --force
<pattern>` before the `-A` for workflows that generate files
`.gitignore` excludes but the operator wants captured.

**`snapshot_max_blob_bytes`** (v1). Before `add -A`, files above the
threshold (default e.g. 10MB) are excluded from the snapshot — they
never enter the shared ODB. Bounds the transient-blob bloat that
delta-suppression can't prevent (blobs are written at `add` time,
before the suppression check). Oversize paths are noted on the
`snapshot.captured` payload so the diff view can show "N files omitted
(over size limit)" rather than silently dropping them.

---

## State shape

```ts
run_state {
  // existing
  base_git_sha:   string

  // new
  base_git_ref:   string | null  // git symbolic-ref --short HEAD of user-cwd at provision; null when detached/tag/remote-only
  final_git_sha:  string | null  // worktree HEAD at last snapshot boundary; NULL pre-terminal
  final_head_ref: string | null  // symbolic-ref --short HEAD *in the worktree* at terminal; null when detached. The branch the workflow actually ended on (may differ from base_git_ref after an in-workflow checkout)
  diff_base_sha:  string | null  // sha the terminal diff was computed against: base_git_sha normally, merge-base(base, HEAD) when the workflow relocated HEAD. NULL pre-terminal. `relocated` ⟺ diff_base_sha !== base_git_sha
  change_stat:    {              // diff vs diff_base_sha at terminal; NULL pre-terminal
    committed:   { filesChanged: number; insertions: number; deletions: number } | null  // diff_base_sha..HEAD (workflow-authored commits); NULL when none / relocated
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null  // HEAD-tree vs snapshot-tree (agent dirt); NULL when clean
  } | null
  inbox_status:   'pending' | 'acted' | 'discarded' | null  // projection (see below)
  final_branch:   string | null  // projection: last branch_run target
  final_commit:   string | null  // projection: last commit_run sha
  merged_into:    string | null  // projection: last merge_run target
}
```

`base_git_ref` is the merge/commit target default. Capture rule:
`git symbolic-ref --short HEAD` of the user's checkout at provision.
Null when the provisioner finds a detached HEAD, a tag checkout, or a
remote-tracking-only checkout — in those cases post-run primitives
require explicit `--into` / `--onto`.

`final_head_ref` / `diff_base_sha` are captured *in the worktree* at
terminal (the worktree itself starts on a detached HEAD; these change
only if the workflow runs `git checkout`). `final_head_ref` is plain
metadata — **a string, not a git ref** — so recording it creates no
synthetic branch; it names the branch the run actually ended on.
`diff_base_sha` is the honest diff base: `base_git_sha` normally,
`merge-base(base, HEAD)` when the workflow relocated HEAD, so a review
run that checked out `feature-x` doesn't land with a giant spurious
diff. The relocation predicate falls out as a pure comparison —
`diff_base_sha !== base_git_sha` — and the read endpoints reuse
`diff_base_sha` to re-diff identically.

`change_stat` splits the two questions a single scalar can't answer
honestly:

- **`committed`** — `diff_base_sha..HEAD`, the workflow-authored commit
  delta. What `branch` / ff-`merge` would promote.
- **`uncommitted`** — HEAD-tree vs the snapshot tree, the agent's dirt.
  What `commit` would promote (on top of the committed work).

Both NULL means a clean run. It drives run-card badges and retention
bumps (keep refs alive past normal GC).

`inbox_status` transitions. The gate is **recoverable agent work**, not
"diff vs base ≠ 0" — a pure review that checks out `feature-x`, reads,
and edits nothing has a huge `diff_base_sha..HEAD` but no agent-authored
delta, and must stay out of the inbox:

```
recoverable := uncommitted IS NOT NULL
            OR (committed IS NOT NULL
                AND diff_base_sha == base_git_sha
                AND final_head_ref IS NULL)
```

i.e. the agent left dirt, OR it committed **on the provisioned, detached
line**. The `final_head_ref IS NULL` clause is load-bearing and was added
after a live review run exposed the gap: a review that `git checkout`s a
branch which *descends* from the provision base has `diff_base_sha ==
base_git_sha` (the relocation check alone says "not relocated") and a
large `committed` delta — but that delta is the checked-out branch's
content, not agent-authored work. Agent work in a swarm worktree happens
on the detached HEAD (`final_head_ref` null); a **named branch means a
checkout**, so its committed delta is excluded. A relocated HEAD
(`diff_base_sha != base_git_sha`) is likewise the agent standing on
someone else's line — informational, not promotable. Uncommitted dirt is
always the agent's, branch or not.

| From | Trigger | To |
|---|---|---|
| `NULL` | terminal fact + `recoverable` | `pending` |
| `NULL` | terminal fact + `NOT recoverable` | `NULL` (stays out of inbox) |
| `pending` | `fact.run_branched` / `_committed` / `_merged` | `acted` |
| `pending` | `fact.run_discarded` | `discarded` |
| `acted` | further action facts | `acted` (terminal) |

`discarded` is terminal-terminal — subsequent actions fail.

---

## Event taxonomy

Snapshots split by bucket. **Per-step and HITL captures are
observability events** (`snapshot.captured`, writer: daemon, no OCC,
skip the reducer — same bucket as `cost.recorded` / `llm.text_delta`):
nothing decisional reads them, the scrubber tails them off the event
log, so they cost no version bump. **Only the terminal capture is a
fact** (`fact.snapshot_recorded`, OCC-checked) because it drives the
projection. Then four operator-action facts and one HITL payload
extension.

```ts
// Per mutating step + at HITL pause. Delta-suppressed: not emitted
// when treeSha is unchanged. Pure observability — the scrubber feed.
type SnapshotCapturedEvent = {
  type: 'snapshot.captured';
  payload: {
    runId:       RunId;
    eventIdx:    number;          // index of the originating fact
    nodeId:      NodeId | null;   // null at a HITL pause
    treeSha:     string;
    commitSha:   string;          // the addressing key — no per-eventIdx ref; the run's tip ref keeps it reachable
    parentSnap:  string;          // previous snapshot's commitSha (lineage)
    headSha:     string | null;   // null when HEAD == baseGitSha
    headRef?:    string | null;   // symbolic-ref --short HEAD ("" detached); present at HITL
    diffBaseSha?: string;         // present at HITL
    committed?:  { filesChanged: number; insertions: number; deletions: number } | null;    // present at HITL
    uncommitted?: { filesChanged: number; insertions: number; deletions: number } | null;   // present at HITL
  };
};

// Fires once per run, after the terminal status fact. OCC-checked: the
// projection (change_stat / inbox_status / final_*) is written from
// this payload in the same transaction. The reducer stays pure — the
// snapshotter (executor) precomputed everything here.
type SnapshotRecordedFact = {
  type: 'fact.snapshot_recorded';
  payload: {
    runId:       RunId;
    eventIdx:    number;
    treeSha:     string;
    commitSha:   string;          // tip after this capture; run's tip ref points here
    parentSnap:  string;          // previous snapshot's commitSha
    headSha:     string | null;
    headRef:     string | null;   // "" when detached
    diffBaseSha: string;          // == baseGitSha unless relocated
    committed:   { filesChanged: number; insertions: number; deletions: number } | null;
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null;
  };
};

type RunBranchedFact = {
  type: 'fact.run_branched';
  payload: { branch: string; sha: string };
};

type RunCommittedFact = {
  type: 'fact.run_committed';
  payload: { targetBranch: string; sha: string; message: string; parentSha: string };
};

type RunMergedFact = {
  type: 'fact.run_merged';
  payload: { targetBranch: string; mode: 'ff' | 'merge' | 'squash'; sha: string; parentShas: string[] };
};

type RunDiscardedFact = {
  type: 'fact.run_discarded';
  payload: { refs: string[] };
};
```

Each operator-action fact is paired with its originating intent
(`intent.branch_run`, `intent.commit_run`, `intent.merge_run`,
`intent.discard_run`). The run's event log self-narrates the full
lifecycle, including post-terminal operations.

**Contract break.** `fact.run_branched` exists today, emitted by
dispose when preservation fires. Under this proposal it fires only
in response to `intent.branch_run` and gains a `sha` field. Grep
`packages/` for consumers before landing.

`fact.run_paused_human.payload` extends with:

```ts
{
  // existing: nodeId, label, options
  snapshot?: {
    treeSha:     string;
    commitSha:   string;
    headSha:     string | null;
    headRef:     string | null;
    baseGitSha:  string;
    diffBaseSha: string;
    committed:   { filesChanged: number; insertions: number; deletions: number } | null;
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null;
  };
}
```

The stats are embedded so the operator's first paint includes "127
changes across 8 files" without a server roundtrip.

---

## Lifecycle

### Provision

`worktree-provisioner.ensure(runId)` adds:

```sh
BASE_GIT_REF=$(git -C <user-cwd> symbolic-ref --short HEAD 2>/dev/null || echo "")
```

Stored on `run_state.base_git_ref` (null when symbolic-ref fails).

### Who drives it (execution model)

The **executor** drives snapshots, not the recorder — it's the fiber
that holds `runEnv` + the `provisioner`, writes the event log, and owns
the dispatch sequence. Immediately after the originating fact lands and
**before the next dispatch** (so the captured tree can't be torn by the
following node), it captures and records by bucket:

- after `fact.node_completed` → emit a `snapshot.captured` observability
  event (delta-suppressed; nothing if `treeSha` unchanged);
- at `fact.run_paused_human` → emit `snapshot.captured` and embed the
  same payload on the pause fact for first-paint;
- after a terminal status fact → append `fact.snapshot_recorded`, whose
  reducer step writes the projection in the same transaction.

**Interface tweak — Provisioner, not ExecutionEnvironment.**
`ExecutionEnvironment` (the file/exec surface in
`packages/core/src/types/execution.ts`) is **unchanged**; snapshotting
is worktree lifecycle, not file I/O. The `Provisioner` interface gains:

```ts
interface Provisioner {
  // existing: ensure, dispose, baseGitSha
  baseGitRef(runId: string): string | null;
  snapshot(runId: string, boundary: SnapshotBoundary): Promise<SnapshotResult | null>;
}
type SnapshotBoundary =
  | { kind: 'step'; eventIdx: number; nodeId: NodeId }
  | { kind: 'hitl' | 'terminal'; eventIdx: number };
```

`WorktreeProvisioner.snapshot` delegates to `snapshotter.ts` and the
`WorktreeEnvironment` instance (which already holds the worktree path
and `baseGitSha`); git runs via `env.exec(..., { env: { GIT_INDEX_FILE }})`.
It returns `null` when delta-suppressed (unchanged `treeSha` on a
`'step'` boundary) — the executor then emits nothing. **Bare-cwd runs
are excluded structurally**: the executor only snapshots
`if (opts.provisioner)`, and `LocalEnvironment` runs have no provisioner
— so no capability flag is needed, and the HITL payload's `snapshot`
field is simply absent for them.

**Cost is on the critical path, by necessity.** The capture is
synchronous between a node's `node_completed` and the next dispatch (it
*must* be — the next node can mutate the tree). Tens of ms per step,
cheap against inference, but it is added per-step latency, not
background work.

**Failure policy differs by bucket — this is load-bearing.**
- *Per-step / HITL* (`snapshot.captured`): **non-fatal.** On plumbing
  failure the executor emits a diagnostic event and continues dispatch
  — observability must never fail a run. These are best-effort and not
  guaranteed 1:1 with `node_completed` (a crash between the two leaves a
  gap; the scrubber tolerates it).
- *Terminal* (`fact.snapshot_recorded`): **must succeed before the
  worktree is removed.** This is the only capture that gates
  recoverability — if it fails (e.g. `packed-refs` lock timeout) and we
  disposed anyway, uncommitted dirt would vanish *and* the run would
  never enter the inbox: silent loss of exactly the work this system
  exists to protect. So the terminal capture + projection are on the
  OCC path with retry, and **dispose does not remove the worktree until
  they land** (see Dispose). On exhausted retries the run is left
  worktree-intact and flagged for manual recovery rather than disposed.

**Parent lineage.** `PARENT_SNAP` is the last *recorded* snapshot — a
suppressed step is skipped in the chain, never referenced as a parent.
The cursor lives **in executor memory** (no `run_state` column — the
per-step events aren't projected); on cold resume it's recovered by
reading the run's tip ref `refs/swarm/snapshots/<runId>` (its commit is
the last recorded snapshot).

### Re-execution: loops, retries, resumes

A node is **not** a single execution. Edge-cycle and goal-gate loops
re-run the same `nodeId` many times; retries re-dispatch; HITL resumes
re-enter. The design keys on the **fact's monotonic `eventIdx`**, never
on `nodeId`, which keeps this clean:

- **No addressing collision.** Each capture is a distinct `commitSha`
  (content-addressed, parented in execution order) carrying its own
  `eventIdx`. Iteration 7 of a loop node is just another commit on the
  chain under the run's one tip ref — no per-iteration ref to collide.
- **Snapshots track tree deltas, not executions.** A loop iteration
  that changes nothing is delta-suppressed — so a no-op iteration
  records no snapshot. That a step *ran* (and its tokens/cost) is
  carried by the `fact.node_completed` at that turn boundary, which is
  always present; the snapshot stream answers "what changed on disk,"
  the fact stream answers "what ran." The scrubber overlays the two so
  a re-run node that mutated nothing still shows on the timeline (from
  the fact) without a redundant tree entry.
- **Scrubber labels by `(nodeId, eventIdx)`**, since `nodeId` repeats.
  A loop renders as `review · #142`, `review · #189`, … in event order.
- **Retries.** If a node mutates the tree on a failed attempt and the
  retry runs against that dirty tree, only the surviving
  `node_completed` snapshots — the intermediate failed-attempt tree is
  not captured. Acceptable: the recorded tree is the one the next node
  actually sees.

Execution is sequential (no parallel fan-out within a run), so a
per-step snapshot is always exactly one node's delta — attribution is
unambiguous.

### Dispose

Collapses to five steps. No policy:

1. Final snapshot capture (working-tree state including uncommitted),
   reading the sentinel index seeded from the worktree's real index.
2. Capture `final_head_ref` (`symbolic-ref --short HEAD`, "" if detached)
   and `diff_base_sha` (`merge-base base_git_sha HEAD`).
3. If `HEAD != base_git_sha`: `git update-ref refs/swarm/heads/<runId> HEAD`.
4. The terminal `fact.snapshot_recorded` carries `diffBaseSha`, `headRef`,
   and the `committed` / `uncommitted` stats; the projection writes
   `change_stat`, `final_head_ref`, `diff_base_sha`, and (when
   `recoverable`) sets `inbox_status='pending'` in the same transaction.
5. **Only if steps 1–4 succeeded**, remove the worktree dir
   (`git worktree remove` — also deletes the per-worktree gitdir, taking
   the sentinel index with it). If the terminal capture/projection
   failed after bounded retries, **leave the worktree in place** and
   flag the run for manual recovery — never dispose work the inbox
   hasn't been told about.

The B9 fix's `git rev-list <baseGitSha>..HEAD --count` check goes
away in the same PR — recoverability is now structural, not derived.
After this point there is no worktree; all operator actions are
object-DB plumbing per the invariant above.

### Operator actions

Post-terminal. Each maps intent → CLI → fact, and each clears the
inbox:

| Intent | CLI | Fact | Inbox transition |
|---|---|---|---|
| `intent.branch_run`  | `swarm branch <runId> <branch> [--force]` | `fact.run_branched`  | `pending → acted` |
| `intent.commit_run`  | `swarm commit <runId> -m <msg> [--onto <branch>]` | `fact.run_committed` | `pending → acted` |
| `intent.merge_run`   | `swarm merge  <runId> [--ff-only\|--no-ff\|--squash] [--into <branch>]` | `fact.run_merged`    | `pending → acted` |
| `intent.discard_run` | `swarm discard <runId>` | `fact.run_discarded` | `pending → discarded` |

**Invariant: no post-terminal primitive provisions or requires a
worktree.** By terminal the worktree is gone (dispose removed it); the
persisted `refs/swarm/{snapshots,heads}/<runId>` plus the `final_*`
metadata are a complete substitute. Every action is pure object-DB
plumbing — which is also what keeps the two guarantees ("no synthetic
branches, no garbage worktrees") true:

| Action | Plumbing | Promotes | Drops |
|---|---|---|---|
| `branch`  | `update-ref refs/heads/<name> <heads-sha>` | committed history (heads ref) | uncommitted dirt in the snapshot |
| `commit`  | `commit-tree <snapshot-tree> -p <base>` → `update-ref <target>` | full working tree (snapshot, incl. dirt) | workflow-authored commit *history* (flattened to one commit) |
| `merge` ff | `update-ref <target> <heads-sha>` | committed history | uncommitted dirt |
| `merge` no-ff/squash | `merge-tree --write-tree` → `commit-tree` (2 parents) | merged tree | — |
| `merge` w/ conflict | **refuse** → point to `revive` | — | — |
| `discard` | `update-ref -d refs/swarm/snapshots/<runId>` + `refs/swarm/heads/<runId>` | — | everything |

A porcelain `refs/heads/<name>` is written **only** by an explicit
`branch` (or as a `commit`/`merge` target) — nothing swarm does on its
own touches porcelain. The one operation that genuinely needs a
working tree is human conflict resolution; that is `revive` (re-provision
a worktree from any snapshot's `commitSha` — the same primitive as
fork-from-snapshot, operator-owned), kept out of the
automatic path so worktrees never accumulate.

Note the `branch`-vs-`commit` asymmetry: `branch` preserves
workflow-authored *commits* but silently drops uncommitted dirt;
`commit` preserves the full *tree* but flattens history. The CLI/UI
should warn when the chosen primitive would drop the other half
(a non-null `change_stat.committed` alongside a non-null
`change_stat.uncommitted` makes this detectable).

Defaults:

- `--onto` / `--into` → `run_state.base_git_ref`; refuse with
  `"--into required: run was provisioned from detached HEAD"` when
  null, when the ref has moved past `base_git_sha`, or when relocated
  (`diff_base_sha !== base_git_sha` — the run ended on a different line
  than it was provisioned from, so the operator must name the target).
- `--ff-only` is the implicit default for `merge`; non-ff requires
  explicit `--no-ff` or `--squash`. Mirrors `git merge`.
- `-m` precedence: explicit value → auto-titler output → first line
  of `intent.run_started.input` → fail with `"-m required: title not
  available"`.
- `--force` on `branch` mirrors `git branch --force` semantics.

Action composability: `branch`, `commit`, `merge` compose freely (you
can branch a run, then later merge it into main — `inbox_status` stays
`acted`). `discard` is terminal-terminal; subsequent actions fail with
`"run discarded"`.

Read-only inspection:

```
swarm diff  <runId> [--against base|previous|<eventIdx>] [-- <path>]
swarm show  <runId>
swarm inbox [--limit N]    # list runs with inbox_status='pending'
```

### GC

> Status: landed as `swarm gc --snapshots` (operator-invoked), not the
> automatic run-aging sweep originally sketched here. The automatic sweep
> waits on `db-retention.md`'s outstanding `swarm db prune` (run-aging
> doesn't exist yet); ref-GC is deliberately decoupled from row deletion —
> refs are the bulky git objects, rows are tiny, so the run row + event log
> stay queryable after the reclaimable git objects are reclaimed.

```sh
swarm gc --snapshots [--older-than 30d] [--dry-run] [--cwd <repo>] [--db <path>]
# Per eligible run, two refs — not N (see the namespace table):
git update-ref -d "refs/swarm/snapshots/$RUN_ID"
git update-ref -d "refs/swarm/heads/$RUN_ID"
git pack-refs --all   # once, after deletions
```

Eligibility (`store.getGcEligibleSnapshotRuns({ cwd, cutoff })`): the run is
settled (`completed`/`halted`/`cancelled`), in this `cwd`, `updated_at` older
than the window, and `inbox_status != 'pending'`. Deleting the snapshots tip
drops the whole parented chain; next `git gc --auto` reclaims the orphaned
commits + trees + blobs. Retention rule:

- `inbox_status = 'pending'` → kept indefinitely (operator hasn't decided).
- `acted` → kept inside the window so branch/commit/merge can still compose;
  eligible once aged out.
- `discarded` → refs already deleted by the discard primitive (no-op here).
- `NULL` (clean terminal) → eligible once aged out; only the run's
  reclaimable git objects go (the Diff tab then surfaces the existing
  410 "snapshot disposed" path).

**Loose-ref hygiene.** Even at two refs/run, thousands of live runs leave
thousands of loose refs that slow every ref walk. The sweep runs `git
pack-refs --all` after deletions so the live set stays packed; ref *creation*
during a run is unavoidably loose, but a periodic pack keeps the steady state
compact. (The single-tip design already cut the loose count by the per-step
factor — this handles the cross-run residue.)

---

## Server endpoints

Thin wrappers over `git ls-tree` / `git show` / `git diff` against
the run's worktree git dir:

```
GET  /runs?inbox=pending                                         # filtered list
GET  /runs/:id/snapshots
  → ordered list for the scrubber:
    Array<{ eventIdx, nodeId, label, commitSha, treeSha, committed, uncommitted }>
GET  /runs/:id/snapshots/:eventIdx/tree
  → { entries: Array<{ path, mode, size, type }> }
GET  /runs/:id/snapshots/:eventIdx/file?path=<repo-relative>
  → file contents (text/plain or application/octet-stream)
GET  /runs/:id/snapshots/:eventIdx/diff
  ?against=base | previous | <eventIdx>
  &path=<optional>
  → unified diff (text/x-diff) or structured JSON

POST /runs/:id/branch    { branch, force? }
POST /runs/:id/commit    { message, onto? }
POST /runs/:id/merge     { mode?, into? }
POST /runs/:id/discard
```

`:eventIdx` is a URL key, not a ref: the handler resolves it to the
snapshot's `commitSha` from the event log (the list endpoint returns the
mapping) and runs `git ls-tree` / `git show` / `git diff` against that
sha directly. There are no per-eventIdx refs — the single tip ref keeps
every commit in the chain reachable, so a raw-sha query resolves fine.
All read endpoints are pure object-database queries — no checkouts,
no races with the still-running worktree. Action endpoints submit
their respective intents.

---

## UI

### Run detail

**The "Files" tab is removed.** It was reading the live worktree,
which is racy. Replaced by a **"Diff" tab with a per-step scrubber**:
it lists `/runs/:id/snapshots`, lets the operator step through every
boundary that changed the tree (each row labelled with its node), and
diffs the selected snapshot against `base`, `previous`, or any other
snapshot via `/runs/:id/snapshots/:eventIdx/diff`. The default view is
the latest snapshot against `base`. Tab is hidden for bare-cwd runs
(no snapshot data). This is the observability surface the per-step
captures exist for.

A **post-run actions panel** surfaces on terminal runs with
`inbox_status='pending'`: buttons for Branch / Commit / Merge /
Discard, each opening a small form that mirrors the CLI flags.

### Inbox

New top-level view: `/inbox`. Lists runs with `inbox_status='pending'`,
ordered by terminal time descending. Each row shows:

- Run title (from auto-titler)
- `change_stat` badge: `+127 / −14, 8 files`
- Terminal status icon (completed / failed / halted)
- Quick-action buttons (Branch / Commit / Merge / Discard) inline

Acting on a row from the inbox is equivalent to opening the run
detail and using the post-run panel. After action, the row leaves the
inbox (`pending → acted` or `discarded`).

Nav surfaces a badge with the pending count. Clean runs never appear;
they go straight to "history."

### HITL pause

**Preview diff** option on every HITL pause. Uses the embedded
`payload.snapshot.stat` for the first paint ("127 changes across 8
files"), then fetches the unified diff on click. Lets the operator
approve / reject "ship this" with eyes on the actual change.

### Future: inline diff comments → user message

Operator scrolls through a HITL diff, leaves inline comments
(file:line, free text). Comments accumulate as
`intent.diff_comment_added { runId, snapshotEventIdx, path, line,
text }`. On HITL resume, the daemon aggregates pending comments into
a single synthetic user message on the shared thread, formatted as:

```
Review notes:
- src/foo.ts:42 — this branch is unreachable when bar is null
- src/foo.ts:58 — prefer the existing helper in utils/x.ts
- src/bar.test.ts:9 — extend this case to cover the empty input
```

The LLM picks them up as ordinary prompt content. No new tool, no
new schema beyond the intent. Out of scope for v1; design pass when
the v1 surface ships and the UX is concrete.

---

## Where this falls down

- **Crashed-mid-execution recovery.** If a codergen node crashes
  mid tool-call, no terminal fact fires; the snapshot is whatever the
  previous boundary captured. With per-step capture on by default the
  last good boundary is the previous *completed step*, not the previous
  HITL/terminal — crash forks restore to a clean step boundary rather
  than a half-written tree. A `node_started` snapshot would tighten this
  further (capture the current step's starting tree) but doubles capture
  frequency; deferred until a crash-fork consumer asks for it.

- **Bare-cwd runs.** If a workflow runs against the user's primary
  checkout (no daemon-provisioned worktree) and the user has
  uncommitted changes, `git add -A` would capture the user's work
  along with the workflow's. Mitigation: snapshots only fire when
  the run uses a daemon-provisioned worktree (already the default) —
  enforced structurally by the executor's `if (opts.provisioner)` guard.
  Post-run primitives and inbox surfacing are also unavailable.

- **Repos with no commits (unborn HEAD).** `base_git_sha` is empty and
  there's no parent for the first snapshot. The snapshotter must take
  the root-commit path (`commit-tree` with no `-p`) for the first
  capture, and `merge-base` / diff-base logic must tolerate a null base.
  Same family as the `symbolic-ref` null case in Open Questions.

- **Editor co-occupancy.** If the user opens the run's worktree in
  their editor while the agent is mid-edit, the snapshot captures
  whatever was on disk at boundary time — including the user's
  half-saved file. Same hazard as today's in-worktree git operations;
  snapshots don't make it worse.

- **Inbox noise.** Agents touch incidental files (formatting churn,
  generated lockfiles). The `recoverable` gate is structural — "is there
  agent work" — not semantic — "is it *meaningful*." We deliberately
  don't build a meaningful-change classifier (opinionated, fragile, and
  it would hide real changes). The defenses are `.gitignore` (drops
  `.DS_Store` / build output by default), `snapshot_max_blob_bytes`, and
  the fact that the operator sees the diff before acting. If a class of
  runs is reliably noisy, that's a workflow `.gitignore` / `snapshot_keep`
  fix, not a global heuristic.

- **Disk pressure on the worktree dirs themselves.** Orthogonal to
  this proposal. Snapshot refs are bounded by delta bytes; worktree
  dirs (with `node_modules`, build artefacts) are the real disk story
  and need their own treatment.

- **Long-paused runs drift from base.** A run paused for three days
  while `main` advances — its snapshot lineage doesn't rebase. Post-run
  primitives detect drift and refuse non-ff merges without explicit
  mode, but there's no "rebase on wake" story here. Separate proposal.

- **`git lfs` content.** LFS pointers snapshot fine (they're text);
  contents may or may not be in the local object DB. Workflows that
  touch LFS-managed files need explicit policy. Out of scope.

- **Submodules.** Git tracks submodule pointers, not contents.
  Snapshots faithfully capture pointer movement; submodule working
  state isn't captured. Probably fine — swarm rarely touches them.

- **Cross-machine reads.** Snapshots live in the local git object
  database. UI reads via the daemon's local git dir, which is fine.
  Fork-on-another-machine would require pushing the run's tip ref
  `refs/swarm/snapshots/<runId>` (the chain travels with it) somewhere
  reachable. Out of scope.

- **Oversize blobs in long-running codergen runs.** `git add` writes
  blobs to the shared ODB before suppression can decide, so transient
  large files persist until `git gc`. Mitigated in v1 by
  `snapshot_max_blob_bytes` (excludes oversize files before `add -A`)
  plus `.gitignore`. Residual large *tracked* files the operator wants
  captured are the operator's call; `git gc --auto` reclaims anything
  left unreferenced after ref deletion.

---

## Implementation order

Nine steps, each independently shippable:

1. **`base_git_ref` capture + `Provisioner` surface in
   `worktree-provisioner.ts`.** Single `git symbolic-ref` call; persist
   to `run_state.base_git_ref`; add `baseGitRef(runId)`.
   `ExecutionEnvironment` is untouched; the parent-lineage cursor lives
   in executor memory (no `run_state` column). Schema migration + `ARCH §2`.

2. **`snapshotter.ts` in `@swarm/daemon`.** Pure utility wrapping
   the plumbing sequence above (per-worktree `--git-path` index,
   seeded from the real index; `update-ref` retry/backoff); returns
   `{ treeSha, commitSha, ref, headSha, headRef?, diffBaseSha?,
   committed?, uncommitted? }`. Delta-suppression (skip on unchanged
   `treeSha`) lives here. Unit-testable against a fixture git repo —
   include cases for in-workflow `checkout` (relocation) and
   commit-as-you-go. No schema changes.

3. **Wire into the executor** (not the recorder — the executor holds
   `runEnv` + the provisioner and sequences dispatch). After the
   recorder's `node_completed` lands, and at every HITL pause / terminal
   status, the executor calls `provisioner.snapshot(runId, boundary)`
   before the next dispatch and records by bucket: `snapshot.captured`
   observability event per step (delta-suppressed, on by default via
   `snapshot_per_step`) and at HITL; `fact.snapshot_recorded` (OCC) once
   at terminal, driving the projection. Snapshot failure is logged and
   non-fatal. Compute `committed`/`uncommitted` stats at HITL + terminal.
   Same-PR: `packages/types/src/swarm-events.ts`, ARCH §3 (both the
   `fact.snapshot_recorded` fact and the `snapshot.captured` observability
   event), `.agents/skills/swarm-debug/SKILL.md` §4.1 (decode both in the
   event-taxonomy reference).

4. **Extend `fact.run_paused_human.payload`** with the optional
   `snapshot` field. Same-PR: `swarm-events.ts`, ARCH §3,
   `.agents/skills/swarm-debug/SKILL.md` §8.

5. **Server read endpoints.** Handlers in `packages/server/src/`
   wrapping `git ls-tree` / `git show` / `git diff`, plus the
   `/runs/:id/snapshots` list (scrubber feed — reads `snapshot.captured`
   events). One-shot execs; long-lived `git cat-file --batch` is a
   tempting optimisation but premature. The snapshot-list + inbox-list
   SQL go in a dedicated `*-queries.ts` (not inline in routes — store
   discipline). Same-PR: `.agents/skills/swarm-run/SKILL.md`, ARCH §7.

6. **Dispose simplification + projection writes.** Replace the
   porcelain + rev-list recoverability dance in
   `packages/workspace/src/worktree-env.ts:226` with the unconditional
   `refs/swarm/heads/<runId>` update. Project `change_stat` and
   `inbox_status` from the terminal `fact.snapshot_recorded` in the same
   transaction. Remove the B9 fix in the same PR. Grep `packages/` for
   both `fact.run_branched` *and* `run_state.branch` consumers
   (`runs-routes.ts`, `web/src/lib/humanize.ts`, `swarm gc`) — the
   column is repurposed to `final_branch` and the fact becomes
   operator-driven. Same-PR: ARCH §3 (event semantics), `STATUS.md`
   (the preserved-branch story in "What swarm delivers today" changes).

7. **Operator primitives.** Four intent handlers in `@swarm/daemon`
   (branch / commit / merge / discard), four CLI verbs in
   `@swarm/cli`, four HTTP endpoints in `@swarm/server`, four new
   fact types. Inbox transitions wired in the same transaction as
   the action facts. Same-PR: `swarm-events.ts`, ARCH §3 + §7, README
   quick tour (new verbs), `.agents/skills/swarm-run/SKILL.md`.

8. **GC hook.** `packages/store/src/store.ts` retention sweep deletes
   the run's two refs (`refs/swarm/snapshots/<runId>` + `…/heads/<runId>`)
   honouring the `inbox_status`-driven retention rule, then
   `git pack-refs --all` for loose-ref hygiene; the retention query
   lives in a `*-queries.ts`. Same-PR: `docs/proposals/db-retention.md`.

9. **UI: Diff tab with per-step scrubber + HITL preview-diff + post-run
   action panel + Inbox view.** Web-side work reading from (5) and (7).
   The scrubber lists `/runs/:id/snapshots` and diffs the selected
   boundary; the Files tab is removed in this PR. Nav badge for
   pending-inbox count. Same-PR: `.agents/skills/frontend/SKILL.md` if
   it documents the run detail tabs.

(Inline diff comments aggregating into a synthetic user message is a
separate proposal, downstream of (9).)

---

## Open questions

- **Snapshot at `fact.node_started`?** Doubles capture frequency.
  Buys tighter crash-fork honesty (the *current* step's starting tree,
  not just the last completed one). Defer until a crash-fork consumer
  asks for it; per-step `node_completed` capture already covers the
  observability/eval need.

- **Snapshot index in the DB.** Now that per-step capture is the
  default, the `/runs/:id/snapshots` scrubber feed walks the event log
  for every load — at dozens of snapshots per run that walk is real.
  A `snapshots` table (or a generated column on `events`) keyed by
  `(runId, eventIdx)` with `{ treeSha, commitSha, ref, nodeId,
  committed, uncommitted }` makes the list a single indexed SQL query.
  Promote from "defer" to "land alongside step 5" if the event-walk
  shows up in the scrubber's latency.

- **Inbox notifications.** A pending inbox entry could surface as a
  desktop notification, terminal bell on the harness, or webhook —
  natural extension of the inbox concept. Out of scope for v1; the
  UI badge is enough until someone asks.

- **Editor co-occupancy detection.** Could check for `.swp`,
  `.idea/`, VS Code lock files in the worktree at snapshot time and
  annotate the snapshot fact. Probably not worth it; surfaces as a
  passive warning rather than a fix.

- **Cross-platform `git symbolic-ref` edge cases.** Worktrees inside
  worktrees, freshly initialised repos with no commits, repos where
  HEAD points to an unborn branch — all return non-zero from
  `symbolic-ref` and we record null. Acceptable; document in the
  provisioner code.

- **Eval reproducibility pins only the output *tree* here.** Per-step
  snapshots give evals the per-step *tree delta* — what each step
  changed on disk. Two adjacent inputs an eval also wants are **not**
  this proposal's substrate and should land separately:
  - **Per-step LLM input/output** (the prompt sent and completion
    received per step) belongs to the steps/cost surface (the messages
    transcript + `cost_update` / step snapshots), not git refs. If it's
    not already captured per step, that's a `@swarm/server` steps + UI
    cost-breakdown change, tracked on its own.
  - **Input-side pinning** (workflow bytes sha, skill / agent content
    shas, exact model string, swarm version, resolved system prompts).
    Needs its own design pass.
  Worth knowing this proposal is the output-tree half of the eventual
  eval reproducibility story; the I/O and input-pin halves are tracked
  elsewhere.

---

## Contract drafts (ready to apply on land)

Exact text for the same-PR obligations, against the conventions in
`docs/ARCHITECTURE.md §3` and `packages/store/src/schema.sql`. Naming
verified against the live taxonomy: the HITL fact is
`fact.run_paused_human` (payload `nodeId`, `text`, `routes[]`); terminal
facts are `fact.run_completed` / `fact.run_halted` / `fact.run_cancelled`
(there is no `fact.run_failed`).

### ARCHITECTURE.md §3 — Intent events (writer: `web`)

| Type | Payload fields | Semantics |
|---|---|---|
| `intent.branch_run`  | `runId`, `branch`, `force?: bool` | Post-terminal: create porcelain `refs/heads/<branch>` at the run's heads-ref sha. Inbox `pending → acted` |
| `intent.commit_run`  | `runId`, `message`, `onto?: string` | Post-terminal: `commit-tree` the snapshot tree onto `onto` (default `base_git_ref`). `pending → acted` |
| `intent.merge_run`   | `runId`, `mode?: 'ff'\|'no-ff'\|'squash'`, `into?: string` | Post-terminal: merge heads-ref into `into` (default `base_git_ref`); ff is implicit default. `pending → acted` |
| `intent.discard_run` | `runId` | Post-terminal: delete the run's `refs/swarm/{snapshots,heads}/*`. `pending → discarded` (terminal-terminal) |

### ARCHITECTURE.md §3 — Fact events (writer: `daemon`, OCC-checked)

Modify the existing `fact.run_branched` row (it currently fires from
`dispose()` and carries only `branch`):

| Type | Payload fields | Semantics |
|---|---|---|
| `fact.run_branched` | `branch`, `sha` | Response to `intent.branch_run` (no longer dispose-driven). Inbox `pending → acted`. See worktrees.md |

Add the terminal-only fact:

| Type | Payload fields | Semantics |
|---|---|---|
| `fact.snapshot_recorded` | `eventIdx`, `treeSha`, `commitSha`, `parentSnap`, `headSha: string\|null`, `headRef: string\|null`, `diffBaseSha`, `committed`, `uncommitted` | Terminal worktree snapshot. Fires once per run, after the terminal status fact, only when the run uses a worktree provisioner. Reducer projects `final_git_sha`, `final_head_ref`, `diff_base_sha`, `change_stat`, and (when `recoverable`) `inbox_status='pending'` from this payload in the same transaction. Reducer stays pure — the snapshotter precomputed everything. See worktrees.md |
| `fact.run_committed` | `targetBranch`, `sha`, `message`, `parentSha` | Response to `intent.commit_run`. `pending → acted` |
| `fact.run_merged` | `targetBranch`, `mode: 'ff'\|'merge'\|'squash'`, `sha`, `parentShas: string[]` | Response to `intent.merge_run`. `pending → acted` |
| `fact.run_discarded` | `refs: string[]` | Response to `intent.discard_run`. `pending → discarded` |

### ARCHITECTURE.md §3 — Observability events (writer: `daemon`, no OCC)

| Type | Payload fields | Semantics |
|---|---|---|
| `snapshot.captured` | `runId`, `eventIdx`, `nodeId: string\|null`, `treeSha`, `commitSha`, `parentSnap`, `headSha: string\|null`, `headRef?`, `diffBaseSha?`, `committed?`, `uncommitted?` | Per-step (`nodeId` set, delta-suppressed) and HITL (`nodeId` null, carries stats) tree snapshot, addressed by `commitSha`. Skips the reducer, no version bump — the Diff scrubber's feed. Only when the run uses a worktree provisioner |

Also extend the existing `fact.run_paused_human` payload with an optional
`snapshot` object (`treeSha`, `commitSha`, `headSha`, `headRef`,
`baseGitSha`, `diffBaseSha`, `committed`, `uncommitted`) for first-paint
without a roundtrip.

### schema.sql — `run_state` delta

```sql
-- ADD columns:
base_git_ref          TEXT,     -- symbolic-ref --short HEAD of user-cwd at provision; NULL when detached/tag/remote-only
final_git_sha         TEXT,     -- worktree HEAD at last snapshot boundary; NULL pre-terminal
final_head_ref        TEXT,     -- worktree's symbolic-ref --short HEAD at terminal; NULL when detached. Metadata, not a git ref
diff_base_sha         TEXT,     -- sha the terminal diff was computed against; == base_git_sha unless HEAD relocated. relocated ⟺ diff_base_sha != base_git_sha
change_stat           TEXT      -- JSON { committed: {filesChanged,insertions,deletions}|null, uncommitted: {...}|null }; NULL pre-terminal
                        CHECK (change_stat IS NULL OR length(change_stat) < 1024),
inbox_status          TEXT CHECK (inbox_status IS NULL OR inbox_status IN ('pending','acted','discarded')),
final_commit          TEXT,     -- projection: last commit_run sha
merged_into            TEXT,     -- projection: last merge_run target

-- REPURPOSE the existing `branch` column → `final_branch` (projection:
-- last branch_run target). The dispose-preserved-branch semantics are
-- removed (the old comment + the `swarm/runs/<run_id>` convention go away).

-- INDEX for the inbox list (pending, terminal-time desc):
CREATE INDEX IF NOT EXISTS idx_run_state_inbox
  ON run_state(updated_at DESC)
  WHERE inbox_status = 'pending';
```

Bump `CURRENT_SCHEMA_VERSION`; add the step-delta migration in
`packages/store/src/migrations.ts`. `change_stat` is display-only JSON
(no generated column); the queryable inbox driver is `inbox_status`.
