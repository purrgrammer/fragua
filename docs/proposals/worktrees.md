---
title: Worktrees
status: proposed
maturity: designed
last-reviewed: 2026-05-21
---

# Worktrees

> Per-run worktree isolation, tree snapshots at meaningful boundaries
> (observability + diffs + the substrate for evals), and **two** operator
> actions on terminal runs — **accept** and **discard**. `accept` replays the
> run's work onto your current branch and never writes swarm-authored history:
> the workflow's own commits replay verbatim, and any uncommitted tail is
> handed to you staged, for *you* to commit with your own message. Runs that
> leave recoverable work surface in an **inbox**; clean runs disappear quietly.
> Nothing swarm does appears in `git branch` / `git log` unless you ask for it.
>
> Replaces the earlier `worktree-design.md` and `worktree-snapshots.md`.

---

## Why now

Three pains converge on one substrate:

1. **HITL pauses are blind.** `fact.run_paused_human` carries
   `{ nodeId, text, routes[] }`. The operator approving "ship this" has no view
   of *what* they're approving — the worktree is still mounted and may change,
   so there's nothing immutable to diff.

2. **UI files/diff is racy.** The dashboard either reads the live worktree
   (race with the running node) or waits for a commit most workflows never
   make until the very end.

3. **Dispose makes policy it shouldn't.** Today dispose inspects the worktree
   and decides whether to preserve a `swarm/runs/<run_id>` branch — leaking
   synthetic refs into porcelain, with no GC story, and silently dropping work
   when workflows commit in-tree. Operators also have no notification surface
   for "this run finished and left work behind."

Snapshots + two operator actions + an inbox address all three.

---

## Goals / non-goals

**Goals:**
- Per-run worktree isolation (already the default; unchanged).
- Snapshots of tree state at every step (on by default, delta-suppressed),
  HITL pauses, and terminal status — surfaced as a per-step Diff scrubber and
  the per-step tree-delta substrate for evals.
- Two operator actions: **accept** and **discard**.
- `accept` never fabricates a commit. The workflow's real commits replay
  verbatim (message + author preserved); uncommitted work is delivered to you
  staged, and *you* author its commit.
- Runs with recoverable agent work surface in an **inbox**; clean runs and
  read-only reviews don't.

**Non-goals:**
- Auto-created porcelain refs. Nothing swarm writes appears in
  `git branch` / `git tag` / `git log --all` of normal porcelain.
- Swarm-authored history. No generated commit messages, no auto-committed dirt.
- Dictating workflow shape. A workflow may commit in-tree as it goes or leave
  everything dirty; `accept` handles both.
