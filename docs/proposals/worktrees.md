---
title: Worktrees
status: proposed
maturity: designed
last-reviewed: 2026-05-19
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

1. **HITL pauses are blind.** `fact.run_paused_hitl` carries
   `{ nodeId, label, options[] }`. The operator approving "ship this"
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
- Snapshots of tree state at HITL pauses and terminal status — visible
  in the UI as diffs.
- Operator-driven post-run primitives: branch, commit, merge, discard.
- Terminal runs with non-empty diff vs base surface in an **inbox**;
  clean runs don't.
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
| `refs/swarm/snapshots/<runId>/<eventIdx>` | Written at each snapshot boundary; lineage parented to previous snapshot. |
| `refs/swarm/heads/<runId>` | Live cursor on the worktree's HEAD; updated at each snapshot boundary; survives dispose only when `HEAD != base_git_sha`. |

The snapshot ref captures **tree state including uncommitted dirt**.
The heads ref captures **the worktree's HEAD sha** — workflow-authored
commit history, ready to be promoted by an operator primitive.

### Snapshot capture sequence

After the daemon appends a snapshot-eligible fact, before the next
dispatch:

```sh
WORKTREE=<from run_state.cwd via worktree-provisioner>
RUN_ID=<run_state.id>
EVENT_IDX=<the fact's monotonic index>
PARENT_SNAP=<previous snapshot ref for this run, or baseGitSha>

cd "$WORKTREE"

# Sentinel index — never touches .git/index.
GIT_INDEX_FILE=.git/swarm-index git add -A
TREE_SHA=$(GIT_INDEX_FILE=.git/swarm-index git write-tree)

COMMIT_SHA=$(git commit-tree "$TREE_SHA" \
  -p "$PARENT_SNAP" \
  -m "swarm:$RUN_ID:$EVENT_IDX")

git update-ref "refs/swarm/snapshots/$RUN_ID/$EVENT_IDX" "$COMMIT_SHA"

# Live HEAD cursor: tracks any in-workflow commits.
HEAD_SHA=$(git rev-parse HEAD)
if [ "$HEAD_SHA" != "$BASE_GIT_SHA" ]; then
  git update-ref "refs/swarm/heads/$RUN_ID" "$HEAD_SHA"
fi

rm .git/swarm-index
```

Bounded by delta since the previous snapshot; typically 20–100ms.
`GIT_INDEX_FILE` parallelism means snapshotting doesn't conflict with
concurrent node-body git operations or the user's staging area.

At **HITL pauses** and **terminal status** boundaries, the snapshotter
additionally computes:

```sh
git diff --shortstat $BASE_GIT_SHA $COMMIT_SHA
# → "  8 files changed, 127 insertions(+), 14 deletions(-)"
```

Parsed into `{ filesChanged, insertions, deletions }` and embedded in
the originating fact's payload (HITL) or the snapshot fact's payload
(terminal). Few-ms cost.

### When to snapshot (v1)

- `fact.run_paused_hitl`
- Every terminal status fact (`fact.run_completed`,
  `fact.run_failed`, `fact.run_halted`, etc.)

`fact.node_completed` is **deferred**. Per-node snapshots double
storage on a busy run and the scrubber UI that justifies them doesn't
exist yet. Add behind a per-run config flag when the UI lands.

Never on `cost_update`, `llm.text_delta`, `subagent.*`, or other
high-frequency observability events.

### `.gitignore` and overrides

`git add -A` honours `.gitignore` by default — usually correct. A
run-level `snapshot_keep` glob list converts to `git add --force
<pattern>` before the `-A` for workflows that generate files
`.gitignore` excludes but the operator wants captured.

---

## State shape

