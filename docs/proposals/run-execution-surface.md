---
title: "Where a run executes — dirty-tree bases and existing checkouts"
summary: "Two opt-in, per-run modes on `fragua run`. `--dirty` bases a fresh worktree on the operator's uncommitted state, captured at enqueue into a synthetic commit anchored at `refs/fragua/bases/<run_id>`; accept lands the run's effect as unstaged changes, path by path, only where each changed path still holds its captured or landed content. `--worktree <path>` executes inside an existing checkout of the same repository, based on the checkout's state when the run first starts; runs on one checkout queue in a FIFO lane that releases on a recorded completion or by `fragua runs release`. Checkout runs never enter the inbox. A run-scoped `FRAGUA_RUN_ID` env var enables per-run branch patterns; fragua never creates branches. Cost: `EVENT_CONTRACT_VERSION` v6 → v7 plus a `schema_version` migration. Supersedes `worktree-opt-out.md`."
status: proposal
maturity: draft
---

# Where a run executes — dirty-tree bases and existing checkouts

> **Status: proposal.** Additive. The default stays as it is: a git-backed run gets a
> fresh detached worktree at `<cwd>/.fragua/worktrees/<run_id>/`, based on a commit.
> This proposal adds two per-run modes, `--dirty` and `--worktree <path>`. They are
> declared only on `fragua run`. It answers GitHub issue #38 and supersedes the parked
> [`archive/worktree-opt-out.md`](archive/worktree-opt-out.md); that draft's four
> blocking findings are answered in [§9](#9-what-this-answers-from-worktree-opt-outmd).
> It interacts with the draft [`workflow-as-step.md`](workflow-as-step.md) only through
> one conditional refusal ([§2](#2-the-declaration-surface)).

**Vocabulary.** A **fresh-worktree run** executes in a per-run worktree that fragua
creates and disposes: today's default, and `--dirty`. A **checkout run** executes in an
existing checkout that fragua did not create: `--worktree <path>`. A **dirty-base run**
is a fresh-worktree run whose base is a synthetic commit. A checkout's **lane** is the
FIFO of checkout runs on it ([§4.3](#43-one-run-per-checkout--the-lane)), and the lane's
**holder** is its unreleased run with the lowest lane sequence. A checkout is **held**
while its lane has a holder. **Ready to land** is the web's name for the inbox: terminal
runs with `inbox_status = 'pending'` (`web/src/routes/Inbox.tsx:5,41`).

## 1. The problem

Every git-backed run records a base commit (`--base <ref>` pinned at enqueue, or the
cwd HEAD at provision). It then runs in a detached linked worktree that it creates and
later disposes, and its work is captured into `refs/fragua/{snapshots,heads}/<run_id>`.
`accept` replays that work onto the operator's HEAD and refuses when the operator's tree
is dirty. Two requests do not fit this model:

1. **Run over a dirty tree.** The operator has uncommitted work and wants a run to
   start from it: "finish this", "write tests for what I have", "review my WIP".
   Today the run starts from HEAD, never sees the WIP, and `accept` refuses to land
   onto the very WIP the operator wanted it built on.
2. **Run inside an existing checkout.** The operator is iterating on one branch
   across runs: feature work, then the PR review comments, then the second round
   of comments. Every run provisions a fresh detached worktree, so the work does not
   accumulate on the branch. A workflow that tries `git checkout feature` inside its
   worktree fails with `already checked out at <path>` because the operator's own
   checkout holds `feature`.

Issue #38 also reports branch collisions. fragua never creates or checks out a branch.
Its only ref writes are under `refs/fragua/*`, and its `worktree add` is `--detach`.
The collisions come from workflows, and they fall into two families:

- **F1.** `git checkout -b X` fails on the second run with `a branch named 'X' already
  exists`. `refs/heads` is shared by every worktree of a repository, so reusing or
  disposing worktrees cannot fix this.
- **F2.** `git checkout X` fails with `already checked out at <path>` when another
  worktree holds `X`. That other worktree is often the operator's main checkout,
  which is the PR-review flow above.

A workflow cannot even name a run-unique branch today. No `FRAGUA_RUN_ID` exists, and
the two substitution tokens (`inputs.` and `outputs.`) do not expose the run id.

## 2. The declaration surface

There are two flags, both on `fragua run` only.

| Flag | Meaning |
|---|---|
| `--dirty` | Fresh per-run worktree, based on the operator's **current uncommitted state** in `run.cwd`'s checkout, captured at enqueue. |
| `--worktree <path>` | **No** per-run worktree. Execute inside the existing checkout that contains `<path>`. The main checkout is `--worktree .`. |

Neither mode can be declared in workflow YAML or in `config.yaml`. Where a run
executes is an operator decision made per invocation, not a property of a portable
workflow or of a project.

**The checkout key.** Every checkout is named by one canonical string: the
`fs.realpathSync.native` of `git -C <dir> rev-parse --show-toplevel`. The `.native`
variant returns the on-disk case on case-insensitive filesystems, so two spellings of
one directory produce one key. `--worktree <path>` stores this key, the lane
([§4.3](#43-one-run-per-checkout--the-lane)) is keyed on it, and every
"is this checkout held?" question compares it. Any directory inside a checkout names
that checkout, so `--worktree .` from a project root that sits in a subdirectory of the
repository names the enclosing checkout's toplevel. `run.cwd`'s own checkout key is
computed the same way, from `run.cwd`.

**Accepted `<path>` values.** `<path>` is accepted iff all of the following hold for its
key `K`:

- `git -C K rev-parse --git-common-dir` equals the common dir of `run.cwd`, so the
  checkout belongs to the same repository.
- `K` is not a fragua-owned worktree of **any** project. That means `K`'s parent
  directory is not a `.fragua/worktrees` directory (the marker `fragua gc --worktrees`
  matches on), and `K` does not equal `<r.cwd>/.fragua/worktrees/<r.run_id>`, after
  `realpath`, for any non-imported run `r` in the store.
- HEAD is born, so the checkout has at least one commit.

The provisioner re-checks all three conditions when it attaches
([§4.1](#41-ownership)), because a path can change between enqueue and start.

**Validation order.** The CLI validates the flags, the path, the born HEAD and the
ignore block first.
For `--dirty` it then reads the held predicate for `run.cwd`'s checkout key and refuses
`checkout_busy` if the checkout is held ([§3.1](#31-capture)). Only then does it
capture. A refusal writes no ref, no event and no `run_state` row. A capture that fails
after that point may leave unreferenced tree and commit objects, which git's prune
reclaims.

**Refused at enqueue.** Each refusal is a CLI error:

| Combination | Why refused |
|---|---|
| `--dirty` + `--base <ref>` | Dirt is relative to the checkout's HEAD, so a second base is contradictory. |
| `--dirty` + `--worktree` | Contradictory: `--dirty` asks for a fresh per-run worktree, and `--worktree` asks for none. A checkout run's base is already the checkout's live state ([§4.2](#42-base-and-snapshots)). |
| `--base <ref>` + `--worktree` | Honouring it would require checking out `<ref>` in a checkout fragua does not own. |
| either flag on a non-git `cwd` | Non-git runs already execute in place, and there is no base to capture. |
| `--dirty` when `run.cwd`'s checkout has an unborn HEAD. The message is `--dirty needs a commit to capture over: <checkout> has no commits yet` | The synthetic base is a commit parented on HEAD ([§3.1](#31-capture)), and the clean-tree test compares against `tree(HEAD)`. This is the same born-HEAD rule `--worktree` applies to its `<path>`. |
| either flag when the target checkout does not ignore the whole fragua block (`.fragua/runs/`, `.fragua/worktrees/`, `.fragua/blobs/`, `.fragua/fragua.db*`, `.fragua/daemon/`; checked with `git check-ignore`) | The agent's own `git add -A` in a checkout would commit the store and sweep sibling run worktrees in as gitlinks. `fragua init` writes the block. |
| `--dirty` when `run.cwd`'s checkout key is **held** ([§4.3](#43-one-run-per-checkout--the-lane)), refused as `checkout_busy` | The capture would freeze another run's half-finished tree. The check is a read of the held predicate immediately before the capture; the window it leaves is an operator-concurrency hazard ([§3.3](#33-accept)). |
| either flag, for a workflow that contains a `type: workflow` step | See below. |

**What the ignore-block check covers.** It is a check on the target checkout at enqueue.
It guards a `--worktree .` run against the agent's `git add -A` sweeping in the store
that lives in that same checkout. For `--worktree ../feature-wt`, `run.cwd`'s store is
not inside the target, so the check only matters if the target holds fragua state of
its own. It is not re-checked after enqueue: a checkout run that switches to a branch
whose `.gitignore` lacks the block loses the protection for the agent's own `git add`.
fragua's own captures are not affected, because they exclude the state directories by
pathspec ([§3.1](#31-capture)).

The flags are also absent from `fragua schedule` and `fragua ci`, whose argument
parsers reject them, and from the web `POST /runs`, whose body has no such fields; it
ignores unknown body fields, so a web client cannot request either mode.

**`type: workflow` steps.** This refusal applies once
[`workflow-as-step.md`](workflow-as-step.md) lands; until then there is no such step to
refuse. That draft lands a parent's work as `baseGitSha..heads/<parent>`, and children
default to the parent's HEAD as their base. Neither mode fits that model:

- a dirty parent's **S** is not on the operator's branch;
- a dirty accept lands only the net effect, so `heads` is never replayed;
- a checkout parent is never in the inbox;
- a child based on the parent's HEAD would miss the dirt;
- a checkout parent writes the operator's tree directly, which E054's
  single-tip-source rule does not model.

Composition with execution modes is a Door ([§7](#7-doors)), and it belongs in that
draft's next revision.

`parallel` nodes need no special rule in either mode, because branch closures are
already read-class (E041/E042).

## 3. Dirty-base runs (`--dirty`)

### 3.1 Capture

**The shared capture helper.** One function in `@fragua/workspace`,
`captureTree({ dir, label, excludes })`, produces a tree object for a checkout's
index + working tree. Every capture in this proposal goes through it: CLI enqueue,
the provisioner's checkout base, and the snapshotter. Accept does not capture
([§3.3](#33-accept)). The snapshotter's `SNAPSHOT_IDENT` moves next to it.

- **`dir` is always a checkout key**, the toplevel, and never `run.cwd`. Every git
  command the helper runs is `git -C <dir>`, and every path that a capture, diff or
  materialisation produces or consumes is relative to that toplevel. A project whose
  `run.cwd` is a subdirectory of the repository therefore captures the whole checkout,
  not its own subtree, and accept writes and unlinks paths against the toplevel.
- **`excludes`** is either empty or exactly these five pathspecs, where `<rel>` is
  `run.cwd`'s path relative to the toplevel (empty when they are equal):

  ```
  :(top,literal,exclude)<rel>/.fragua/runs/
  :(top,literal,exclude)<rel>/.fragua/worktrees/
  :(top,literal,exclude)<rel>/.fragua/blobs/
  :(top,glob,exclude)<rel*>/.fragua/fragua.db*
  :(top,literal,exclude)<rel>/.fragua/daemon/
  ```

  `literal` stops git reading `[`, `*` or `?` in `<rel>` as wildcards. The database
  entry needs `glob` for its trailing `*`, and `literal` and `glob` cannot be combined,
  so `<rel*>` is `<rel>` with `*`, `?`, `[` and `\` backslash-escaped.
  These pathspecs are the §2 ignore block resolved under `run.cwd`'s `.fragua/`. They
  apply only when `run.cwd`'s checkout key equals `dir`; otherwise `run.cwd`'s state is
  not inside the capture and `excludes` is empty. Nothing else under `.fragua/` is
  excluded, so a tracked `.fragua/config.yaml` and `.fragua/workflows/` are captured
  like any other file. The pathspecs make captures independent of the checked-out
  branch's `.gitignore`, even after a checkout run switches to a branch that lacks the
  block.

The helper:

1. Resolves `git rev-parse --git-path <indexName>` and seeds that file with `copyFile`
   of the checkout's real index, as `captureSnapshot` does today
   (`snapshotter.ts:149-155`). Seeding from the real index carries skip-worktree,
   assume-unchanged and sparse entries through unchanged. Seeding from
   `read-tree HEAD` would not, and an untouched checkout would then show a phantom
   diff.
2. Runs `git add -A -- :/ <excludes>` and then `git write-tree` with
   `GIT_INDEX_FILE` set to that file. Untracked non-ignored files are included and
   ignored files are excluded.
3. Removes the index file **and** `<indexName>.lock` in `finally`. The real index and
   HEAD are never touched.

**No sentinel name is ever reused.** `indexName` is
`fragua-index-<label>-<nonce>`, where `<nonce>` is fresh random per call. The
snapshotter and the provisioner pass the run id as `<label>`, so a leftover names its
run; CLI enqueue passes `enqueue`. Today's fixed `fragua-index` (`snapshotter.ts:149`)
and a per-run fixed name both fail the same way: a capture killed by the timeout below
leaves git's `<indexName>.lock` behind, and every later capture under that name fails
on the lock, so a checkout run could never record a snapshot again across retries and
restarts. A per-call name makes a leftover inert, because nothing ever opens it again.

**Leftovers are swept by age.** A process that dies outright (a daemon SIGKILL, or
Ctrl-C on the CLI during an enqueue capture) skips `finally`. Its git child, spawned
detached, keeps running and leaves its sentinel and `.lock` behind when it finishes.
Before each capture, `captureTree` deletes the `fragua-index-*` files in the
checkout's own git dir (the directory `--git-path` resolves into) whose mtime is older
than twice `GIT_PLUMBING_TIMEOUT_MS`. No live bounded capture is that old. Deleting an
orphan's file under it is harmless, because only that orphan uses the name. A fresh
worktree's leftovers also go when `worktree remove` deletes its git dir.

**What an orphaned git process can touch.** A capture's `add -A` and `write-tree`
read the working tree and write only the sentinel index, its `.lock`, and the object
database. They never write the working tree, the real index, HEAD, or a ref. The
objects they write are content-addressed and unreferenced, so git's prune reclaims
them like any unreachable object. The only ref-writing call is the snapshotter's
`update-ref`, a separate process started after the capture returns. An orphaned one
can move `refs/fragua/{snapshots,heads}/<run_id>` only to a commit built from that
run's own tree, which is the chain tip a cold resume reads anyway
(`resolveSnapshotParent`, `snapshotter.ts:123-130`). The CLI's `bases/<run_id>` write
happens in the CLI process after the enqueue commits, so a dead CLI never issues it.
A clean filter that an orphan runs is the repository's own program, and it runs no
differently than it would under a live capture.

**Capture git calls are bounded.** Today the snapshotter's `git()`
(`snapshotter.ts:77`) waits on git for as long as it runs. It and `captureTree` move
onto one runner in `@fragua/workspace`. That covers the capture's `add` and
`write-tree`, and the snapshotter's `commit-tree`, `update-ref`, `rev-parse`,
`merge-base`, `symbolic-ref` and `diff --shortstat`:

- It spawns git `detached`, in its own process group. After
  `GIT_PLUMBING_TIMEOUT_MS` (5 minutes) it sends the group SIGTERM, then SIGKILL two
  seconds later, the same escalation `LocalEnvironment.exec` applies to agent commands
  (`local-env.ts:318-405`). The bound is generous because a legitimate `git add -A`
  over a large untracked tree is slow. The only cost of a long bound is how long a hung
  capture pins its lane.
- A timeout rejects like any other git failure, so a capture that times out is a
  failed capture. The runner settles on the git process's exit, not on its pipes
  closing, so a filter grandchild that escapes the group with `setsid` cannot hold a
  capture open.
- Every capture runs with `-c core.fsmonitor=false -c core.untrackedCache=false`.
  `core.fsmonitor` names a program that git executes, and an agent can write it into
  the repository's shared config from inside its worktree. Clean filters
  (`.gitattributes` + `filter.<driver>.clean`) stay enabled, because they define the
  captured content; an LFS clean filter is what makes a snapshot hold pointers rather
  than blobs. A clean filter that hangs is bounded by the timeout, not disabled.

The bound exists for lane liveness, and a checkout run's terminal path makes no other
git call: its `dispose()` is a no-op ([§4.1](#41-ownership)). So a terminal capture
that hangs ends the holder's fiber as a failed capture, and the holder becomes
operator-releasable ([§4.3](#43-one-run-per-checkout--the-lane)). Every other
fragua git call keeps today's runner, and hardening them is a Door ([§7](#7-doors)).
Those calls are `worktree-env.ts`'s `runGit` / `runGitCapture` (`:294`, `:310`;
`worktree add`, and the `worktree remove` a fresh-worktree dispose runs),
`run-actions.ts`'s `defaultGitExec` (the injectable `GitExec` port behind every
`gitDiff` / `resolveBaseRef` caller), and every accept command. A timeout that killed
`stash push`, `cherry-pick` or a rollback `reset --hard` part-way would leave the
operator's checkout half-written, which is worse than a wait.

**Capturing a dirty base.** The capture happens in the CLI at enqueue, before
`buildEnqueue`, following the `--base` precedent. The base is fixed at the moment the
operator typed the command, not when a daemon picks the run up.

1. Read the held predicate for `run.cwd`'s checkout key through the read plane's
   `checkoutHeld(key)` ([§4.5](#45-the-run-action-gate)). If the checkout is held,
   refuse with `checkout_busy`, naming the holder.
2. Run `captureTree` on `run.cwd`'s checkout, giving tree **T**.
3. If **T** equals `tree(HEAD)`, the tree is clean and the run degenerates to a plain
   HEAD base: `baseGitSha = HEAD` and `baseHeadSha` stays absent. The CLI prints
   `--dirty: tree is clean, using HEAD`.
4. Otherwise, create **S** with `git commit-tree T -p HEAD -m "fragua dirty base"`
   under `SNAPSHOT_IDENT`. Then `baseGitSha = S` and `baseHeadSha = HEAD`.
5. `baseGitRef` is the checkout's symbolic HEAD at capture, or null when HEAD is
   detached. All three values ride the genesis event.
6. After the enqueue commits and returns the run id, the CLI writes
   `refs/fragua/bases/<run_id>` pointing at **S** through the snapshotter's
   `updateRefWithRetry`. The provisioner rewrites the ref idempotently before
   `worktree add`, and the two writes can race. Both write **S**, so either order
   converges, and a lock-contention failure whose ref already reads **S** counts as
   success. A missing **S** object halts the run with `worktree_error`. If the CLI
   crashes between the enqueue and the ref write, **S** is left unreferenced, but
   git's unreachable-object prune grace period covers that window.

Step 1 is a read, not a lock. A new checkout run on the same checkout that is enqueued
and claimed during step 2 can write the tree while it is being captured. That window
is documented with the accept's in [§3.3](#33-accept).

The capture costs what `git add -A` costs on the operator's tree. Large untracked
files are hashed into the object database at enqueue and stay reachable through
`bases/<run_id>` until gc reclaims the ref, so `--dirty` over an untracked build
artefact both delays the enqueue and grows the repository. Ignoring such files is the
operator's remedy.

**S** is an ordinary commit. That is the property everything else depends on.
`worktree add --detach <path> S`, the snapshot parent chain (the first snapshot is
parented on `baseGitSha`), `diff_base_sha`, `git diff A..B`, `run-files.ts`, and the
reducer's `relocated` test all work unchanged. Inside the worktree, the agent sees the
operator's WIP as committed content at HEAD: the index is clean, and files that were
untracked are now tracked. A branch the run creates descends from **S**, so pushing it
publishes the captured WIP, untracked files included.

### 3.2 Identity

| Field | Value for a dirty-base run |
|---|---|
| `base_git_sha` | **S**, the synthetic commit. |
| `base_head_sha` (new) | The operator's HEAD that **S** was captured over (`S^`). Its presence marks the base as synthetic. |
| `base_git_ref` | The operator's branch at capture, or null. |
| `diff_base_sha` | Unchanged rule: `merge-base(base, HEAD)` if the run moved HEAD, else `base_git_sha`. |

`fragua runs diff --against base` diffs `diff_base_sha ?? base_git_sha` against the
snapshot, which is **S** to the snapshot. It shows only the run's work and never the
operator's original dirt. Change stats, the files list and the inbox projection all
work without modification. `change_stat.uncommitted` is measured from the run's HEAD
to the snapshot (`snapshotter.ts`, the `uncommitted` shortstat; ARCH §3
`fact.snapshot_recorded`). In a dirty-base worktree that HEAD is **S**, so the base dirt
never counts as agent work. A dirty-base run enters Ready to land exactly as a
commit-base run does.

### 3.3 Accept

Accept applies the run-action gate in this order, so every refusal is the same on the
CLI and the server:

1. `not_terminal`;
2. `not_in_inbox`, for any run with `inCheckout` ([§4.4](#44-inbox-accept-discard)) and
   for any other run without recoverable work;
3. `discarded`;
4. `no_worktree`;
5. `checkout_busy`, when `run.cwd`'s checkout key is held ([§4.3](#43-one-run-per-checkout--the-lane)).

The first four are `checkGate` (`run-actions.ts:76-87`), shared with discard and
unchanged. `checkout_busy` is not an arm of `checkGate`: `applyAccept` checks the gate's
precomputed `checkoutBusy` input ([§4.5](#45-the-run-action-gate)) after `checkGate`
passes, so discard never sees it.

After the gate, a run with `base_head_sha` **and** a null `checkout_path` takes the
dirty-base path below. Every other run takes today's commit-base path, including the
`--autostash` and squashed-base arms. `checkout_busy` applies to all of these paths,
because each one writes the checkout: `--autostash` runs `stash push` and its rollbacks
run `reset --hard` (`run-actions.ts:188, 256-281`), and a plain accept moves HEAD.
`discard` deletes refs only and never writes the checkout, so it is not busy-gated.
A consequence: while a halted or cancelled checkout run on `run.cwd`'s checkout awaits
`fragua runs release`, every accept into that checkout refuses `checkout_busy`.
`cli.md` and the inbox's refusal text say so and name the holder.

**What the busy read covers, and what it leaves.** `checkout_busy` is a read of the held
predicate, not a lock. It is enough for every case the lane already knows about. Every
existing lane member counts as held: queued, running, paused, quarantined, and terminal
but unreleased. So no accept proceeds into a checkout that a known run may still write.
For a dirty-base accept, step 2's per-path compare below also refuses to land over
any path the run changed that moved since the capture. Three windows remain. Each needs the operator to start
two things at once, and each is documented as an **operator-concurrency hazard** in
`cli.md` and in the accept and `--dirty` refusal help:

- a new `--worktree` run on the same checkout that is enqueued **and** claimed in the
  seconds between the busy read and the end of an accept, or of a `--dirty` capture,
  into that checkout. Both then write one tree;
- two concurrent accepts of one run, from two CLI processes or from the CLI and the
  web. Both pass the gate before either intent folds. This race exists today;
- two stores (a project-local `--db` and the global store) or two bind-mount spellings
  of one checkout. Lanes are per store and keyed on the realpath, so these give one
  checkout two lanes.

A store-side checkout lock that closes the first window is a Door ([§7](#7-doors)). It
opens alongside web enqueue and schedules, which are the writers that can create a
checkout run without the operator typing it. Why it is not in v1 is in
[§8](#8-rejected-alternatives).

**The dirty-base path.** The dirty-base path lands the run's effect as **unstaged
working-tree changes** in `run.cwd`'s checkout, path by path, and only where each path
the run changed still holds what the capture recorded. `dirty_tree` does not apply,
because the run's dirt is its base. The CLI says `--autostash` is ignored for such
runs. Let **S** be `base_git_sha`, **P** be `refs/fragua/snapshots/<run_id>`, and
**D** be the paths that `git diff --no-renames -z --raw S P` reports, each with its
entry in **S** and its entry in **P** (mode and blob, or absent). All paths come from
NUL-separated (`-z`) git output and are handed back to git with `--literal-pathspecs`,
so no path is split on whitespace or read as a glob.

**Every check is per path over D, never a whole-tree recapture.** A path's **disk
state** is read with `lstat` and git's own hashing, and never through ignore rules:

- absent (`ENOENT`, or `ENOTDIR` because an ancestor is not a directory);
- a regular file: mode `100755` when it is executable and `core.fileMode` is true,
  else `100644`, and the blob id from `git -C <key> hash-object -- <p>`, which applies
  the path's clean filter and eol conversion as `git add` does;
- a symlink: mode `120000` and the blob of its `readlink` text
  (`git hash-object --stdin --no-filters`);
- a directory.

A disk state **matches** an entry when both have the same mode and blob, or when the
entry is absent and the path is either absent on disk or a directory that the same tree
holds entries under. With `core.fileMode` false, a regular file matches either regular
mode. The cost is one `hash-object` per regular file in **D**, so it scales with the
run's diff, not with the checkout.

The check cannot use a recapture, because `captureTree` classifies untracked files
through the live checkout's `.gitignore` and `info/exclude`, and step 4 writes **P**'s
`.gitignore` into that checkout. A whole-tree compare would therefore change meaning
under the land:

- a run that adds `dist/` to `.gitignore` over an operator's untracked `dist/` makes
  the post-land recapture drop `dist/`;
- a run that un-ignores a file already on disk, outside **S** → **P**, makes the
  post-land recapture gain it.

Either way the verify would fail, and every re-accept would refuse `checkout_moved`
over a checkout that holds exactly the land. `lstat` and `hash-object` consult no
ignore rules, and paths outside **D** are never read or written.

1. **Refuse a relocated run.** If `diff_base_sha ≠ base_git_sha`, refuse with
   `relocated_base`. The review surfaces (`fragua runs diff`, the inbox files list)
   showed `diff_base_sha` → **P**, so landing **S** → **P** would apply a range the
   operator never reviewed and could delete their WIP. The message prints
   `git diff <S> <P>` for an operator who wants to land by hand. `diff_base_sha` is
   never null here: the `not_in_inbox` gate requires `inbox_status = 'pending'`, which
   only the `fact.snapshot_recorded` fold sets, and that fold always writes
   `diffBaseSha` (`reducers.ts:364`).
2. **Compare.** Read HEAD as **H** and require **H** = `base_head_sha` (that is,
   `S^`); otherwise refuse `checkout_moved`, naming HEAD. Then classify every path in
   **D**:
   - **Already landed.** Every path matches its **P** entry. Skip to step 6 and record
     without writing. A re-accept after a crash between materialising and recording
     lands here.
   - **Landable.** Every path matches its **S** entry or its **P** entry. The common
     case is every path matching **S**. The other case is a land that a crash
     interrupted part-way. Continue to step 3.
   - Otherwise refuse, listing each path that matches neither entry. When any such
     path is absent from **S**, the reason is `checkout_unsafe_path`. That file is on
     disk but outside the captured base, because it was ignored at capture or created
     since, so **S** cannot restore it. An ignored `.env` that the run also wrote as an
     un-ignored file is the typical case. Otherwise the reason is `checkout_moved`.
     Both are retryable once those paths hold their **S** or **P** content, and the
     message names `refs/fragua/bases/<run_id>`.

   Edits outside **D** do not block the land, and the land never touches them. This
   compare is the swap guard. Nothing is computed between it and the write except the
   step 3 checks, which only read.
3. **Refuse what the land cannot write safely.** Refuse with `checkout_unsafe_path`,
   listing the offending paths and writing nothing, when a path in **D**:
   - lies under one of the five state pathspecs of `run.cwd` ([§3.1](#31-capture));
   - is a gitlink (mode `160000`) in **S** or **P**. A deleted initialised submodule
     is the typical case: removing it would delete a working tree that has its own
     `.git`;
   - takes a blob from **P** but is a directory on disk, or has an ancestor on disk
     that is not a directory and that the land does not remove. A directory that the
     run replaced with a file is refused this way, and the operator lands it by hand;
   - is a `.gitattributes` file. Steps 2 and 5 hash through the live attributes, so a
     land that changed them part-way would hash written and unwritten paths under
     different filters.
4. **Materialise P into the working tree only, removals first.**
   - Unlink each path in **D** that **P** lacks and that is present on disk, then
     remove each parent directory that the unlink left empty, up to the toplevel. No
     ignored file is a removal candidate: every path **P** deletes is in **S**, which
     was captured without ignored files.
   - Then write each path in **D** that **P** holds, using `git -C <key>
     --literal-pathspecs restore --source=P --worktree --pathspec-from-file=-
     --pathspec-file-nul`. Removing first lets a file that the run replaced with a
     directory be written in place.
   - HEAD, the branch and the index are not touched. A git or filesystem error stops
     the land and commits no intent, and a re-accept resumes through step 2.
5. **Verify.** Classify **D** again, and require every path to match its **P** entry.
   Otherwise refuse with `land_incomplete`: list the paths that do not, name the
   restore source, and commit no intent. This catches a path that `git restore` skips
   silently, such as a skip-worktree or sparse entry. It also catches an editor write
   that lands after its path was written.
6. **Record.** Commit `intent.accept_run` with
   `{ sha: H, replayed: 0, tailStaged: false, landedUnstaged: true }`.

**The restore source.** For every path in **D**, the path's **S** entry is the
operator's pre-accept content. Step 2 admitted the land only where each path held its
**S** entry or already held its **P** entry, and it refused any path absent from **S**
that held anything else. Paths outside **D** are never written.
`refs/fragua/bases/<run_id>` keeps **S** reachable until gc reclaims it. **Discard
never deletes it.** `applyDiscard` keeps deleting only `snapshots/<id>` and `heads/<id>`
(`run-actions.ts:314-330`), so a discard issued after a crashed land cannot remove the
land's only restore source. Every refusal after step 2, and the success message, name
`refs/fragua/bases/<run_id>`, the landed range **S** → **P**, the paths in **D**, and
the paths the land created. Undoing the land is `git restore --source=<S> --worktree`
over the paths in **D** that **S** holds, plus deleting the created paths.
`git restore --source=<S> --worktree -- :/` is the wrong undo for two reasons: it would
also revert the operator's edits outside **D**, and it does not remove the created
paths, because they are untracked in the operator's index.

**Crash points.** The intent is committed last, so a crash at any point leaves the run
pending in the inbox, and a re-accept goes through step 2 again:

- **During or after the unlinks, before every write finishes.** Each path in **D**
  holds its **S** or its **P** entry, so step 2 classifies the checkout as landable,
  and steps 3–6 finish the land.
- **After step 4 or 5, before the intent commits.** Every path holds its **P** entry,
  so step 2 classifies the checkout as already landed, and step 6 records it without
  writing.
- **During the write of a single file.** The file matches neither entry, so step 2
  refuses: `checkout_moved`, or `checkout_unsafe_path` when **S** lacks the path. The
  message names the path, and its **S** entry, or its deletion, restores it.
- **Ctrl-C.** Accept installs no signal handler, so SIGINT ends the process at an
  arbitrary point. That point is one of the three above.

The remaining overwrite risk is narrow. An editor write to a path in **D**, made
between step 2's read of that path and its write in step 4, is overwritten without
notice. An editor write made after the path's write fails step 5.

**What gets recorded.** `sha: H` follows the squashed-base precedent, which records
`sha: <HEAD at accept>, replayed: 0` (`run-actions.ts:261`). No commit is created, so
HEAD at accept is the honest anchor. `tailStaged: false` is literal, because nothing is
staged. The new optional `landedUnstaged: true` field on `intent.accept_run` and
`fact.run_accepted` tells this land apart from "nothing landed". The fold still reads
only `sha`. The field is threaded through every hop that copies the accept payload:
`buildAcceptRun` in the intent plane, the projection in `operator-actions.ts:55-57`
(which today copies `sha`, `replayed` and `tailStaged` by name), and the server's accept
response. The web's "accepted" line renders it as "landed as unstaged changes".

The index is not touched, so a path the operator had staged keeps its staged version.
After the land, `git diff` shows the run's effect against the index, and
`git diff --cached` still shows the operator's earlier staging.

Any commits the run made in its worktree are flattened into the net effect. They
cannot be replayed faithfully, because their ancestry runs through **S**, and **S** is
not on the operator's branch. `refs/fragua/heads/<run_id>` remains until gc for an
operator who wants to inspect them.

An operator who edited a path that the run also changed gets `checkout_moved`. Edits
to other paths land alongside the run's. Landing over overlapping edits is a three-way
merge, which is a Door ([§7](#7-doors)). The disagreement is recorded in
[§8](#8-rejected-alternatives).

## 4. Checkout runs (`--worktree <path>`)

### 4.1 Ownership

A checkout run executes in a directory it did not create. What it owns:

| Owned by the run | Not owned |
|---|---|
| `refs/fragua/{snapshots,heads,bases}/<run_id>` | The directory and its worktree registration |
| The sentinel index files `fragua-index-<run_id>-<nonce>` and their `.lock` (at `git rev-parse --git-path`), one fresh name per capture, removed when the capture ends or by the age sweep ([§3.1](#31-capture)) | HEAD, the checked-out branch, the real index |
| Exclusive write access to the checkout, from claim until its lane is released ([§4.3](#43-one-run-per-checkout--the-lane)) | The checkout's files before the run started |

The provisioner builds a `WorktreeEnvironment` with `ownership: "operator"`. The
`instanceof WorktreeEnvironment` predicate therefore stays true, and snapshots and the
base keep working. `ProvisionOpts` (`worktree-provisioner.ts:117-128`) gains
`checkoutPath` (the key) and `ownership`, and `ensureRunEnv`
(`dispatch-turn.ts:223-261`) passes both from `run_state` beside today's `cwd` and
`baseRef`. For a checkout run, `create()`'s `isGitRepo` probe
(`worktree-provisioner.ts:292`) runs against the checkout key, not `run.cwd`.
Construction differs from `ownership: "run"` (today's behaviour) in these ways:

- **`init()` attaches and never creates.** It applies the `isExistingWorktree` check to
  the checkout key, with the main checkout counted as registered, and it re-checks the
  [§2](#2-the-declaration-surface) fragua-owned-worktree exclusion and the born HEAD.
  If the path is gone, no longer registered, now fragua-owned, or on an unborn HEAD,
  provisioning fails with a fixed code (`checkout_missing`, `checkout_unregistered`,
  `checkout_fragua_owned`, `checkout_unborn`) and the run halts with `worktree_error`.
  The path is never re-created.
- **The base is adopted on re-attach.** The provisioner passes `baseRef` (today's
  `run_state.baseGitSha` hand-off, `dispatch-turn.ts:230`) and the new `baseHeadSha`
  from `run_state`. When `run_state` already holds a base, `init()` adopts both values
  and captures nothing. It does not recompute `baseGitSha` from HEAD, as the
  `ownership: "run"` arm does. Only a first start captures ([§4.2](#42-base-and-snapshots)).
- **No bootstrap.** The checkout is the operator's, and it is already set up.
- **`dispose()` is a no-op.** `disposeTerminalWorktree` still captures and records the
  terminal snapshot, then disposes nothing. Its code is unchanged.
- **Snapshots are serialised per run.** The provisioner chains each `snapshot(runId)`
  call behind the previous one for the same run (a per-run promise chain beside its
  existing `inflight` map). The chain sits in `provisioner.snapshot`, the one entry
  point that both `captureBoundarySnapshot` and `disposeTerminalWorktree` use. The
  per-capture sentinel names ([§3.1](#31-capture)) already keep two captures off one
  index file, so the chain is not there for index isolation. It is there for order:
  each snapshot's parent is the previous snapshot, and `refs/fragua/snapshots/<run_id>`
  must advance in capture order. Without the chain, a boundary snapshot that started
  before the terminal one could finish after it and move the tip back to an older
  tree. This applies to both ownerships.

A checkout run's provisioning failures report the fixed codes above, followed by git's
stderr, through the existing `errorDetail` handling: the
`daemon.worktree_provisioned{ok:false}` event (`dispatch-turn.ts:240-242`) and the
`worktree_provision_failed: <detail>` halt (`predispatch-planner.ts:97-110`). That text
may name the checkout path, as it already names `run.cwd` and worktree paths for
fresh-worktree runs.

`cwd()` is the checkout key, and that is where tools execute and the `LocalEnvironment`
perimeter is rooted. `projectCwd()` stays `run.cwd`, which carries project identity,
`.fragua/`, and config. The system prompt still never names the path or the run id.

No step of a checkout run's lifecycle runs `reset`, `clean`, `checkout`, `stash`, or
`worktree remove` against the checkout.

### 4.2 Base and snapshots

The base is captured by the provisioner **when the run first starts**, not at enqueue.
A queued checkout run waits behind the lane holder ([§4.3](#43-one-run-per-checkout--the-lane)),
and its honest base is the tree it actually starts from: the previous run's result plus
whatever the operator did in between.

- **Base capture.** On first start, `init()` applies `captureTree` in the checkout,
  giving `baseGitSha` (**S** if dirty, else HEAD) and `baseHeadSha` (set only if dirty).
  It writes `refs/fragua/bases/<run_id>` when **S** is synthetic.
  `baseGitRef` is **the checkout's** symbolic HEAD at that moment, not `run.cwd`'s.
  All three values are stamped onto `fact.run_started`. A crash before that fact
  commits makes the next start capture again and overwrite `bases/<run_id>`, which is
  harmless because nothing yet points at the first capture. A checkout run's
  `run_state.base_git_sha` is null until `fact.run_started` folds, because `--base` is
  refused with `--worktree`; "has a base" and "has started" are the same predicate.
- **Snapshots.** The snapshotter's checkout-run arm differs from the fresh-worktree arm
  in three places:
  - `diff_base_sha = base_git_sha` **always**. `git diff A..B` compares trees and does
    not need ancestry, so the diff is exactly what the run did to the checkout. That
    holds whether the run committed, switched branches, or left everything uncommitted.
  - `refs/fragua/heads/<run_id>` is written iff the checkout's HEAD differs from
    `base_head_sha ?? base_git_sha`. It is informational only and is never replayed.
  - `change_stat.uncommitted` is the shortstat of the base commit to the snapshot (the
    run's whole effect), and `change_stat.committed` is null.

  Delta suppression, the parent chain, and the `fact.snapshot_recorded` cadence are
  unchanged. Boundary snapshots stay observability (`snapshot.captured`), and the
  terminal snapshot is the one `fact.snapshot_recorded`.

A test pins tree equality between a base capture and an immediate snapshot of an
untouched checkout that has skip-worktree, assume-unchanged and sparse entries. A second
test pins that a project in a subdirectory of the repository captures the whole
checkout and excludes only its own five state paths.

**Attribution.** Everything that changes in the checkout between the base capture and
the terminal snapshot is attributed to the run. That includes operator edits made while
the run is paused, and edits made while a crashed daemon was down. The lane is held from
claim until release, and release never precedes the end of the holder's executor fiber,
which is where the terminal snapshot is taken. So a successor's edits can never enter a
predecessor's record.

**Hazard for fresh-worktree runs.** A fresh-worktree run enqueued without `--base`
forks from the cwd HEAD at provision. If a `--worktree .` run holds the main checkout
at that moment, that HEAD includes whatever commits it has made so far. Pin `--base`
to fork from a known commit.

### 4.3 One run per checkout — the lane

**Projected and local fields.** The lane and the busy predicate read these `run_state`
columns:

| Column | Source | Meaning |
|---|---|---|
| `in_checkout` | genesis `inCheckout: true` (portable, folded on import too) | The run executes in an operator checkout. |
| `checkout_path` | written by `enqueueRun` outside the payload; left null by import | The checkout key. A local binding, like `cwd`. |
| `checkout_seq` | assigned inside `enqueueRun`'s `writeTxn`; null by construction on import | The run's position in its lane. A local binding. |
| `checkout_released` | fold, see the release rule below | The lane is free. 0 until then. |

**Lane order.** `checkout_seq` is assigned by the `INSERT` that creates the run's row,
inside the same `writeTxn` as the genesis event, as

```
CASE WHEN :checkout_path IS NULL THEN NULL
     ELSE COALESCE((SELECT MAX(checkout_seq) FROM run_state
                     WHERE checkout_path = :checkout_path), 0) + 1 END
```

Bundle import shares this `insertRunState` statement and binds a null
`checkout_path`, so the `CASE` keeps an imported run's `checkout_seq` null rather than
stamping `1`. SQLite serialises writers, so lane order is commit order. It does not
depend on `enqueuedAt`, which `enqueueRun` reads before the blob spill and before the
transaction opens (`store-writer.ts:339` vs `:396`), and it does not depend on the wall
clock at all. A run whose enqueue commits after a younger-stamped run was claimed is
behind that run in the lane.

No existing value orders runs by commit. `events.seq` is per run. `daemon_events.seq`
is global but is not written by an enqueue. `run_state` has no `INTEGER PRIMARY KEY`,
so its implicit rowid is not stable, and `VACUUM` (`fragua db vacuum`) may renumber
it.

This overrides ARCH §8 inside a lane. ARCH §8's rule is: "Within a priority tier, FIFO
on `ready_at`. `ready_at` is reset to `now()` on every transition INTO `queued`". Its
rejected alternatives include "Preserve original `enqueued_at` on resume — Long-paused
runs jump to front on wake — Starves new submissions". Within a lane the key is
neither: it is `checkout_seq`, fixed at enqueue and never reset. That is deliberate. A
lane admits one writer, so a crash-requeued holder must reclaim its own lane ahead of
younger waiters, and starvation is bounded by the holder finishing or being released.
Across lanes, and for every fresh-worktree run, ARCH §8 applies unchanged.
Consequences:

- `intent.priority_adjusted` has no effect on order within a lane. It still orders a
  lane's claimable head against other lanes and fresh-worktree runs.
- Lane-blocked runs are `queued`, so they count toward the server's `queue_full`
  backpressure, and a long lane can exhaust `maxQueuedRuns`. SPEC's `queued`
  definition ("enqueued; ready to be claimed") is reworded to "ready to be claimed once
  capacity, and for a checkout run its lane, allow".
- ARCH §8's `wait_time_ms = now() - ready_at` would show a lane-blocked run as merely
  slow. For such runs `waitingOn` (below) replaces it in every rendering.

**The release rule.** A lane releases in one of three ways:

- **Automatically on completion.** While folding `fact.snapshot_recorded` on an
  in-checkout run whose status is `completed`, the reducer sets `checkout_released = 1`.
  The fact is the record, so no separate "snapshot settled" column is projected.
- **Automatically when the run never started.** When `fact.run_terminated` folds on an
  in-checkout run whose `base_git_sha` is null, the reducer sets
  `checkout_released = 1`. Such a run never captured a base and never dispatched, so it
  never wrote the checkout. This covers a waiter cancelled while queued (`wakeCancel`
  terminates `queued` runs with `fact.run_terminated`, `wake-pending.ts:63-71`) and a
  pre-dispatch halt such as a first-attach `worktree_error` (`fact.run_terminated`
  with reason `worktree_error`, `predispatch-planner.ts:97-110`).
- **By the operator**, when the reducer folds `fact.checkout_released`.

Every other terminal holder keeps the lane until the operator releases it. That
includes:

- a holder that ends `cancelled` or `halted`, including a leaked-handler halt: reason
  `error` with detail `handler_leaked`, from `planLeakHalt`
  (`predispatch-planner.ts:127-135`);
- a `completed` holder with no recorded terminal snapshot, because its capture failed,
  timed out ([§3.1](#31-capture)) or lost its OCC append, or the daemon died before the
  capture ran. Its work was not recorded, and handing its tree to a successor would
  fold that work into the successor's base unseen.

The terminal set here is `isTerminal` (`completed`, `cancelled`, `halted`). A
quarantined holder is not terminal and keeps the lane. Its exits are
`unquarantine{cancel}` and `fragua runs cancel` ([crash recovery](#crash-recovery)),
after which it is a cancelled holder. Holding the lane through every non-`completed`
end covers three hazards:

- a leaked handler still writing the checkout;
- a successor starting on a tree that a cancelled or halted run left damaged;
- a successor racing the holder's terminal capture.

None of the three needs daemon-side tracking of handler liveness.

**What a crash leaves unrecorded.** Some terminations have no live executor fiber, so
nothing takes their terminal snapshot: a SIGKILL between the terminal fact and the
capture, a `wakeCancel` on a paused run, `unquarantine{cancel}`, and a run the startup
sweep quarantined in SQL. Such a holder shows `release_required`. Its boundary snapshots
(`snapshot.captured`) remain, and its work is in the operator's checkout, so only the
terminal *record* is missing. The same windows leave a fresh-worktree run without a
terminal snapshot today. Releasing over unrecorded work is the operator's call, as it
is for a failed capture.

**Ordering.** The terminal capture runs in `runOneInner`'s `finally`
(`executor.ts:283-287`), after the fiber's status fact has committed:
`fact.run_terminated`, or `fact.run_quarantined` for a quarantine decided in the fiber.
So `fact.snapshot_recorded` always follows the status fact, and both precede the end
of the fiber. A release folded after the fiber ends can never overtake either.

**The operator release.** `fragua runs release <run_id>` commits
`intent.release_checkout` through the intent plane's `buildReleaseCheckout(state)`. It
is the only release surface; there is no server route. The builder refuses
synchronously with:

- `not_checkout_run`, when `in_checkout` is 0;
- `not_terminal`, when `isTerminal(status)` is false;
- `already_released`, when the lane is already free.

The daemon's operator-action sweep folds the intent into `fact.checkout_released` once
the run is `isTerminal` **and** has no live executor fiber. Today that sweep's
candidates are inbox-scoped, and checkout runs are never in the inbox, so it gains a
second candidate statement: unreleased terminal checkout runs that carry an unapplied
`intent.release_checkout`. Release is the operator's assertion that nothing is still
writing the checkout. For a leaked-handler halt, run detail shows the leak.

This departs from ARCH §3's rule that post-terminal operator actions run synchronously
in the caller. Accept and discard can be synchronous because the caller holds
everything the action needs. A release also needs to know that no executor fiber is
still live, and only the daemon knows that. So the CLI's refusals are synchronous, and
the fold is the daemon's.

**The live-fiber set.** No set of runs with a live fiber exists today. The executor
keeps only `inflight` promises (`executor.ts:148-160`). It gains one:

- `runExecutor` holds `const liveFibers = new Set<string>()` beside `inflight`. It adds
  `claimed.runId` as soon as `claimNextRun` returns (`executor.ts:171`), before
  `runOneSafe` starts. `runOneSafe` gains a `finally` that deletes the id. That
  `finally` runs after `runOneInner`'s own `finally` has awaited
  `disposeTerminalWorktree`, so the id leaves the set only once the terminal capture
  has returned or failed.
- `processOperatorActions(store, liveFibers: ReadonlySet<string>)` reads it. The sweep
  runs synchronously in the same loop as the claim (`executor.ts:170`), so the set needs
  no synchronisation.
- The name is `liveFibers`, not `activeRuns`, to avoid a collision with
  `AbortRegistry.activeRuns()`. That registry is no substitute: it holds an entry only
  while a handler's controller is registered (`abort-registry.ts`, "live only while
  handlers are executing"). It is empty between nodes and throughout the terminal
  capture, which is exactly when the release must wait.
- The executor's header comment (`executor.ts:148-156`) says the loop keeps no
  in-process set except for shutdown drain. It is edited to name `liveFibers` as a
  liveness check for release gating, never for capacity. `claimNextRun`'s count stays
  the capacity gate.
- After a restart the set starts empty, which is correct, because no fiber survives
  its process. `startupSweep` requeues a crashed `running` holder, which gets a new
  fiber before it can be terminal again.

The §3.1 timeout bounds every git call that a checkout run's terminal capture makes,
and that run's `dispose()` is a no-op, so every checkout run's fiber ends and a release
always folds eventually. A fresh-worktree run's dispose still runs an unbounded
`worktree remove`, but such a run holds no lane.

**The held predicate.** One named statement in `run-state-queries.ts`,
`CHECKOUT_HELD_SQL(key)`, answers "is checkout `K` held?". It is true iff a run `o`
exists with `o.checkout_path = K`, `o.checkout_released = 0` and `notImportedSql("o")`.
That covers queued, running, paused and quarantined runs, plus terminal runs that are
not yet released. The predicate backs the `checkout_busy` gate input, the `--dirty`
pre-capture check, and the lane.

**The lane predicate.** The lane predicate is added to `SELECT_NEXT_QUEUED_RUN_SQL`
inside `claimNextRun`'s existing `writeTxn`. A queued run `r` is claimable iff:

```
r.checkout_path IS NULL
OR NOT EXISTS (
  SELECT 1 FROM run_state o
   WHERE o.checkout_path = r.checkout_path
     AND o.checkout_released = 0
     AND NOT EXISTS (SELECT 1 FROM imported_runs i WHERE i.run_id = o.run_id)
     AND o.checkout_seq < r.checkout_seq
)
```

The lane holder is the unreleased run with the **lowest `checkout_seq`** on the
checkout. Later runs stay `queued`. They do not consume global capacity, and the claim
skips them for the next claimable run. A partial index on
`run_state(checkout_path, checkout_seq) WHERE checkout_path IS NOT NULL` serves both the
predicate and the `MAX(checkout_seq)` lookup at enqueue. Imported runs never hold a
lane, for two reasons: import leaves `checkout_path` null, and every predicate carries
`notImportedSql` as well.

**`waitingOn`.** The read plane derives `waitingOn: { runId, reason }` for a queued
checkout run that the lane predicate blocks. A run that waits only on global capacity
has no `waitingOn`. `runId` is always the holder. `reason` is a total function of the
holder's `status` and `checkout_released`:

| `reason` | Holds iff | Rendered as |
|---|---|---|
| `active` | the holder is not terminal: `queued`, `running`, any paused status, or `quarantined` | "waiting on checkout `<path>` held by `<run_id>` (`<status>`)" |
| `release_required` | the holder is terminal and `checkout_released` is 0 | "… held by `<run_id>` (`<status>` — release with `fragua runs release <run_id>`)". For a `completed` holder the text adds "its terminal snapshot may still be recording". |

A terminal holder with `checkout_released = 1` is not a holder, so the table is total.
A `completed` holder whose capture is in flight shows `release_required` for those
seconds. The read plane cannot see the daemon's in-memory fiber set, so it cannot tell
that case apart ([§8](#8-rejected-alternatives)). A release issued meanwhile waits for
the fiber to end. If that capture records, the lane releases on its own. If it fails,
the waiting release is what frees the lane. No new `RunStatus` is needed. `fragua runs wait` on a lane-blocked run
blocks for as long as the holder is paused or awaiting release.

<a id="crash-recovery"></a>**Crash recovery.**

- `startupSweep` requeues a crashed `running` checkout run as today. Because it still
  has the lowest `checkout_seq` among unreleased runs on its checkout, it reclaims its
  own lane first. The requeue preserves `current_node` (`reducers.ts`,
  `fact.run_requeued_after_crash`), so the in-flight node re-dispatches into a checkout
  that its earlier attempt partly wrote. That is the same class of non-idempotency as
  the replays refused below. It is accepted here because it is exactly how a
  fresh-worktree run resumes into its retained worktree, and it replays one node, not
  the whole run.
- Quarantine always nulls `current_node` (`reducers.ts:312` and the sweep's quarantine
  SQL). `unquarantine{retry}` and `unquarantine{treat_as_done}` would both re-dispatch
  from the start. `treat_as_done` emits `fact.run_resumed` with a null node. A
  from-start replay re-applies non-idempotent mutations to a tree the operator also
  owns, so both are **refused** for any `in_checkout` run with the intent-plane refusal
  `checkout_replay`. Cancel is the only resolution: `unquarantine{cancel}`, or
  `fragua runs cancel`, whose `intent.cancel_requested` `wakeCancel` already terminates
  on a quarantined run (`wake-pending.ts:63`). The check lives in the intent plane:
  - `buildUnquarantine(body, state: Pick<RunState, "inCheckout">)` takes the run's
    state.
  - `BuildResult`'s failure arm gains an optional `code`, as `ScheduleCreateResult`
    already has.
  - The server route `/runs/:id/unquarantine` reads `readPlane.controlState` (404 when
    absent) and maps `checkout_replay` to 409.
  - The CLI's `unquarantine` verb (`operator.ts`) reads `store.getState`, prints
    `[checkout_replay]`, and exits non-zero.
  - The web `RunQuarantinedNotice` hides its retry and treat-as-done actions when
    `inCheckout` is set, so it never offers an action that would 409.
- **The intent plane is the only guard.** `wakeUnquarantine` is unchanged. No path
  writes `intent.unquarantine{retry|treat_as_done}` around `buildUnquarantine`:
  - `inCheckout` comes from genesis and never changes, so the check has no
    time-of-check window;
  - the migration raises `schema_version`, and an older binary refuses to open a newer
    store (`checkVersion`, `migrations.ts:383-389`), so no pre-v7 CLI or server can
    write the intent;
  - imported runs are inert.

  The existing malformed-resolution skip in `wakeUnquarantine` leaves the skipped
  intent unconsumed, so it shadows every later `intent.unquarantine` of the run. That
  is a separate bug, and its fix is a separate change that emits `intent.dropped`
  ([§8](#8-rejected-alternatives)).

### 4.4 Inbox, accept, discard

A checkout run **never enters Ready to land**. That inbox means "work held aside
awaiting your decision", and a checkout run's work is not held aside: it is already in
the operator's tree. Review therefore happens after the work has landed. The
`fact.snapshot_recorded` fold sets `inbox_status = null` when `in_checkout` is set.
That keys on the portable marker, so an imported checkout run stays out of the inbox
too. Change stats, the files list, and `fragua runs diff` work as for any run, against
the base defined in [§4.2](#42-base-and-snapshots).

`accept` and `discard` therefore refuse with the existing `not_in_inbox` gate, which is
second in the [§3.3](#33-accept) order. The CLI gives this message:

> run executed in checkout `<path>`; its changes are already there — commit them or
> restore with `git restore --source=<base_git_sha> --worktree -- :/`

**gc.** `fragua gc --snapshots` treats a terminal **released** checkout run as settled,
as it treats an accepted or discarded run, and keeps an unreleased holder's refs,
because they are the operator's restore source. Today's eligibility statement selects
every terminal run whose `inbox_status` is not `pending`
(`run-state-queries.ts:469-477`), and a checkout run's `inbox_status` is always null,
so the statement gains one clause:

```
AND (in_checkout = 0 OR checkout_released = 1)
```

`gc.ts`'s per-run ref list (`gc.ts:76`) becomes
`snapshots/<id>`, `heads/<id>` and `bases/<id>`, and `listFraguaRefs` lists all three
namespaces. A dirty-base run's `bases/<id>` is reclaimed by the same rule as its other
refs, and gc is the only thing that reclaims it ([§3.3](#33-accept)).

**Live file paths.** The three sites that resolve a run's live working tree from `cwd`
(`runs-routes.ts:72`, `run-files.ts:149`, `operator.ts:635`) resolve a checkout run's
from `checkout_path` instead.

Run detail shows two badges, both from projected fields threaded through the read-plane
DTO and `server/src/schemas.ts`:

- "in checkout `<path>`" on checkout runs, with "lane held — release with
  `fragua runs release <run_id>`" while `checkout_released` is 0 on a terminal run. The
  badge is read-only; the web has no release action ([§7](#7-doors));
- "dirty base over `<short base_head_sha>`" on dirty-base runs.

### 4.5 The run-action gate

`RunActionGate` gains four inputs. Both gate builders change: the CLI's `readGate`
(`operator.ts`, over `store.getState`) and the server's `readGate` (`routes.ts`, over
`readPlane.controlState`).

| Input | Source |
|---|---|
| `inCheckout` | `run_state.in_checkout` |
| `checkoutPath` | `run_state.checkout_path`, used only for the refusal message |
| `baseHeadSha` | `run_state.base_head_sha` |
| `checkoutBusy` | precomputed by the builder: the checkout key of `run.cwd`, then `CHECKOUT_HELD_SQL` through a new read-plane method `checkoutHeld(key)` |

`checkoutBusy` is accept-only. `applyAccept` reads it after `checkGate` passes, and
`applyDiscard` ignores it ([§3.3](#33-accept), which also lists the windows a read
leaves). For a dirty-base accept the authoritative guard is step 2's per-path compare. For a commit-base accept, the read is
the only guard, and the window it leaves is the documented operator-concurrency hazard.
`RunActionExec` (`server/src/ports.ts:17`) keeps its signature: `accept(gate)` and
`discard(gate)` take the wider gate.

`controlState` gains `inCheckout`, `checkoutPath`, `baseHeadSha` and
`checkoutReleased`.

## 5. Per-run branches — `FRAGUA_RUN_ID`

fragua does not create, name, switch, or delete branches. It closes the F1 gap with
one enabler and two documented patterns.

- **`FRAGUA_RUN_ID` is a run-scoped engine variable.** Today `FRAGUA_OUTPUT` is per-exec
  `opts.env` from the tool handler (`tool.ts:405`), and the agent's bash tool passes no
  env (`tools.ts:402`), so there is no run-scoped seam. The seam is a new constructor
  option `engineEnv: Readonly<Record<string, string>>` on `LocalEnvironmentOptions`.
  `WorktreeEnvironment` forwards it to its inner `LocalEnvironment`. `exec` merges it
  after the allow-list filter and before per-exec `opts.env`, so `FRAGUA_OUTPUT` still
  wins on its own key. The `WorktreeProvisioner` class sets `{ FRAGUA_RUN_ID: runId }`
  on every environment it builds: the non-git `LocalEnvironment`, and both
  `WorktreeEnvironment` ownerships. Every `bash` tool call and every `tool` step
  process therefore sees it. That includes `fragua ci`, which constructs its own
  `WorktreeProvisioner` (`ci.ts:203`); the variable is set inside the class, so `ci`
  needs no change. The change touches:
  - `@fragua/workspace` `local-env.ts` and `worktree-env.ts` (the option and the merge);
  - `@fragua/daemon` `worktree-provisioner.ts` (setting it);
  - `@fragua/core` `types/execution.ts` (the contract doc: engine-scoped vars are
    applied on every exec, beneath per-exec `env`).

  `tools.ts` needs no change, because bash routes through `env.exec`. The variable is
  engine-set, not operator env, so the deny-by-default env policy does not strip it.
  It never appears in the system prompt. A prompt that says "work on branch
  `agent/$FRAGUA_RUN_ID`" passes that text through literally (a bare `$name` is literal
  under ground rule 13), and the shell expands it.
- **The documented F1 pattern** for a workflow that wants its own branch is
  `git switch -c "agent/$FRAGUA_RUN_ID"`. Such branches persist in the shared
  `refs/heads`. fragua's gc never touches `refs/heads`, so pruning them is the
  operator's job.

  **Such a run lands through its branch, not the inbox.** The inbox fold counts
  committed work as the run's own only when the run ended detached
  (`committedIsAgentWork` requires `headRef === null`, `reducers.ts:376`). A run that
  follows the F1 pattern and commits everything therefore gets `inbox_status = null`:
  it does not enter Ready to land, and `accept` refuses it. This is today's behaviour
  for every run that ends on a named branch, and it is unchanged. The operator lands
  the work as in the F2 flow below, by merging or opening a PR from
  `agent/<run_id>`. gc may reclaim the run's `refs/fragua/*` refs once it is settled;
  the branch in `refs/heads` holds the work. The fold cannot tell the run's own
  commits from commits it checked out under a run-named branch
  (`git switch -c "agent/$FRAGUA_RUN_ID" origin/pr-123`), which is the review-run case
  the guard at `reducers.ts:367-376` exists to stop. Admitting branch-committed runs
  to the inbox needs a sound authorship criterion, and that is a Door
  ([§7](#7-doors)).
- **The documented F2 pattern** is the PR-review flow. Iterate *on* the branch with a
  checkout run, rather than having a detached run check the branch out:

  ```sh
  git worktree add ../feature-wt feature                     # once
  fragua run work   --worktree ../feature-wt --input task=…  # feature work
  fragua run review-fixes --worktree ../feature-wt --input pr=123
  fragua run review-fixes --worktree ../feature-wt --input pr=123
  ```

  The three runs queue in one lane, and each starts from the previous one's result. A
  run that halts or is cancelled holds the lane until `fragua runs release`. The
  operator commits and pushes from `../feature-wt` whenever they choose. Running
  `--worktree .` on the main checkout works the same way when the operator is on
  `feature` there.

## 6. Contract, schema, and docs

**Event contract.** `EVENT_CONTRACT_VERSION` is bumped from 6 to 7. The bump is carried
by the genesis `inCheckout` / `baseHeadSha` fields, the release intent/fact pair, and
the reducer's inbox and release changes. The contract changes are:

- **Genesis fields.** `intent.run_enqueued` gains the optional `inCheckout: true` and
  `baseHeadSha`. The checkout path is **not** a genesis field. The genesis contract
  excludes local bindings (`events.ts:364-368`), so the path is no contract field of
  the log or of a bundle, and it stays away from the I7 payload cap. Diagnostic text
  can still name it, as it names `run.cwd` today ([§4.1](#41-ownership)). `enqueueRun` writes it to
  `run_state.checkout_path` from `EnqueueRunParams`, outside the payload, as it does
  `cwd`, and assigns `checkout_seq` in the same insert.
- **`fact.run_started`** gains the optional `baseHeadSha`.
- **New types:** `intent.release_checkout` and `fact.checkout_released`, added to the
  `IntentEvent` and `FactEvent` unions.
- **`intent.accept_run` and `fact.run_accepted`** gain the optional `landedUnstaged`.
- **Reducer:**
  - the genesis seed reads `inCheckout` and `baseHeadSha`;
  - `fact.run_started` seeds `baseHeadSha`;
  - `fact.snapshot_recorded` nulls the inbox for `in_checkout` runs and sets
    `checkout_released = 1` on a `completed` in-checkout run;
  - `fact.run_terminated` releases an in-checkout run whose `base_git_sha` is null;
  - `fact.checkout_released` sets `checkout_released = 1`.

  Every arm keys on `in_checkout`, which no run pinned below v7 can carry, so re-folding
  an existing log cannot change its projection.

`MIN_COMPATIBLE_CONTRACT_VERSION` is unchanged. The schema migration below raises
`schema_version`, and an older binary refuses to open a store at a newer version
(`checkVersion`, `migrations.ts:383-389`). So no older daemon ever claims a
lane-blocked waiter, and no older CLI or server writes around the new intent-plane
refusals. The store, contract and lane changes ship in the same release as the CLI
flags.

[`workflow-as-step.md`](workflow-as-step.md) also bumps `EVENT_CONTRACT_VERSION`.
Whichever of the two lands second renumbers its bump and its ARCH §1.11 entry.

**Schema.** One `schema_version` migration adds:

- the `run_state` columns `in_checkout INTEGER NOT NULL DEFAULT 0`,
  `checkout_path TEXT`, `checkout_seq INTEGER`, `base_head_sha TEXT`, and
  `checkout_released INTEGER NOT NULL DEFAULT 0`;
- the lane index from [§4.3](#43-one-run-per-checkout--the-lane).

Its `down` step drops both. It is marked `lossy`, because `checkout_path` and
`checkout_seq` are not recoverable from the log. `deriveRunState` comparisons treat
`checkout_path` and `checkout_seq` as local bindings, exactly as they treat `cwd`.

**Tests.** The change ships with these tests:

- Bundle import: an imported non-terminal checkout run has a null `checkout_path` and
  `checkout_seq` (the `CASE` in the shared insert), holds no lane, and wedges neither
  the `--dirty` pre-capture check nor `checkout_busy`.
- The two capture tests from [§4.2](#42-base-and-snapshots): equality on an untouched
  checkout, and a subdirectory project, including a `<rel>` that contains `[` and `*`.
- Bounded git and sentinel names:
  - a capture whose clean filter hangs past the timeout fails, ends the holder's fiber,
    and a subsequent `runs release` folds;
  - a capture killed by the timeout leaves neither its sentinel index nor its `.lock`,
    and the run's next capture succeeds;
  - a `fragua-index-*` file older than twice the timeout is swept before the next
    capture in that git dir, and a younger one is left alone;
  - a boundary snapshot that finishes after the terminal snapshot started never moves
    `refs/fragua/snapshots/<id>` past it;
  - a repository config with `core.fsmonitor` set to a script does not run the script
    during a capture.
- `--dirty` on an unborn HEAD refuses with no ref, event or row written.
- Lane tests:
  - FIFO by `checkout_seq`;
  - an enqueue with an older `enqueuedAt` that commits after a younger run on the same
    checkout was claimed is not claimable;
  - a `completed` holder whose terminal capture failed blocks until release;
  - a halted holder blocks until release;
  - a cancelled-while-queued waiter neither blocks its successors nor is snapshotted;
  - a first-attach `worktree_error` halt does not wedge the lane.
- Release tests:
  - an `intent.release_checkout` on a terminal holder whose id is in `liveFibers` stays
    unapplied, and folds on the first sweep after the id leaves the set;
  - a terminal holder with no live fiber and no terminal snapshot (sweep-cancelled while
    paused) folds on release;
  - the three `buildReleaseCheckout` refusals.
- Dirty-accept tests:
  - `checkout_moved` on a moved HEAD, and on an operator edit to a path in **D**;
  - an operator edit to a path outside **D** survives the land, and does not block it;
  - `relocated_base`;
  - removals limited to the paths in **D** that **P** lacks;
  - the run adds `dist/` to `.gitignore` over an operator's untracked `dist/`: the land
    verifies and records, and `dist/` is untouched;
  - the run un-ignores a file that is on disk outside **D**: the land verifies and
    records;
  - `checkout_unsafe_path` for an un-ignored `.env` written by the run over an ignored
    `.env` on disk, for a deleted initialised submodule, and for a changed
    `.gitattributes`;
  - a file the run replaced with a directory lands;
  - `land_incomplete` when a skip-worktree path is not written;
  - a crash after the unlinks and before the `restore`: re-accept finishes the land;
  - a crash after the writes and before `plane.commit`: re-accept records
    `landedUnstaged` without writing;
  - `discard` of a dirty-base run leaves `refs/fragua/bases/<id>` in place;
  - commit-base and `--autostash` accepts refused under `checkout_busy`, and discard
    not refused.
- A gc test: an unreleased terminal checkout run's refs survive the cutoff, and a
  released one's `snapshots`, `heads` and `bases` refs are reclaimed.
- Intent-plane tests: `checkout_replay` for both `retry` and `treat_as_done`, on the
  CLI verb and on the server route.

**New literals**, each swept across `packages/` per ground rule 1, including the CLI
exit-code map and the server's 409 passthrough:

- `AcceptResult` reasons: `checkout_busy`, `checkout_moved`, `relocated_base`,
  `checkout_unsafe_path`, `land_incomplete`.
- Intent-plane refusals: `checkout_replay` (unquarantine), and `not_checkout_run`,
  `not_terminal`, `already_released` (checkout release).
- The `waitingOn.reason` values `active` and `release_required`.

No new `RunStatus`, `HaltReason`, `PauseReason`, or `inbox_status` value is added.

**Code sweep beyond the literals:**

- the `IntentEvent` / `FactEvent` unions in `@fragua/types` for the two new types;
- the contract-surface snapshot (`store/test/contract-surface.snapshot.json`) and the
  `reducers.ts` touch-gate marker (`scripts/check-contract-bump.sh`);
- `FEED_EVENT_KINDS` and the web's query-invalidation sets, so `fact.checkout_released`
  refreshes run detail and lane-blocked waiters;
- the ARCH §10 property generators: P4 (projection = fold) over the new facts and
  genesis fields, and P7 (unquarantine retry) restricted to non-checkout runs, with a
  checkout-run case asserting the refusal.

**New ref namespace.** `refs/fragua/bases/<run_id>`. `gc.ts` lists and reclaims it
([§4.4](#44-inbox-accept-discard)). `applyDiscard` does not delete it
([§3.3](#33-accept)).

**Docs edited on ship:**

- `execution-model.md`:
  - §1 (where a run executes: three modes);
  - §2c (`FRAGUA_RUN_ID` beside `FRAGUA_OUTPUT`);
  - §3 lifecycle table (Provision and Dispose rows per mode);
  - §4 (the checkout diff base);
  - §5 (the worktree is the only tracked surface *for a fresh-worktree run*; a checkout
    run tracks its checkout);
  - §6 (the clean-tree requirement applies to commit-base runs only; dirty-base accept
    requires each path the run changed to hold its captured or landed content, and
    leaves every other path alone; checkout runs are not landed; the lane and
    `runs release`);
  - §8 diagram.
- SPEC:
  - §1, the inbox framing: a checkout run lands during execution, so its review
    happens after the work has landed;
  - the `queued` status definition: ready to be claimed once capacity, and for a
    checkout run its lane, allow;
  - §3.4, the quarantine resolutions: `retry` and `treat_as_done` are refused for
    checkout runs;
  - §3.8, the Pinned worktree base paragraph: `--dirty` and `--worktree`;
  - §5, the version sentence: `EVENT_CONTRACT_VERSION` is at 7, with this proposal
    added to the reason list;
  - §5, sandboxing: a checkout run has no working-tree isolation. A main-checkout run
    can also read and write sibling run worktrees under `.fragua/worktrees/`.
    `FRAGUA_RUN_ID` is a run-scoped engine var beside the per-step `FRAGUA_OUTPUT`;
  - the `worktree_error` halt description, here and in its `events.ts` JSDoc: it also
    covers a checkout re-attach failure on resume, after the first `run_started`.
- `SECURITY.md` §4: the same isolation and engine-var notes as SPEC §5. Under trusted
  party 2, a `--worktree .` run can rewrite the live `.fragua/workflows/` and
  `.fragua/config.yaml` without review, and a project-local store under `.fragua/` sits
  inside its perimeter. The capture's `core.fsmonitor=false` hardening is listed with
  the reason, and so is its scope: it covers captures only. A dirty-base accept's
  `hash-object` and `git restore` run the repository's clean and smudge filters from
  its shared config, as today's `cherry-pick` accept already does.
- ARCH:
  - §1.1, the quarantine resolutions (as SPEC §3.4);
  - §1.11, the contract-version history (the v7 entry);
  - §2, the schema (the five columns and the lane index), and the `run_state` row's
    O(log N) claim wording: a lane-blocked candidate adds one probe of the lane index;
  - §3, the rows for `intent.run_enqueued` and `fact.run_started` (payload fields),
    `intent.accept_run` and `fact.run_accepted` (`landedUnstaged`), and the two new
    types;
  - §3, the post-terminal operator-actions paragraph: `intent.release_checkout` is the
    one action whose fold is asynchronous, and why;
  - §3, the `fact.snapshot_recorded` row, reworded from "once per worktree-backed run"
    to "the terminal snapshot of every git-backed run, fresh-worktree or checkout, taken
    after the status fact and before the executor fiber ends";
  - §8, queue fairness: the lane override (`checkout_seq` within a lane,
    `intent.priority_adjusted` a no-op within a lane, lane-blocked runs counting toward
    `queue_full`, and `waitingOn` replacing `wait_time_ms` for them);
  - §10, P4 and P7 as above;
  - the accept gate: order, `checkout_busy` as an accept-only input, the dirty-base
    guards, and the operator-concurrency hazard.
- `intent-fold.md`: the intent-plane unquarantine refusal, and the live-fiber
  condition on `intent.release_checkout`.
- `handler-contract.md`, `CI.md` and `operator-guide.md`: `FRAGUA_RUN_ID` wherever the
  engine-set variables are listed.
- `cli.md`:
  - the `run` flags, and the operator-concurrency hazard under `--dirty` and
    `--worktree`;
  - `runs accept`, including that every accept into a checkout refuses `checkout_busy`
    while a halted or cancelled checkout run there awaits release, the restore source,
    and re-accept after an interrupted land;
  - `runs release`;
  - the F1 pattern: a branch-committed run lands through its branch;
  - the new exit reasons.
- `docs/proposals/README.md` and `archive/README.md`: archive this proposal, and mark
  `worktree-opt-out.md` superseded by it.

## 7. Doors

A **Door** is a follow-up that this design leaves room for without building it
(opened), or deliberately rules out (foreclosed).

**Opened by this proposal:**

- **Three-way merge accept for a dirty-base run whose operator edits overlap the run's
  paths.** Compute `git merge-tree --write-tree --merge-base S <live> P` (git ≥ 2.40),
  refuse on conflict, keep a create-only restore ref for the live content, and
  materialise under the same per-path compare and verify. It is purely additive over
  the fast path: it replaces one `checkout_moved` refusal with a land.
- **Bounding the remaining fragua git calls.** `worktree-env.ts`'s `runGit` /
  `runGitCapture`, `run-actions.ts`'s `defaultGitExec` behind the `GitExec` port, and
  the accept commands could move onto the §3.1 runner. The mutating accept commands
  need a recovery story first: a timeout that kills `stash push`, `cherry-pick` or a
  rollback `reset --hard` part-way leaves the operator's checkout half-written.
- **`discard --restore` for checkout runs.** Restore the checkout to the base tree, and
  refuse unless the live tree and HEAD still equal the run's terminal snapshot. That
  guard is what makes the restore non-destructive to operator work. Snapshots already
  record everything the guard needs.
- **A store-side checkout lock.** A store row held across an accept or a `--dirty`
  capture, which the lane and the held predicate would both read, closing the window
  in which a new checkout run is enqueued and claimed mid-accept. It opens together
  with web enqueue and lane-aware schedules, because those are the writers that can
  create a checkout run without the operator typing it. Its liveness design (a lease
  that a suspended holder cannot outlive, and a stale row that does not wedge a lane
  while the daemon is down) has to be settled then ([§8](#8-rejected-alternatives)).
- **Lane-aware schedules.** `fragua schedule --worktree`. The dispatcher must treat an
  occupied lane as `overlap: queue`, and `schedule_skipped` must learn a lane reason.
- **Web enqueue fields and web release.** Expose `checkoutPath` and `dirty` on
  `POST /runs`, once the web can pick a registered worktree, and add a web "release
  lane" action over `buildReleaseCheckout`, which stays the single write path. Before
  this opens, `--worktree` path validation and the ignore-block check must move from
  the CLI into the intent plane.
- **Inbox admission of branch-committed runs.** Let a run that committed on its own
  named branch enter Ready to land, given a sound authorship criterion for which
  commits are the run's. Reachability from other refs is not one
  ([§8](#8-rejected-alternatives)). The reflog's `commit` entries since `run_started`
  are a candidate.
- **`fragua ci --dirty`.** For CI flows that want to run over a patched checkout
  without committing.
- **A run-scoped branch namespace.** For example `refs/heads/fragua/<run_id>/*`, with
  a gc row. This becomes possible once `FRAGUA_RUN_ID` gives workflows the name.
  fragua would still not create the branches.
- **`--dirty=<path>`.** Capture the dirty base from another registered checkout.
- **Execution modes for workflows with `type: workflow` steps.** Lifting the
  [§2](#2-the-declaration-surface) refusal needs [`workflow-as-step.md`](workflow-as-step.md)
  to define:
  - how a parent's landing range treats a synthetic base;
  - whether children inherit the dirt;
  - how a checkout parent's direct writes compose with child tree adoption under E054.

**Foreclosed by this proposal:**

- **Execution site in YAML or config.** Workflows stay portable, and an operator never
  inherits a run that edits their live tree without having typed `--worktree`.
- **Concurrent runs in one checkout.** The lane is a hard invariant. One checkout
  cannot support two writers.
- **fragua-managed branches.** fragua's ref writes stay inside `refs/fragua/*`.

## 8. Rejected alternatives

- **`--base dirty` or `--base @dirty`.** These overload the `<ref>` value space: a
  branch named `dirty` becomes ambiguous, and `--base` means "a commit".
- **A bare tree object as the base.** `worktree add`, `merge-base --is-ancestor`, and
  `cherry-pick A..B` all need a commit.
- **`git stash create` for the capture.** It drops untracked files and produces an
  index-parented merge commit, which diverges from what snapshots capture.
- **Seeding a capture with `read-tree HEAD`.** It drops skip-worktree, assume-unchanged
  and sparse flags, so an untouched checkout shows a phantom diff. Seeding from a copy
  of the real index, as the snapshotter already does, is the only seeding that agrees
  with a snapshot.
- **The capture helper in `@fragua/daemon`.** The accept path (`run-actions.ts`) lives
  in `@fragua/workspace`, and the server's accept route reaches it through
  `RunActionExec` without depending on the daemon. The CLI depends on both
  (`ci.ts:28`, `daemon.ts:18`), so it does not decide the placement; the server does.
- **Capturing from `run.cwd` rather than the toplevel.** A project in a subdirectory
  would capture only its subtree, and accept would write and unlink paths relative to
  the wrong directory.
- **Leaving capture git calls unbounded.** An agent-written `core.fsmonitor` or a
  `.gitattributes` clean filter that hangs would pin the holder's fiber, and therefore
  its lane, for as long as the daemon lives.
- **Bounding every fragua-internal git call.** An earlier revision did this. The only
  need for a bound is lane liveness, and a checkout run's terminal path makes no git
  call outside the capture and the snapshotter, because its `dispose()` is a no-op. The
  wider bound had real costs. A timeout on a mutating accept command (`stash push`,
  `cherry-pick`, a rollback `reset --hard`) can kill git part-way through and leave the
  operator's checkout half-written. And `defaultGitExec` is the injectable `GitExec`
  port behind every `gitDiff` / `resolveBaseRef` caller, so changing it reaches well
  past this proposal. Hardening those calls is a Door ([§7](#7-doors)).
- **A fixed or per-run sentinel index name.** A capture killed by the timeout leaves
  `<indexName>.lock` behind. Under a reused name, every later capture fails on that
  lock, so a checkout run would never record a snapshot again across retries and
  restarts. After a daemon crash, an orphaned detached `git add -A` could also still
  hold the name when the requeued fiber reuses it. A per-call nonce makes a leftover
  inert.
- **Dropping the per-run snapshot chain once names are unique.** The nonce removes the
  chain's index-isolation job but not its ordering job. Two overlapping snapshots of
  one run would parent on the same cursor and race `update-ref`, so the tip could land
  on the older tree.
- **Disabling clean filters during captures.** It would change what a capture records:
  an LFS checkout's snapshot would hold blobs where the branch holds pointers. The
  timeout bounds a hanging filter without changing content.
- **Replaying a dirty-base run's commits on accept.** Their ancestry runs through a
  commit that is not on the operator's branch, and git refuses to cherry-pick onto a
  dirty tree.
- **A three-way merge accept in v1, for an operator whose tree moved.** It would use
  `merge-tree --write-tree --merge-base S`, a git ≥ 2.40 floor, a create-only
  `pre-accept/<run_id>` restore ref, a recapture before write, and refusals for
  conflicts, an old git and a leftover restore point. The case for it stands: an
  operator who keeps typing while the run works is a natural `--dirty` user, and the
  fast path refuses them whenever their edits overlap the run's paths. Edits to other
  paths already land alongside the run's ([§3.3](#33-accept)). It is deferred rather than adopted because §1
  does not establish that need, and because the merge path is where the data-loss
  edge cases concentrate (a materialisation failure midway through a merged tree needs
  its own restore ref and recovery procedure). The fast path's restore source is
  **S** itself, already anchored, and the merge remains a purely additive Door
  ([§7](#7-doors)).
- **Landing a relocated dirty-base run as S → snapshot.** The review surfaces showed
  `diff_base_sha` → snapshot. Landing a different range than the one reviewed can
  silently delete operator WIP, so it refuses `relocated_base`.
- **A whole-tree recapture for the accept's compare and verify.** This was the
  previous design: capture the live tree **L**, compare it with `tree(S)` and
  `tree(P)`, and recapture after the land. A capture classifies untracked files through
  the live `.gitignore` and `info/exclude`, and the land rewrites `.gitignore`. A run
  that ignores the operator's untracked `dist/`, or un-ignores a file already on disk,
  makes the post-land recapture differ from `tree(P)` even though the checkout holds
  exactly the land. The verify then fails, and every re-accept refuses
  `checkout_moved`, a wedge with a false message. The per-path compare over **D**
  never consults ignore rules.
- **Refusing any land that changes `.gitignore`, `.gitattributes` or `info/exclude`**,
  and keeping the whole-tree compare. That would close the two wedges, but it would
  refuse every run that touches a `.gitignore`, which is a common edit. The per-path
  compare needs no such refusal for ignore files. It does refuse a `.gitattributes`
  change, for a different reason: the per-path hash runs through the live attributes,
  and a land that changed them part-way would hash written and unwritten paths under
  different filters.
- **Requiring every path in D to match S on re-accept.** A land interrupted after its
  unlinks leaves paths that hold **P**'s entry. With a strict compare, the only way
  forward would be a manual restore, even though each path holds nothing but the
  operator's captured content or **P**'s. The landable test admits exactly that shape
  and nothing else.
- **Trusting `git restore` without a verify.** It skips skip-worktree and sparse
  entries without failing, so the intent would record a land that did not fully
  happen.
- **Allowing a directory that the run replaced with a file.** The directory may hold
  ignored files that no capture saw, and writing the file would need them gone. The
  land refuses `checkout_unsafe_path`, and the operator lands it by hand.
- **Deleting `refs/fragua/bases/<id>` on discard.** A discard issued after a crashed
  land would delete the land's only restore source. gc's cutoff reclaims it instead.
- **A store-side checkout lock in v1** (a `checkout_locks` row held from the end of the
  gate through an accept, and across a `--dirty` capture, read by the lane claim and
  the held predicate). This was the previous design, and it is cut. Its liveness
  could not satisfy both of the properties it needed:
  - a crashed holder's row must be reapable while the daemon is down, or Ctrl-C wedges
    the lane. That calls for store-side staleness by timestamp;
  - a live holder's row must never be reaped. That calls for a liveness probe, plus a
    token re-check before every git step.

  A heartbeat lease is reaped under a suspended holder (SIGTSTP past the TTL), which
  then resumes and writes anyway. A row that is never reaped wedges the lane after
  Ctrl-C. Meanwhile the window the lock closes is narrow and operator-made: a
  brand-new checkout run on the same checkout, enqueued and claimed in the seconds an
  accept or capture runs. Lane membership already makes every existing run count as
  held, and the dirty accept's per-path compare refuses a land over a moved path. The
  cost of the cut is that window, now documented as an operator-concurrency hazard
  ([§3.3](#33-accept)). The lock becomes worth its liveness design when non-CLI writers
  can create checkout runs, so it is a Door.
- **A filesystem lock (`index.lock`, or a lockfile in the checkout).** Ground rule 4:
  coordination lands in the store. A crashed holder also leaves `index.lock` behind,
  which blocks every git command in the repository.
- **A terminal-snapshot reconciler.** This was a daemon fiber that re-attached
  terminal checkout runs with no recorded snapshot, retried with backoff, and appended
  a failure fact after N attempts. It needed `attachOnly` provisioning, a
  `checkout_snapshot` projection with a `'failed'` value, a new
  `fact.checkout_snapshot_failed`, and an OCC change to `disposeTerminalWorktree`. The
  hazard it addressed is a release overtaking the holder's live terminal capture, and
  the live-fiber condition on the release settles that directly. The crash windows it
  also closed leave a fresh-worktree run without a terminal snapshot today. For a
  checkout run only the record is at stake, because the work is in the operator's
  tree. The operator already decides a release over unrecorded work when a capture
  fails.
- **`AbortRegistry.activeRuns()` as the live-fiber set.** It tracks registered handler
  controllers, so it is empty between nodes and during the terminal capture.
- **A `settling` `waitingOn` reason.** "The holder is terminal and its fiber is still
  live" is in-memory daemon state that the read plane cannot see. Projecting it would
  take an eventless write at every fiber end. `release_required` covers those seconds,
  and its text for a `completed` holder says the snapshot may still be recording.
- **Releasing the lane at `fact.run_terminated`.** That is today's implicit behaviour,
  and it is unsound three ways: a successor's edits race the holder's terminal capture
  into its record; a leaked handler and a successor write one tree; and a cancelled or halted
  holder hands its damaged tree to an auto-claimed successor. The one exception is a
  run that never captured a base: it never wrote the checkout, so it releases at
  termination.
- **Auto-releasing a `completed` holder with no recorded terminal snapshot.** Its work
  would enter the successor's base without any record.
- **Separate mechanisms per hazard** (an unsettled-handler marker for leaked handlers,
  an operator release only after cancel or halt, and a lane that outlives the terminal
  snapshot). One release condition covers all three without the daemon tracking
  handler liveness.
- **Snapshot-before-terminal-fact.** Capturing before the terminal commit would close
  the SIGKILL window, but it restructures every terminal path in `dispatchOne`
  (`planCrashHalt`, cancel, structural halts, `planLeakHalt`). The operator release
  already covers that window.
- **A daemon-side unquarantine refusal in `wakeUnquarantine`.** An earlier revision
  added one as defence in depth. It consumed a stray `retry` or `treat_as_done` on a
  checkout run and recorded an `unquarantine.refused` event. It is cut because no
  path writes such an intent around `buildUnquarantine`. `inCheckout` is fixed at
  genesis. An older binary cannot open the migrated store (`migrations.ts:383-389`).
  Imported runs are inert. A guard with no reachable input is untested code. If a
  bypass path ever appears, the arm should emit the existing `intent.dropped`
  (`originalType: "intent.unquarantine"`, with a new `reason`) rather than a new event.
- **Fixing the malformed-resolution skip here.** That skip leaves its intent
  unconsumed, and `getNextPendingIntent` (`wake-pending.ts:228`) returns the earliest
  unapplied intent of the type, so the skipped intent shadows every later
  `intent.unquarantine` of the run. The bug is real, but it affects every run and has
  nothing to do with execution modes. It belongs in its own bug-fix change, which
  consumes the intent and emits `intent.dropped`.
- **Scrubbing checkout paths from fragua's log text.** An earlier revision rewrote the
  checkout key, the typed `<path>` and the common dir to `<checkout>` in provisioning
  error detail. No requirement calls for it. Fresh-worktree runs already write
  unscrubbed `run.cwd` and worktree paths into the same fields. The scrubber also
  missed symlinked spellings, other worktrees' paths inside git's message, and every
  agent tool output. A partial scrubber implies a guarantee that fragua does not make;
  [`archive/secret-scrubbing.md`](archive/secret-scrubbing.md) is where any such
  guarantee would be designed.
- **Ordering the lane by `enqueued_at` or `ready_at`.** `enqueuedAt` is read before the
  transaction opens, so a run that commits later can carry the older timestamp and be
  claimed while a younger run is running; an NTP step backwards does the same.
  `ready_at` is reset on every requeue, which would let a younger waiter overtake a
  crash-requeued holder. Only a sequence assigned in the transaction makes lane order
  commit order, and no existing column is one
  ([§4.3](#43-one-run-per-checkout--the-lane)). The `run_state` rowid comes closest,
  but `VACUUM` may renumber it.
- **A `PauseReason` (or a new status) for lane waiters.** A paused waiter needs a fact
  to enter the pause and a wake path to leave it at every holder release, and
  `intent.resume` would let an operator wake a waiter past its lane. The claim
  predicate already expresses "not yet" with no fact per transition. Instead, SPEC's
  `queued` definition is reworded. SPEC §3.4's rule, "Adding a new operator-fixable
  failure mode is a new `PauseReason` literal", does not apply, because a lane wait is
  neither a failure nor something the operator fixes.
- **"Holds a checkout" meaning only `running`.** A queued or paused run on the checkout
  would let an accept or a `--dirty` capture slip in ahead of it. The held predicate is
  the lane-holder definition: every unreleased, non-imported run, queued included. The
  refusal is retryable, so being conservative costs only a re-run.
- **`checkoutPath` on the genesis payload.** The genesis contract omits local bindings
  (`events.ts:364-368`), and import nulls `cwd` (`store-bundle-import.ts:290`). A
  logged absolute path would make an imported non-terminal checkout run hold that lane
  forever and wedge the `--dirty` check and `checkout_busy`. It would also make the
  path a contract field of every bundle and press on the I7 cap. The log carries `inCheckout`; the path is a local column.
- **`LocalEnvironment` for checkout runs.** It has no git machinery, so checkout runs
  would lose snapshots, `runs diff`, and the event-log record of what changed.
- **Refusing a second checkout run at enqueue.** That breaks queueing "fix, then fix
  again" back-to-back, which is the motivating flow.
- **Capturing a checkout run's base at enqueue.** A run queued behind a lane holder
  would be based on a tree that no longer exists when it starts.
- **Checkout runs in Ready to land with a record-only accept.** The inbox would claim
  work was waiting to land when it had already landed.
- **Destructive discard for checkout runs by default.** It would delete operator
  edits made on top of the run's work.
- **A web release route in v1.** Checkout runs can only be created from the CLI, and
  every `waitingOn` rendering prints the CLI command. It is part of the web-enqueue
  Door.
- **Keeping `current_node` through quarantine** so that `unquarantine{retry}` resumes
  at a node. That is a fold change to every quarantine, for every run, to serve one
  mode. A synchronous intent-plane refusal reaches the CLI and the server at once
  without it.
- **Admitting branch-committed F1 runs to the inbox by branch name.** A run-named
  branch can be created on top of someone else's commits, and accept would then
  cherry-pick them.
- **Admitting them by reachability** (a snapshotter-measured count of the run's
  commits already reachable from another branch or remote, gated on v7 in the fold).
  The criterion is unsound: commits fetched into `FETCH_HEAD` or a `refs/pull/*` ref
  are reachable from no branch or remote-tracking ref, so a PR the run checked out
  would count as its own work. A sound criterion is new machinery for a need §1 does
  not state. Such runs are outside the inbox today, so leaving them there is no
  regression, and it is a Door.
- **Fully specifying `type: workflow` composition here.** That would design against an
  unconverged draft. The refusal plus a Door leaves that draft's next revision free to
  decide.
- **A third substitution token `${{ run.id }}`.** Ground rule 13 allows two tokens,
  and a per-run value in prompt text breaks prompt-cache reuse.
- **A per-exec `FRAGUA_RUN_ID` passed by each caller.** The agent's bash tool passes
  no env, so every call site would need to learn the run id. A run-scoped
  constructor-level `engineEnv` sets it once, at the one place that knows it.
- **A separate `--in-place` flag.** It is a second spelling of `--worktree .`, and it
  is ambiguous when `cwd` is itself a linked worktree.
- **A workflow-level `execution:` key.** The execution site is the operator's choice,
  not the author's.
- **A project-config default.** It would silently turn every run in a project into an
  edit of the operator's live tree.

## 9. What this answers from `worktree-opt-out.md`

That draft's panel left four blocking findings. Each is answered here:

1. **"It is a contract bump."** Yes. The bump (v6 → v7) is taken in [§6](#6-contract-schema-and-docs),
   and `MIN_COMPATIBLE_CONTRACT_VERSION` is unchanged.
2. **"Orphan plus in-place plus retry replays from start."** Quarantine always nulls
   `current_node`, so both `retry` and `treat_as_done` replay from the start. Both are
   refused with `checkout_replay` by the state-taking `buildUnquarantine`
   ([§4.3](#crash-recovery)), which every writer of the intent goes through. Cancel is
   the only exit, and it leaves a cancelled holder whose lane the operator releases.
3. **"The schedule dispatcher's lane."** Out of v1 because schedules do not accept
   `--worktree`. It is kept as a Door ([§7](#7-doors)).
4. **"An in-place badge needs a projected field."** `in_checkout`, `checkout_path`,
   `base_head_sha` and `checkout_released` are projected and threaded through the
   read-plane DTO and the server schemas ([§4.4](#44-inbox-accept-discard)).

That draft's motivating case was a document-per-run pipeline that accumulates state in
one tree. `--worktree .` serves it: the runs queue in one lane, and each one sees its
predecessor's files.