- A **branch** verb (name a run's work without landing it) — deferred follow-up.
- An **`accept --merge`** mode (preserve exact commit shas + topology instead of
  linear replay) — deferred follow-up; see Follow-ups.

---

## Substrate: a detached worktree and at most two refs

The worktree stays on a **detached HEAD** at `base_git_sha` (today's default,
unchanged). No checked-out branch, synthetic or otherwise. A run leaves behind
at most two refs, both under `refs/swarm/` (invisible to `git branch` /
`git log`; reachable by sha for `git diff` / `git show`; kept alive by
`git gc` while referenced):

| Namespace | When | Holds |
|---|---|---|
| `refs/swarm/snapshots/<runId>` | **always** | One tip ref per run. The snapshot chain — tree state at each boundary, wrapped in parented (hidden) commits so the single tip keeps the whole history reachable. The terminal snapshot captures **HEAD + uncommitted dirt**. |
| `refs/swarm/heads/<runId>` | **only when the workflow committed** (`HEAD != base_git_sha` at terminal) | The workflow's real HEAD — the tip of its own commit series. Skipped entirely for dirt-only runs. |

Hidden snapshot commits are *infrastructure* — they exist to keep trees
GC-safe and addressable for the diff scrubber, and never enter your history.
The heads ref points at the workflow's *own* commits, so referencing it
fabricates nothing.

---

## Snapshots (the observability substrate)

Three plumbing commands do the capture:

```
git write-tree         # working-tree state as a tree object
git commit-tree        # wrap a tree as a commit, no ref required
git update-ref <NS>    # pin under refs/swarm/
```

### Capture sequence

After the daemon appends a snapshot-eligible fact, before the next dispatch:

```sh
WORKTREE=<run_state.cwd via worktree-provisioner>
PARENT_SNAP=<previous recorded snapshot commit for this run, or baseGitSha>

cd "$WORKTREE"
# Per-worktree sentinel index (in a LINKED worktree `.git` is a file). Seed it
# from the real index so the stat cache is warm and `add -A` only re-hashes
# changed files; an empty sentinel forces a full-tree rehash.
SWARM_INDEX=$(git rev-parse --git-path swarm-index)
cp "$(git rev-parse --git-path index)" "$SWARM_INDEX"
GIT_INDEX_FILE="$SWARM_INDEX" git add -A
TREE_SHA=$(GIT_INDEX_FILE="$SWARM_INDEX" git write-tree)

COMMIT_SHA=$(git commit-tree "$TREE_SHA" -p "$PARENT_SNAP" -m "swarm:$RUN_ID:$EVENT_IDX")
git update-ref "refs/swarm/snapshots/$RUN_ID" "$COMMIT_SHA"   # bounded retry on packed-refs lock
rm -f "$SWARM_INDEX"
```

The separate `GIT_INDEX_FILE` means snapshotting touches `swarm-index.lock`,
never `.git/index.lock`, so it never collides with a node-body `git add` or
the user's staging. The sentinel lives in the per-worktree gitdir, so a crash
between `add` and `rm` leaks nothing durable (`git worktree remove` deletes it).

`git add -A` writes blobs into the **shared** ODB *before* delta-suppression
can decide anything, so a transient large file bloats the ODB until `git gc`.
`.gitignore` keeps `node_modules` / build output / `.DS_Store` out by default;
**`snapshot_max_blob_bytes`** (v1, default ~10MB) excludes oversize files
*before* `add -A`. A run-level `snapshot_keep` glob force-adds files
`.gitignore` would exclude.

### When to snapshot

- `fact.node_completed` — **per step, on by default** (`snapshot_per_step`).
- `fact.run_paused_human`.
- Every terminal status fact (`run_completed` / `run_cancelled` /
  `run_halted` / …).

Per-step capture is the substrate for **observability and evals** — every
step's tree change is recorded so both the event log and the Diff scrubber can
answer "what did this step change?"

**Delta-suppression.** A per-step snapshot is emitted only when its `treeSha`
diverges from the previous one. Read-only steps cost a seeded stat-walk +
`write-tree` (tens of ms, no new objects on a content hit) and write **no**
fact, ref, or commit. We always probe rather than guess "did a mutating tool
run?" — tools may be user-authored, so the guess is unsound.

**HITL + terminal always record**, even on an unchanged tree (they are
meaningful boundaries). They `commit-tree` a fresh commit so lineage stays
intact, and compute a single change stat against base:

```sh
git diff --shortstat $BASE_GIT_SHA $COMMIT_SHA    # → "8 files changed, 127 insertions(+), 14 deletions(-)"
```

One stat, base→snapshot — there is no committed-vs-uncommitted split to carry,
because `accept` no longer makes a promotion decision from it. HITL embeds the
stat on `fact.run_paused_human.payload.snapshot` for first-paint; terminal
emits `fact.snapshot_recorded`, whose reducer writes the projection.

Never on `cost_update`, `llm.text_delta`, `subagent.*`.

---

## What a terminal run holds

```ts
run_state {
  base_git_sha:  string         // detached HEAD at provision
  base_git_ref:  string | null  // symbolic-ref --short HEAD of user-cwd at provision; null when detached/tag/remote-only
  final_git_sha: string | null  // worktree HEAD at terminal (== base unless the workflow committed); NULL pre-terminal
  change_stat:   { filesChanged: number; insertions: number; deletions: number } | null  // base→terminal-tree; NULL clean / pre-terminal
  inbox_status:  'pending' | 'acted' | 'discarded' | null
  accepted_sha:  string | null  // projection: tip of your branch after the last accept (traceability run→commit)
}
```

`recoverable` is one check — did the run produce commits or dirt:

```
recoverable := final_git_sha != base_git_sha          -- workflow committed
            OR terminal-snapshot-tree != HEAD-tree     -- uncommitted dirt
```

A pure review run that `git checkout`s and reads but edits nothing has neither,
so it stays out of the inbox. (`base_git_ref` is captured for the deferred
`branch` follow-up and for diagnostics; `accept` doesn't target a branch — it
lands on whatever branch *your* checkout is on.)

```
| From | Trigger | To |
| NULL | terminal + recoverable | pending |
| NULL | terminal + not recoverable | NULL (out of inbox) |
| pending | fact.run_accepted | acted |
| pending | fact.run_discarded | discarded |
| acted | further accept | acted |
```

`discarded` is terminal — subsequent actions fail with `"run discarded"`.

---

## The two actions

Both are **post-terminal**, **synchronous**, and operate on the persisted refs
— by terminal the worktree is gone (see Dispose).

### accept — replay the run's commits; you author the tail

The unifying model: a run's output is **a sequence of commits, the last of
which hasn't been authored yet**. `accept` replays that sequence onto your
current branch; the only commit you write is the unauthored tail (the dirt).
The cases you might worry about are the degenerate ends of one algorithm:

| Run produced | Replay (authored commits) | Tail (you author) |
|---|---|---|
| dirt only | — | the whole change → staged for your commit |
| commit series | N commits, messages + authors preserved | — |
| both | N commits preserved | trailing dirt → staged for your commit |

Mechanism — **probe in memory first, mutate only when it's known clean.**
Validated end-to-end against stock git 2.39 (`docs/proposals/worktrees-accept-spike.sh`,
27/27 across dirt-only / commits-only / both × target-at-base / moved / conflict):

```sh
TARGET=$(git rev-parse HEAD)        # your current branch tip
RUNHEAD=<refs/swarm/heads/<runId>, or BASE if the workflow never committed>
SNAPCOMMIT=<terminal snapshot commit (tree = HEAD + dirt), parented on the run line>

# PRE-PROBE — in-memory 3-way of the WHOLE run onto TARGET; no mutation.
# auto-base = merge-base(TARGET, SNAPCOMMIT) = the run's base, so this single
# probe predicts BOTH the replay and the tail. exit != 0 → revive, repo untouched.
git merge-tree --write-tree "$TARGET" "$SNAPCOMMIT"   || revive

if [ "$RUNHEAD" = "$BASE" ]; then
  # dirt-only: stage the merged tree the probe already produced — no cherry-pick
  git read-tree "$MERGED_TREE"; git checkout-index -a -f
else
  # replay the workflow's commits onto your branch (author + message preserved)
  git cherry-pick "$BASE..$RUNHEAD"   || { git cherry-pick --abort; revive; }
  # the unauthored tail = dirt that sat on top of RUNHEAD, staged on top (piped, no temp file)
  if [ "$(tree-of $RUNHEAD)" != "$(tree-of $SNAPCOMMIT)" ]; then
    git diff --full-index --binary $(tree-of $RUNHEAD) $(tree-of $SNAPCOMMIT) \
      | git apply --3way --index   || { git reset --hard "$TARGET"; revive; }
  fi
fi
```

**The pre-probe is the real dry-run.** A single 2-arg `git merge-tree
--write-tree TARGET SNAPCOMMIT` is an in-memory 3-way merge of the *entire* run
(commits + dirt) onto your branch: exit 0 = clean (and hands back the merged
tree, reused directly for the dirt-only case), exit 1 = conflict, **zero
working-tree touch**. `--merge-base` is **not** available on git 2.39, so the
replay can't be a pure-plumbing per-commit merge — it uses `cherry-pick`, with
`--abort` / `reset --hard TARGET` as the backstop for the rare net-clean-but-
per-commit-conflict case. (`git apply --check` only covers a *direct* apply;
`git apply --check --3way` is **not** a dry-run — it returns 0 on conflict and
writes markers. Use `merge-tree`.)

**Conflicts → `revive`.** A probe failure (or the cherry-pick backstop) leaves
your branch and working tree **completely untouched** (verified) and points to
`revive`: re-provision a worktree from the snapshot so you resolve by hand.
`revive` is the same primitive as fork-from-snapshot and is the *only* path
that needs a working tree.

**Preconditions.** `accept` requires a clean-enough working tree on the target
(it advances your branch and stages the tail). If your checkout is dirty it
refuses rather than risk your local changes.

**After accept:** your branch carries the workflow's commits verbatim; the tail
is staged, waiting for *your* `git commit`. `inbox_status → acted` and
`accepted_sha` records the new tip. The tail commit is your finishing move —
the replayed commits are genuinely landed regardless of whether you write it.

**No synthetic commits.** Replayed commits are the workflow's own (a cherry-pick
new sha is a faithful replay, not a fabrication); the tail is *your* commit.
Nothing swarm-authored enters your history.