```ts
run_state {
  // existing
  base_git_sha:   string

  // new
  base_git_ref:   string | null  // git symbolic-ref --short HEAD at provision; null when detached/tag/remote-only
  final_git_sha:  string | null  // worktree HEAD at last snapshot boundary; NULL pre-terminal
  change_stat:    { filesChanged: number; insertions: number; deletions: number } | null  // diff vs base at terminal; NULL if zero changes or pre-terminal
  inbox_status:   'pending' | 'acted' | 'discarded' | null  // projection (see below)
  final_branch:   string | null  // projection: last branch_run target
  final_commit:   string | null  // projection: last commit_run sha
  merged_into:    string | null  // projection: last merge_run target
}
```

`base_git_ref` is the merge/commit target default. Capture rule:
`git symbolic-ref --short HEAD`. Null when the provisioner finds a
detached HEAD, a tag checkout, or a remote-tracking-only checkout —
in those cases post-run primitives require explicit `--into` / `--onto`.

`change_stat` is computed once at terminal-snapshot time; NULL means
"clean run, nothing to surface." It drives:

- The inbox filter (`change_stat IS NOT NULL` → inbox candidate).
- Run-cards in the dashboard (badge "+127 / −14").
- Retention bumps (keep refs alive past normal GC).

`inbox_status` transitions:

| From | Trigger | To |
|---|---|---|
| `NULL` | terminal fact + `change_stat IS NOT NULL` | `pending` |
| `NULL` | terminal fact + `change_stat IS NULL` | `NULL` (stays out of inbox) |
| `pending` | `fact.run_branched` / `_committed` / `_merged` | `acted` |
| `pending` | `fact.run_discarded` | `discarded` |
| `acted` | further action facts | `acted` (terminal) |

`discarded` is terminal-terminal — subsequent actions fail.

---

## Event taxonomy

One new informational fact for snapshots, four new operator-action
facts, one HITL payload extension.

```ts
type SnapshotRecordedFact = {
  type: 'fact.snapshot_recorded';
  payload: {
    runId:       RunId;
    eventIdx:    number;          // index of the originating fact
    nodeId:      NodeId | null;   // null for terminal/HITL snapshots
    treeSha:     string;
    commitSha:   string;
    ref:         string;          // refs/swarm/snapshots/<runId>/<eventIdx>
    parentSnap:  string;
    headSha:     string | null;   // null when HEAD == baseGitSha
    stat?:       { filesChanged: number; insertions: number; deletions: number };  // present on HITL + terminal snapshots
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

`fact.run_paused_hitl.payload` extends with:

```ts
{
  // existing: nodeId, label, options
  snapshot?: {
    treeSha:    string;
    commitSha:  string;
    headSha:    string | null;
    baseGitSha: string;
    stat:       { filesChanged: number; insertions: number; deletions: number };
  };
}
```

`stat` is embedded so the operator's first paint includes "127
changes across 8 files" without a server roundtrip.

---

## Lifecycle

### Provision

`worktree-provisioner.ensure(runId)` adds:

```sh
BASE_GIT_REF=$(git -C <user-cwd> symbolic-ref --short HEAD 2>/dev/null || echo "")
```

Stored on `run_state.base_git_ref` (null when symbolic-ref fails).

### Snapshot boundaries

Daemon appends `fact.snapshot_recorded` immediately after the
originating fact lands, when the run uses a worktree provisioner.
Sequencing is owned by the daemon — snapshot fires after the executor
writes the originating fact and before the next dispatch, so
torn-state captures aren't possible.

Bare-cwd runs (workflows against the user's primary checkout) emit no
`fact.snapshot_recorded` events; the HITL pause payload's `snapshot`
field is absent.

### Dispose

Collapses to four steps. No policy:

1. Final snapshot capture (working-tree state including uncommitted).
2. If `HEAD != base_git_sha`: `git update-ref refs/swarm/heads/<runId> HEAD`.
3. The terminal `fact.snapshot_recorded` carries `stat`; the projection
   writes `change_stat` and (when non-null) sets `inbox_status='pending'`
   in the same transaction.
4. Remove the worktree dir.

The B9 fix's `git rev-list <baseGitSha>..HEAD --count` check goes
away in the same PR — recoverability is now structural, not derived.

### Operator actions

Post-terminal. Each maps intent → CLI → fact, and each clears the
inbox:

| Intent | CLI | Fact | Inbox transition |
|---|---|---|---|
| `intent.branch_run`  | `swarm branch <runId> <branch> [--force]` | `fact.run_branched`  | `pending → acted` |
| `intent.commit_run`  | `swarm commit <runId> -m <msg> [--onto <branch>]` | `fact.run_committed` | `pending → acted` |
| `intent.merge_run`   | `swarm merge  <runId> [--ff-only\|--no-ff\|--squash] [--into <branch>]` | `fact.run_merged`    | `pending → acted` |
| `intent.discard_run` | `swarm discard <runId>` | `fact.run_discarded` | `pending → discarded` |

Defaults:

- `--onto` / `--into` → `run_state.base_git_ref`; refuse with
  `"--into required: run was provisioned from detached HEAD"` when
  null or when the ref has moved past `base_git_sha`.
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

Retention sweep (lives in `packages/store/src/store.ts`, coordinated
with the run-aging policy in `db-retention.md`):

```sh
git for-each-ref refs/swarm/snapshots/$RUN_ID/ refs/swarm/heads/$RUN_ID \
  --format='%(refname)' \
  | xargs -n1 git update-ref -d