### discard — delete the run's refs

```sh
git update-ref -d refs/swarm/snapshots/<runId>
git update-ref -d refs/swarm/heads/<runId>      # if present
```

Everything the run produced is dropped. Terminal — subsequent actions fail.

---

## Execution model: synchronous, request-scoped

Post-terminal actions are **not** run execution — the run is over, there's
nothing to schedule. They don't go through the intent → executor → fact loop;
that loop exists because *execution* is async. An action is a synchronous git
operation plus a store write.

- One shared primitive: `applyRunAction(store, gitDir, runId, action)` — runs
  the git plumbing, then writes **one** outcome fact + the projection in a
  single store transaction, and returns the result.
- **Web:** `POST /runs/:id/accept` calls it inline and returns the result in
  the response. No SSE, no polling.
- **CLI:** `swarm runs accept <id>` calls the same primitive directly against
  the local DB (works with the harness down), or hits the endpoint when up.
  Either way it blocks, does it, prints, exits.

This keeps the **store** as the one coordination surface (ground rule 4) — the
daemon is just one writer; any process with store + repo access can act. It
**does** relax "facts are written by the daemon" (ground rule 5): the server
and the CLI both write action facts. That needs an explicit blessing in
SPEC/ARCH as a *synchronous operator-action* event class. WAL serializes the
extra writer; OCC on `run_state` picks a single winner if accept races discard.

**The cost of dropping the single-writer executor** (state it plainly): an
action is a side effect (git) **plus** a store write, and they can't share one
transaction. So:

- **Every action is idempotent.** Re-running `accept` re-probes and re-applies
  (a no-op or clean re-stage onto an already-advanced branch); `discard`
  deleting an absent ref is a no-op.
- **Order is git-first, then store.** If git succeeds and the store write
  crashes, the run stays `pending` and a retry idempotently re-runs git + the
  fact. The reverse (claim `acted`, git fails) would leave a run that *looks*
  landed but isn't — the worst outcome for a system whose job is not losing
  work, so we forbid it.
- The outcome fact records `source: 'cli' | 'web'` (provenance) and the
  resulting commit sha (run → commit linkage).

---

## Who drives snapshots (during the run)

The **executor** drives snapshots (it holds `runEnv` + the provisioner and
sequences dispatch), immediately after the originating fact and **before the
next dispatch** so the captured tree can't be torn:

- after `fact.node_completed` → `snapshot.captured` observability event
  (delta-suppressed; nothing if `treeSha` unchanged);
- at `fact.run_paused_human` → `snapshot.captured` + embed the stat on the
  pause fact for first-paint;
- after a terminal status fact → `fact.snapshot_recorded` (OCC), whose reducer
  writes the projection.