```

Next `git gc --auto` reclaims orphan objects. Retention rule:

- `inbox_status = 'pending'` → keep refs indefinitely (operator hasn't
  decided yet).
- `inbox_status IN ('acted', 'discarded')` → eligible for normal
  run-aging GC.
- `inbox_status IS NULL` (clean terminal) → eligible immediately on
  run-aging.

---

## Server endpoints

Thin wrappers over `git ls-tree` / `git show` / `git diff` against
the run's worktree git dir:

```
GET  /runs?inbox=pending                                         # filtered list
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

All read endpoints are pure object-database queries — no checkouts,
no races with the still-running worktree. Action endpoints submit
their respective intents.

---

## UI

### Run detail

**The "Files" tab is removed.** It was reading the live worktree,
which is racy. Replaced by a **"Diff" tab** that reads
`/runs/:id/snapshots/<latestEventIdx>/diff` against `base`. Tab is
hidden for bare-cwd runs (no snapshot data).

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
  previous boundary captured. Probably right — crash forks restore
  to the last good boundary rather than a half-written tree.

- **Bare-cwd runs.** If a workflow runs against the user's primary
  checkout (no daemon-provisioned worktree) and the user has
  uncommitted changes, `git add -A` would capture the user's work
  along with the workflow's. Mitigation: snapshots only fire when
  the run uses a daemon-provisioned worktree (already the default).
  Post-run primitives and inbox surfacing are also unavailable.

- **Editor co-occupancy.** If the user opens the run's worktree in
  their editor while the agent is mid-edit, the snapshot captures
  whatever was on disk at boundary time — including the user's
  half-saved file. Same hazard as today's in-worktree git operations;
  snapshots don't make it worse.

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
  Fork-on-another-machine would require pushing
  `refs/swarm/snapshots/<runId>/*` somewhere reachable. Out of scope.

- **Oversize blobs in long-running codergen runs.** `max_ms=0`,
  days-long runs over big monorepos accumulate per-snapshot cost
  with the delta. Mitigation: configurable `snapshot_max_blob_bytes`
  per run; oversize files get pointer-replaced or excluded outright.
  v1 ignores this; revisit if disk pressure surfaces.

---

## Implementation order

Nine steps, each independently shippable:

1. **`base_git_ref` capture in `worktree-provisioner.ts`.** Single
   `git symbolic-ref` call; persist to `run_state.base_git_ref`.
   Schema migration + `ARCH §2`.