`ExecutionEnvironment` is unchanged (snapshotting is worktree lifecycle, not
file I/O). The `Provisioner` interface gains `baseGitRef(runId)` and
`snapshot(runId, boundary)`. Bare-cwd runs are excluded **structurally** — the
executor snapshots only `if (opts.provisioner)`, and `LocalEnvironment` has none.

**Failure policy by bucket:**
- *Per-step / HITL* (`snapshot.captured`): **non-fatal** — observability must
  never fail a run. Not guaranteed 1:1 with `node_completed`; the scrubber
  tolerates gaps.
- *Terminal* (`fact.snapshot_recorded`): **must land before the worktree is
  removed.** It gates recoverability — losing it would silently drop the dirt
  *and* keep the run out of the inbox. On the OCC path with retry; on exhausted
  retries the run is left worktree-intact and flagged for manual recovery.

---

## Dispose

No policy. Five steps:

1. Final snapshot capture (working tree incl. dirt), sentinel index seeded from
   the real index.
2. If `HEAD != base_git_sha`: `git update-ref refs/swarm/heads/<runId> HEAD`
   (the workflow's real commit series).
3. The terminal `fact.snapshot_recorded` carries `final_git_sha` + the single
   `change_stat`; the projection writes `change_stat`, `final_git_sha`, and
   (when `recoverable`) `inbox_status='pending'` in the same transaction.
4. **Only if 1–3 succeeded**, remove the worktree (`git worktree remove`).
5. On exhausted retries, leave the worktree in place and flag for manual
   recovery — never dispose work the inbox hasn't been told about.

The old porcelain + `rev-list` recoverability dance goes away — recoverability
is now structural (`final_git_sha != base` or dirty tree).

---

## Event taxonomy

**Observability** (writer: daemon, no OCC, skips the reducer):

```ts
type SnapshotCapturedEvent = {
  type: 'snapshot.captured';
  payload: {
    runId; eventIdx; nodeId: NodeId | null;   // null at a HITL pause
    treeSha; commitSha;                        // the addressing key — no per-eventIdx ref
    parentSnap;                                // previous recorded snapshot's commitSha
    headSha: string | null;                    // null when HEAD == baseGitSha
    changeStat?: { filesChanged; insertions; deletions } | null;   // present at HITL
  };
};
```

**Facts** (writer: daemon for `snapshot_recorded`; writer: server **or** CLI for
the actions — synchronous, OCC-checked):

```ts
type SnapshotRecordedFact = {       // fires once per run, after the terminal status fact
  type: 'fact.snapshot_recorded';
  payload: { runId; eventIdx; treeSha; commitSha; parentSnap; headSha: string | null;
             changeStat: { filesChanged; insertions; deletions } | null };
};

type RunAcceptedFact = {            // response to accept; synchronous
  type: 'fact.run_accepted';
  payload: { sha: string;                 // your branch tip after accept
             replayed: number;            // count of workflow commits replayed
             tailStaged: boolean;         // was an uncommitted tail delivered
             source: 'cli' | 'web' };
};

type RunDiscardedFact = {
  type: 'fact.run_discarded';
  payload: { refs: string[]; source: 'cli' | 'web' };
};
```

`fact.run_paused_human.payload` extends with an optional
`snapshot: { treeSha, commitSha, headSha, baseGitSha, changeStat }` for
first-paint.

> **Contract break.** `fact.run_branched` exists today (dispose-driven). It is
> **removed** — there is no `branch` action in v1 (deferred). Grep `packages/`
> for consumers before landing. The `run_state.branch` column is dropped (no
> dispose-preserved branch).

---

## Server endpoints

Thin wrappers over `git ls-tree` / `git show` / `git diff` against the run's
git dir — pure object-DB reads, no checkouts, no worktree races:

```
GET  /runs?inbox=pending
GET  /runs/:id/snapshots                         # scrubber feed: [{ eventIdx, nodeId, label, commitSha, treeSha, changeStat }]
GET  /runs/:id/snapshots/:eventIdx/tree
GET  /runs/:id/snapshots/:eventIdx/file?path=…
GET  /runs/:id/snapshots/:eventIdx/diff?against=base|previous|<eventIdx>&path=…

POST /runs/:id/accept     {}            # 200 with { sha, replayed, tailStaged } or 409 with conflict info → revive
POST /runs/:id/discard    {}
```

`:eventIdx` resolves to the snapshot's `commitSha` from the event log (no
per-eventIdx ref — the single tip keeps the chain reachable). Snapshot-list +
inbox-list SQL live in a dedicated `*-queries.ts` (store discipline).

---

## UI

- **Diff tab with a per-step scrubber** (replaces the racy "Files" tab): lists
  `/runs/:id/snapshots`, steps through every boundary that changed the tree,
  diffs the selected snapshot against `base` / `previous` / any other. Hidden
  for bare-cwd runs.
- **HITL preview-diff** on every pause: first-paint from the embedded
  `payload.snapshot.changeStat`, full diff on click.
- **Inbox** (`/inbox`): runs with `inbox_status='pending'`, terminal-time desc.
  Each row: title, `change_stat` badge (`+127 / −14, 8 files`), terminal-status
  icon, inline **Accept** / **Discard**. Nav badge = pending count. Clean runs
  never appear. Acting from a row ≡ the run-detail panel.
- **Post-run actions panel** on terminal `pending` runs: **Accept** (shows what
  it will do — "replay N commits onto `<branch>`, stage the tail") and
  **Discard**. On an accept conflict, surface the `revive` path. No mode pickers.

---

## Where this falls down

- **Crashed mid-execution.** No terminal fact fires; the last good capture is
  the previous *completed step*. Crash-forks restore to a clean step boundary.
- **Bare-cwd runs.** No provisioner → no snapshots, no inbox, no actions
  (structural via the `if (opts.provisioner)` guard).
- **Unborn HEAD (no commits).** `base_git_sha` empty; first snapshot takes the
  root-commit path (`commit-tree` no `-p`); diff/merge-base tolerate a null base.
- **Editor co-occupancy.** A user editing the worktree mid-run gets their
  half-saved file in the boundary snapshot — same hazard as today's in-worktree
  git ops.
- **`accept` onto a dirty/relocated checkout.** Refuses on a dirty target;
  replays onto wherever HEAD is, so a checkout far from `base` can conflict →
  `revive`. The honest cost of delivering into a real working tree.
- **Replay author identity.** Replayed commits keep whatever author the
  workflow set. Worktrees inherit the repo's `user.name/email`, so these are
  normally *you* — verify when the commit-producing workflow lands.
- **Inbox noise.** `recoverable` is structural ("is there agent work"), not
  semantic ("is it meaningful"). Defenses: `.gitignore`,
  `snapshot_max_blob_bytes`, and the operator sees the diff before accepting.
  Reliably-noisy runs are a workflow `.gitignore` fix, not a global heuristic.
- **Long-paused runs drift from base.** No rebase-on-wake; `accept`'s replay
  meets the drift as conflicts → `revive`. Separate proposal.