2. **`snapshotter.ts` in `@swarm/daemon`.** Pure utility wrapping
   the plumbing sequence above; returns
   `{ treeSha, commitSha, ref, headSha, stat? }`. Unit-testable
   against a fixture git repo. No schema changes.

3. **Wire into the recorder.** `packages/daemon/src/recorder.ts`
   appends `fact.snapshot_recorded` after every HITL pause and every
   terminal status fact, when the run uses a worktree provisioner.
   Compute `stat` at HITL + terminal boundaries. Same-PR:
   `packages/types/src/swarm-events.ts`, ARCH §3,
   `.agents/skills/swarm-debug/SKILL.md` §4.1.

4. **Extend `fact.run_paused_hitl.payload`** with the optional
   `snapshot` field. Same-PR: `swarm-events.ts`, ARCH §3,
   `.agents/skills/swarm-debug/SKILL.md` §8.

5. **Server read endpoints.** Three handlers in `packages/server/src/`
   wrapping `git ls-tree` / `git show` / `git diff`. One-shot execs;
   long-lived `git cat-file --batch` is a tempting optimisation but
   premature. Same-PR: `.agents/skills/swarm-run/SKILL.md`, ARCH §7.

6. **Dispose simplification + projection writes.** Replace the
   porcelain + rev-list recoverability dance in
   `packages/workspace/src/worktree-env.ts:226` with the unconditional
   `refs/swarm/heads/<runId>` update. Project `change_stat` and
   `inbox_status` from the terminal snapshot fact in the same
   transaction. Remove the B9 fix in the same PR. Grep `packages/`
   for `fact.run_branched` consumers and gate them on the new
   operator-driven semantics. Same-PR: ARCH §3 (event semantics),
   `STATUS.md` (the preserved-branch story in "What swarm delivers
   today" changes).

7. **Operator primitives.** Four intent handlers in `@swarm/daemon`
   (branch / commit / merge / discard), four CLI verbs in
   `@swarm/cli`, four HTTP endpoints in `@swarm/server`, four new
   fact types. Inbox transitions wired in the same transaction as
   the action facts. Same-PR: `swarm-events.ts`, ARCH §3 + §7, README
   quick tour (new verbs), `.agents/skills/swarm-run/SKILL.md`.

8. **GC hook.** `packages/store/src/store.ts` retention sweep
   batch-deletes `refs/swarm/{snapshots,heads}/<runId>/*` honouring
   the `inbox_status`-driven retention rule. Same-PR:
   `docs/proposals/db-retention.md`.

9. **UI: Diff tab + HITL preview-diff + post-run action panel + Inbox
   view.** Web-side work reading from (5) and (7). The Files tab is
   removed in this PR. Nav badge for pending-inbox count. Same-PR:
   `.agents/skills/frontend/SKILL.md` if it documents the run detail
   tabs.

(Inline diff comments aggregating into a synthetic user message is a
separate proposal, downstream of (9).)

---

## Open questions

- **Per-node snapshot cadence.** Deferred from v1. Trigger to revisit:
  scrubber UI lands or operators ask for "what did this node change?"
  diffs. When added, behind a per-run config flag.

- **Snapshot at `fact.node_started`?** Doubles storage on busy runs.
  Buys crash-fork honesty and "what did this node change?" diffs in
  combination with per-node-completed snapshots. Defer until per-node
  cadence lands.

- **Snapshot index in the DB.** Storing `{ runId, eventIdx, treeSha,
  commitSha, ref }` only in the event log means listing snapshots
  for a run requires walking events. A `snapshots` table (or a
  generated column on `events`) makes list endpoints a single SQL
  query. Defer until the list endpoint exists and walk cost is real.

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

- **Eval reproducibility pins only output here.** Snapshots pin the
  *output* tree of a run; serious evals also need input-side pinning
  (workflow bytes sha, skill / agent content shas, exact model
  string, swarm version, resolved system prompts). Needs its own
  design pass — not a first-release blocker, but worth knowing this
  proposal is half of the eventual eval reproducibility story.