- **`git lfs` / submodules / cross-machine reads.** Out of scope (LFS pointers
  snapshot fine; submodule contents aren't captured; snapshots are local).

---

## Open questions

- **Snapshot index in the DB.** Per-step capture means the scrubber feed walks
  the event log per load. A `snapshots` table keyed by `(runId, eventIdx)` makes
  it one indexed query. Promote to "land with the read endpoints" if the walk
  shows up in scrubber latency.
- **Snapshot at `fact.node_started`.** Doubles capture frequency; buys tighter
  crash-fork honesty (the *current* step's starting tree). Defer until a
  crash-fork consumer asks.
- **Inbox notifications** (desktop / terminal bell / webhook). Out of scope; the
  nav badge is enough until asked.
- **Eval reproducibility.** Per-step snapshots are the *output-tree* half. The
  per-step LLM I/O (steps/cost surface) and input-side pinning (workflow bytes
  sha, skill/agent shas, model string, swarm version) are separate tracks.

---

## Follow-ups (deferred, demand-first)

- **`branch <name>`** — name a run's work on a new branch without landing it on
  your current branch. Re-introduces the `accept` replay onto a fresh
  `refs/heads/<name>` instead of HEAD. Cheap once `accept` exists; no consumer
  until someone wants "save it elsewhere."
- **`accept --merge`** — preserve the run's *exact* commit shas + topology via a
  merge commit instead of linear replay. The default (rebase/replay) is correct
  for these commits because they're **private and ephemeral** (never pushed,
  worktree disposed) — rewriting shas loses nothing anyone has seen, and the
  run → commit linkage already lives on the accept fact. Build `--merge` only
  for a concrete need (e.g. a hard merge-only house style).
- **Inline diff comments → user message.** Operator leaves `file:line` comments
  on a HITL diff; the daemon aggregates them into one synthetic user message on
  the shared thread at resume. Downstream of the Diff UI.

---

## Implementation order

Each step independently shippable.

1. **`base_git_ref` capture + `Provisioner` surface** in
   `worktree-provisioner.ts`. Single `git symbolic-ref`; persist to
   `run_state.base_git_ref`; add `baseGitRef(runId)`. Schema migration + ARCH §2.

2. **`snapshotter.ts` in `@swarm/daemon`.** Pure utility wrapping the plumbing
   (per-worktree `--git-path` index seeded from the real index; `update-ref`
   retry/backoff; delta-suppression; single base→tree `change_stat`). Returns
   `{ treeSha, commitSha, headSha, changeStat? } | null`. Unit-testable against
   a fixture repo (commit-as-you-go + dirt cases). No schema changes.

3. **Wire into the executor.** After `node_completed` / at HITL / after
   terminal, call `provisioner.snapshot` before the next dispatch; record by
   bucket (`snapshot.captured` per step + HITL; `fact.snapshot_recorded` at
   terminal driving the projection). Snapshot failure non-fatal except terminal.
   Same-PR: `swarm-events.ts`, ARCH §3 (both event + fact),
   `.agents/skills/swarm-debug/SKILL.md` §4.1.

4. **Extend `fact.run_paused_human.payload`** with the optional `snapshot`.
   Same-PR: `swarm-events.ts`, ARCH §3, swarm-debug §8.

5. **Server read endpoints** (`git ls-tree` / `show` / `diff` + `/snapshots`
   list). Snapshot-list + inbox-list SQL in a `*-queries.ts`. Same-PR:
   `.agents/skills/swarm-run/SKILL.md`, ARCH §7.

6. **Dispose simplification + projection.** Capture `refs/swarm/heads/<runId>`
   when `HEAD != base`; project `change_stat` / `final_git_sha` / `inbox_status`
   from the terminal fact. Remove the porcelain + `rev-list` dance. Drop the
   `run_state.branch` column and `fact.run_branched` (grep consumers:
   `runs-routes.ts`, `web/src/lib/humanize.ts`, `swarm gc`). Same-PR: ARCH §3,
   STATUS.md.

7. **`accept` + `discard` (synchronous).** Shared `applyRunAction(store, gitDir,
   runId, action)`: 2-arg `merge-tree --write-tree TARGET SNAPCOMMIT` probe →
   `cherry-pick base..heads` (dirt-only: `read-tree` the merged tree) → tail
   materialize (`git diff … | git apply --3way --index`, staged) → ff your
   branch; idempotent, git-first, then one fact + projection in a txn. Conflict
   (probe or cherry-pick backstop) → `reset --hard TARGET`, repo untouched. Port
   `docs/proposals/worktrees-accept-spike.sh` (27 cases) as the test matrix. Two
   CLI verbs (`swarm runs accept | discard`, direct DB write, harness-down ok),
   two HTTP endpoints, two facts (`run_accepted`, `run_discarded`) with `source`
   + commit sha. Conflict → 409 / CLI message pointing to `revive`. Same-PR:
   `swarm-events.ts`, ARCH §3 + §7, README quick tour, swarm-run SKILL, and the
   SPEC/ARCH blessing of the synchronous operator-action writer.

8. **`revive`** — re-provision a worktree from a snapshot `commitSha` for
   conflict resolution. Operator-owned; shares the provisioner.

9. **GC hook.** `swarm gc --snapshots` deletes the run's refs honouring the
   `inbox_status` retention rule, then `git pack-refs --all`. Retention query in
   a `*-queries.ts`. Same-PR: `db-retention.md`.

10. **UI:** Diff tab + scrubber, HITL preview-diff, Inbox view + nav badge,
    post-run Accept/Discard panel. Files tab removed. Same-PR:
    `.agents/skills/frontend/SKILL.md` if it documents run-detail tabs.

---

## Contract drafts (ready to apply on land)

### ARCHITECTURE.md §3 — Synchronous operator actions (writer: `server` or `cli`)

A new event class: written **synchronously** by the request handler (server) or
the CLI process, in the same transaction as the projection. Not executor-driven
— the run is terminal, there is nothing to schedule. OCC-checked.

| Type | Payload | Semantics |
|---|---|---|
| `fact.run_accepted` | `sha`, `replayed: number`, `tailStaged: bool`, `source: 'cli'\|'web'` | Replay `base..heads` onto the operator's current branch (linear, messages preserved); stage the uncommitted tail. `pending → acted`; projects `accepted_sha`. See worktrees.md |
| `fact.run_discarded` | `refs: string[]`, `source: 'cli'\|'web'` | Delete `refs/swarm/{snapshots,heads}/<runId>`. `pending → discarded` (terminal) |

### ARCHITECTURE.md §3 — Fact + observability (writer: `daemon`)

| Type | Payload | Semantics |
|---|---|---|
| `fact.snapshot_recorded` | `eventIdx`, `treeSha`, `commitSha`, `parentSnap`, `headSha: string\|null`, `changeStat: {…}\|null` | Terminal snapshot, once per run after the terminal status fact, only with a worktree provisioner. Reducer projects `final_git_sha`, `change_stat`, and (when recoverable) `inbox_status='pending'`. See worktrees.md |
| `snapshot.captured` | `runId`, `eventIdx`, `nodeId: string\|null`, `treeSha`, `commitSha`, `parentSnap`, `headSha: string\|null`, `changeStat?` | Per-step (delta-suppressed) + HITL tree snapshot, addressed by `commitSha`. No OCC, skips the reducer — the scrubber feed. Only with a worktree provisioner |

Also extend `fact.run_paused_human` with optional `snapshot` (`treeSha`,
`commitSha`, `headSha`, `baseGitSha`, `changeStat`).

> **Removed:** `fact.run_branched` (was dispose-driven). No `branch` action in
> v1. Grep `packages/` before landing.

### schema.sql — `run_state` delta

```sql
-- ADD:
base_git_ref   TEXT,     -- symbolic-ref --short HEAD of user-cwd at provision; NULL when detached/tag/remote-only
final_git_sha  TEXT,     -- worktree HEAD at terminal (== base_git_sha unless the workflow committed); NULL pre-terminal
change_stat    TEXT      -- JSON { filesChanged, insertions, deletions }; base→terminal-tree; NULL clean/pre-terminal
                 CHECK (change_stat IS NULL OR length(change_stat) < 512),
inbox_status   TEXT CHECK (inbox_status IS NULL OR inbox_status IN ('pending','acted','discarded')),
accepted_sha   TEXT,     -- projection: your branch tip after the last accept

-- DROP the existing `branch` column (dispose-preserved-branch semantics removed).

-- INDEX for the inbox list:
CREATE INDEX IF NOT EXISTS idx_run_state_inbox
  ON run_state(updated_at DESC) WHERE inbox_status = 'pending';
```

Bump `CURRENT_SCHEMA_VERSION`; add the migration in
`packages/store/src/migrations.ts`. `change_stat` is display-only JSON; the
queryable inbox driver is `inbox_status`.
