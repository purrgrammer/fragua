# `--no-worktree` / in-place execution — DRAFT proposal

> **Status: DRAFT (parked, NOT settled).** From a `propose` run that did not
> converge. Soundness verdict: **direction viable, draft unsound as written** —
> the panel REFUTED the proposal's core `// contract: no-bump` claim (the
> `fact.run_quarantined` reducer change IS an `EVENT_CONTRACT_VERSION` bump per
> ARCHITECTURE §1.11) and found a real correctness gap (an orphan+in-place crash
> routes into a from-start replay that re-applies a non-idempotent filesystem
> mutation). Both must be resolved before this is implementable. The body below
> is the run's grounding doc; full draft + panel transcript persist in the
> original run's event log.


> Grounding notes for the proposal author. Brief, dense, citation-heavy. Read
> this instead of re-deriving the seams each revision.
>
> Note on context pointers: `qa-questions.md` and
> `.fragua/workflows/requirements-doc.yaml` are referenced in the task but are
> **not present** in this worktree (grep returns nothing). They describe the QA
> "requirements-doc" run-per-document pipeline (Architecture A); treat the
> motivating use case as given rather than quotable.

---

## 1. The problem and the exact decision to settle

**Problem.** Today a run against a git repo executes in a per-run linked
worktree at `<run.cwd>/.fragua/worktrees/<run_id>/` (detached HEAD, isolated
index/working tree). Successive runs therefore cannot see each other's on-disk
output or accumulated project memory — each is born from the branch HEAD at
provision and torn down at terminal. The QA run-per-document pipeline (doc N
depends on doc N-1's files + shared memory) is defeated by this isolation.

**Decision to settle (the load-bearing part):** the exact shape of an *opt-out*
that lets a run in a git repo execute directly in the repo's main working tree,
expressed across **both**:

1. a **project-config key** in `<cwd>/.fragua/config.yaml` (durable default,
   honoring the global→project cascade), and
2. a **CLI flag** on `fragua run` (per-invocation override).

…including their **precedence**, **naming**, and **default** (worktree-on stays
the default for git repos). The proposal must also resolve the *consequences*
of running without a worktree — concurrency/safety, accept/discard/diff,
adapter placement, non-git reconciliation, migration/blast-radius — not just the
knob. Out of scope: changing the default, rewriting the worktree model. This is
additive opt-out.

The key observation that shapes everything downstream: **"no worktree" already
exists as a code path** — the `LocalEnvironment` used for non-git cwds. The
question is largely whether shared-tree git execution *is* that path, a variant
of it, or a third mode (§3, §5).

---

## 2. Current mechanisms touched (file:line)

### 2.1 The two ExecutionEnvironment adapters

- **`WorktreeEnvironment`** — `packages/workspace/src/worktree-env.ts`.
  `init()` runs `git worktree add --detach <worktreePath>`
  (`worktree-env.ts:117`), captures `baseGitSha` from the worktree HEAD
  (`:124-131`) and `baseGitRef` (source-repo symbolic HEAD) (`:137-149`),
  optionally bootstraps (`:158-176`). `cwd()` returns the worktree path;
  `projectCwd()` returns `repoRoot` (`:280-291`). `dispose()` runs
  `git worktree remove --force` (`:264-276`).
- **`LocalEnvironment`** — `packages/workspace/src/local-env.ts`. Runs directly
  in `_cwd` (`local-env.ts` constructor `:104`). `cwd()` === `projectCwd()` ===
  `_cwd` (`:160-168` — *"LocalEnvironment runs directly in the project root;
  cwd === projectCwd"*). `resolvePath` enforces a `PathEscapeError` perimeter so
  every read/write/exec stays under `_cwd` (`:171-205`); `exec` blocks
  `cd <abs-outside-cwd>` (`:235-260`). `WorktreeEnvironment` delegates all of
  this to an internal `LocalEnvironment` rooted at the worktree path
  (`worktree-env.ts:95-104`).

  **Note:** `LocalEnvironment` has no concept of git, no snapshot capture, no
  `baseGitSha`. It is "raw filesystem rooted at cwd" — exactly the shared-tree
  semantics we want, minus that today it is only selected for *non-git* cwds.

### 2.2 The provisioner — where the adapter is chosen

- `packages/daemon/src/worktree-provisioner.ts`, `WorktreeProvisioner.create()`.
  The fork is **purely `isGitRepo(repoRoot)`**: a non-git cwd gets a
  `LocalEnvironment` rooted at the run's cwd (`worktree-provisioner.ts`, the
  `if (!(await isGitRepo(repoRoot)))` branch, ~`:300-307`); a git cwd gets a
  `WorktreeEnvironment` with `init()` (~`:309-324`). `isGitRepo` is
  `git rev-parse --is-inside-work-tree` (bottom of file).
- `snapshot()` short-circuits for non-worktree envs:
  `if (!(env instanceof WorktreeEnvironment)) return null; // bare cwd → no snapshots`.
- `baseGitSha(runId)` / `baseGitRef(runId)` return `null` for non-worktree envs.
- The executor calls `provisioner.ensure(runId, { cwd: state.cwd })` before the
  first dispatch (`packages/daemon/src/executor.ts:654-658`), stamps
  `baseGitSha`/`baseGitRef` onto `fact.run_started` (`:682-693`), and
  `disposeTerminalWorktree` at terminal (`:1928`).

  **This `instanceof WorktreeEnvironment` discriminator is the de-facto
  "has a worktree?" predicate throughout the daemon.** Any shared-tree mode that
  reuses `LocalEnvironment` inherits "no snapshots, null baseGitSha" *for free* —
  which is both the easy path and the thing the accept/discard section must
  consciously decide about.

### 2.3 Snapshot / accept / discard / diff

- **Snapshots:** `packages/daemon/src/snapshot-service.ts`.
  `captureBoundarySnapshot` and `disposeTerminalWorktree` both no-op when
  `provisioner.snapshot()` returns `null`: *"snap === null only for bare-cwd
  runs (no worktree) — nothing to preserve or dispose, so that's not a
  failure."* So bare-cwd runs today produce **no** `snapshot.captured`, **no**
  `fact.snapshot_recorded`, and **no** `refs/fragua/{snapshots,heads}/<id>`.
- **accept/discard/diff:** `packages/workspace/src/run-actions.ts`.
  `checkGate` refuses with `no_worktree` when `gate.cwd == null`
  (`run-actions.ts:120`), but a bare-cwd run *has* a cwd (the project root) — it
  passes the gate and then `acceptInner` fails at `no_work` because
  `refs/fragua/snapshots/<id>` doesn't exist (`:175-178`). `applyAccept` is a
  **replay-onto-HEAD** algorithm: `cherry-pick baseGitSha..heads/<id>` then
  `git apply --3way --index` the uncommitted tail (`:230-300`), gated on a clean
  operator tree (`dirty_tree`, `:200-206`). `applyDiscard` deletes the two refs
  (`:330-352`). `gitDiff` is `git diff <from>..<to>` over snapshot refs
  (`:308-322`). The read-plane `diffRange` refuses `no_worktree` when
  `state.cwd == null` and resolves the base from `state.diffBaseSha ?? baseGitSha`
  (`packages/core/src/read-plane/plane.ts:222,229`).

  **Crux:** all of accept/diff assumes the run's output lives in dedicated refs
  built from a worktree against a known `baseGitSha`. An in-place run's output
  is *already* uncommitted dirt in the main working tree — there is nothing to
  "replay onto HEAD"; it is on HEAD's tree already. The proposal must define
  what accept/discard/diff *mean* here (probably: diff = live `git diff`/`status`,
  accept = no-op/"already in tree", discard = destructive `checkout`/`clean` —
  the dangerous one).

### 2.4 The queue / claim / startup sweep

- `packages/store/src/store.ts:827` `claimNextRun(maxInFlight)`: capacity gate is
  `countDispatchableRunningRuns(db) >= maxInFlight` then `selectNextQueuedRun` by
  priority/ready_at. **No cwd awareness — nothing serializes runs that share a
  cwd.** Today that's safe because each git run gets its own worktree; two runs
  in one repo never touch the same files. Shared-tree breaks that assumption:
  two concurrent in-place runs in one working tree race on a dirty tree.
  Concurrency is a single global cap (`concurrency` config, default 16,
  `packages/cli/src/config.ts`); there is no per-key lane.
- Startup sweep (`store.startupSweep`, `IDaemonCoordinator.startupSweep`,
  `store.ts:847`) requeues `running` runs after a crash. A crashed in-place run
  leaves its partial writes in the shared working tree with no worktree to
  discard — the sweep's requeue semantics must be reconciled (a re-dispatched
  in-place run re-enters a dirtied tree).

### 2.5 Config cascade + CLI

- `packages/cli/src/config.ts`: `loadConfig(cwd)` overlays global
  `~/.fragua/config.yaml` with project `<cwd>/.fragua/config.yaml`; project keys
  win; nested objects merge one level deep (`mergeConfig`, `:299-315`).
  `loadProjectConfig(cwd)` reads **only** the project layer, no cascade — used
  for strictly project-scoped keys like `bootstrap` to avoid global leakage
  (`:291-297`, and the comment block at top of file). `FraguaConfigSchema`
  (`:84-150`) is `additionalProperties:false`, so a new key must be added to the
  schema or it is stripped with a warning (`validateParsed`, `:230-260`).
- The provisioner already honors per-project config via `resolveRunBootstrap` /
  `resolveProjectBootstrap` (`config.ts:306-321`) — the established pattern for
  "one daemon, many projects, each project's `.fragua/config.yaml` decides." A
  worktree-opt-out key would ride the same resolver seam.
- CLI `fragua run` (`packages/cli/src/commands/run.ts`): resolves project
  identity, sets `cwd = project.projectRoot` (`run.ts:60`), builds the enqueue
  via the intent plane (`buildEnqueue`, `:120-140`). A per-run flag would be
  threaded into routing/enqueue (the enqueue already carries `routing`,
  `priority`, `inputs`). `RunCommandOptions` (`:30-56`) is where the flag lands.
  **Where the decision must be *recorded*:** the daemon provisions from
  `state.cwd` only (`executor.ts:656-657`) — it does not re-read CLI argv. So a
  per-run override must be **persisted on the run** (most likely a `routing.*`
  key folded at enqueue) for the daemon's provisioner to honor it; a flag that
  isn't written to the store is invisible to the executor.

---

## 3. Invariants and contracts implicated (quote)

- **Ground rule 4 / SPEC §2 — One coordination surface.** *"`@fragua/store` is
  the only place state transitions land. No filesystem coordination (JSONL,
  checkpoint files, `fs.watch`, unix sockets)."* Any shared-tree concurrency
  contract (serialize, reject-overlap, best-effort) **must be expressed through
  store state** — e.g. the claim query / a run_state field — never a lockfile in
  the working tree. This is the hardest constraint on the concurrency design.
- **SPEC I1** — *"Every write is one SQLite transaction; events + projection
  updated together."* A per-cwd serialization gate added to `claimNextRun` must
  stay inside its existing `writeTxn` (`store.ts:831`).
- **SPEC I8** — *"Raw tool output addressed by sha256 in `blobs`; artifacts are
  named refs scoped by `(run, node, iteration, key)`."* Artifacts/blobs are
  store-side and unaffected by where the filesystem run executes — only the
  worktree-derived snapshot refs are at stake.
- **execution-model.md §5 (Critical)** — *"The worktree is the **only**
  filesystem surface that fragua tracks. Writing files outside it has two silent
  failure modes: files never appear in snapshots/diff; files bypass the
  accept/discard gate entirely."* In shared-tree mode this inverts: writing *in*
  the main tree is the point, and the snapshot/accept gate is exactly what no
  longer applies. The doc's central safety claim is worktree-specific and must be
  re-stated for the new mode.
- **execution-model.md §4 — snapshot delta-suppression.** Step-boundary
  snapshots are suppressed when the tree SHA is unchanged. In shared-tree mode
  there are no snapshots at all (per §2.3) — so `fragua runs diff` has nothing to
  scrub; the proposal must say what diff resolves to (live tree vs. nothing).
- **SPEC §5 / Ground rule 11 — contract versioning.** Adding a run-level config
  knob that *only* affects provisioning (not `FactEvent`/`IntentEvent` shape or
  fold semantics) should **not** bump `EVENT_CONTRACT_VERSION`. If the override
  is persisted as a `routing.*` key (projection-only), it stays off the contract
  axis. If it needs a new fact, that's a contract bump — avoid if possible.
- **I2** — *"No handler state outside the projection."* The "is this run
  shared-tree?" bit must be derivable from the projection (routing/run_state),
  consistent with how the executor reads `state.cwd`.

---

## 4. Prior art — existing proposals/mechanisms that overlap

- **`LocalEnvironment` for non-git cwds (shipped).** The closest existing
  mechanism: it *already* executes in-place with no worktree, no snapshots, no
  accept/discard. The shared-tree opt-out is essentially "select this adapter
  even when the cwd *is* a git repo." Door left open: it has no notion of git, so
  it gives up diff/accept/discard silently — the proposal must decide whether
  shared-tree git runs accept that same silence or layer a git-aware diff on top.
- **`resolveRunBootstrap` / `resolveProjectBootstrap` (shipped,
  `config.ts:306-321`, `worktree-provisioner.ts` resolver seam).** The precedent
  for a per-project, project-scoped (no global cascade) config knob that the
  daemon honors per-run across many projects. A worktree-opt-out key would
  almost certainly ride this exact seam. Note bootstrap deliberately uses
  `loadProjectConfig` (no cascade) — but the task *requires* the worktree key to
  honor the global→project cascade, so it uses `loadConfig`, not
  `loadProjectConfig`. Reconcile this divergence explicitly.
- **`fan-out-runs.md` (specified, future).** Cross-run fan-out gives each child
  *isolated* worktrees and joins by reading outputs — the opposite of shared
  state. Confirms the design axis: fragua's cross-run composition is
  artifact/output sharing, *not* shared filesystem. Shared-tree is a deliberate
  exception to that posture; the proposal should position it as such (a
  pragmatic bridge for ported pipelines, not the cross-run model).
- **`concurrency.md` — "linearization, not isolation."** *"All durable writes
  for a run linearize through one committer."* This is about intra-run commit
  ordering, but the framing is the relevant precedent for the shared-tree
  concurrency contract: fragua's answer to concurrency is always "serialize the
  authoritative thing through the store," never filesystem locks. A shared-tree
  serialization gate should be argued in the same terms (serialize *claims* for a
  shared-tree cwd through `claimNextRun`).
- **`ernesto-interop.md:240`** — *"worktree/accept/discard machinery stays
  **out** — Ernesto's workdir [is the run dir]."* An external precedent that the
  engine can run with the workdir == the run dir and the worktree/accept stack
  simply disabled — supports treating shared-tree as "worktree stack off,"
  i.e. the `LocalEnvironment` path.
- **`secret-scrubbing.md:282`** — *"The worktree is gone, so per-run env needles
  …"* and `envDenyNames`/`envDenyPredicate` plumbing already flows through both
  `LocalEnvironment` and `WorktreeEnvironment` (`worktree-provisioner.ts`
  options). Shared-tree mode inherits the same env-strip seam; no new work there.

---

## 5. Constraints the design must respect + open questions the draft must answer

### Constraints
1. **Default stays worktree-on for git repos.** The opt-out is additive; the
   `isGitRepo → WorktreeEnvironment` default (`worktree-provisioner.ts`) is
   unchanged absent explicit opt-out.
2. **One coordination surface.** Whatever concurrency contract is chosen for a
   shared-tree cwd must live in store state (claim query / run_state), not a
   filesystem lock. (SPEC §2, ground rule 4.)
3. **Cascade required for the config key**, project-over-global, one-level-deep
   merge — `loadConfig`, not `loadProjectConfig` (contrast with `bootstrap`).
   Key must be added to `FraguaConfigSchema` (additionalProperties:false).
4. **Per-run override must be persisted on the run** to reach the daemon (the
   executor provisions from `state.cwd`, never CLI argv) — most likely a folded
   `routing.*` key set at enqueue, ideally **not** a new fact type (avoid a
   contract bump).
5. **Don't break bare-cwd (non-git) runs** — they already execute in-place; the
   model must subsume them so there is one coherent "in-place" concept, not two.

### Open questions the draft must answer
1. **Adapter placement.** Is shared-tree (a) the existing `LocalEnvironment`
   path selected for a git cwd, (b) a new `instanceof`-distinguishable mode, or
   (c) a `WorktreeEnvironment` variant that points at the main tree? Decide, and
   note the blast radius on every `instanceof WorktreeEnvironment` site
   (snapshot, baseGitSha, dispose) — option (a) gets "no snapshots/no
   baseGitSha" for free but forfeits git-aware diff/accept.
2. **Naming + location of the config key** (e.g. `worktree: false`,
   `isolation: shared`, `execution.worktree: …`) and the **CLI flag** spelling
   (`--no-worktree` / `--shared-tree` / `--in-place`), plus **precedence:** CLI
   flag > project config > global config > default(worktree-on). State the exact
   override chain including the negative form (can a per-run flag turn worktree
   *back on* over a project default of off?).
3. **Concurrency contract** for a shared-tree cwd: serialize (one in-flight run
   per shared-tree cwd, enforced in `claimNextRun`), reject overlap at enqueue,
   or best-effort? How does it interact with the global concurrency cap and the
   startup-sweep requeue of a crashed in-place run (dirty tree on re-dispatch)?
   Express the chosen contract purely in store terms.
4. **accept/discard/diff semantics in-place.** Define each:
   - *diff* — live `git diff`/`git status` of the working tree vs. nothing?
   - *accept* — no-op ("already in your tree") or a guided commit?
   - *discard* — destructive `git checkout`/`git clean` (and how guarded), or
     refused outright? What does the inbox show for an in-place terminal run
     (today inbox/change-stat is driven by `fact.snapshot_recorded`, which won't
     exist)?
5. **Non-git reconciliation.** State the unified model: "in-place execution" =
   `LocalEnvironment` rooted at cwd, selected when (cwd is non-git) **or**
   (worktree opted out). Confirm non-git runs and opted-out git runs get
   identical treatment for snapshot/accept/diff, or enumerate the deltas (a git
   in-place run *could* offer live `git diff` a non-git one can't).
6. **Migration / blast radius.** Which SPEC clause or execution-model claim
   changes wording (execution-model §5's "worktree is the only tracked surface";
   §1 "non-git → LocalEnvironment" generalizes to "in-place"). Confirm no
   `EVENT_CONTRACT_VERSION` bump is required. Confirm I1–I11 untouched. Enumerate
   what must **not** change: the worktree default, the worktree code path, OCC,
   the single committer, artifact/blob addressing.

---

## Open items (panel critique — blocking)

1. **It IS an `EVENT_CONTRACT_VERSION` bump.** Drop the `// contract: no-bump`
   marker; accept the increment, keep `MIN_COMPATIBLE_CONTRACT_VERSION` at 1, and
   document that runs the new daemon enqueues park `engine_incompatible` on a
   downgraded daemon. (ARCH §1.11: "new pause/halt reason → yes" and "reducer
   behaviour change → yes" both fire on the `in_place_crash` arm.)
2. **Close the orphan+in-place crash replay gap.** Preferred: refuse
   `unquarantine{retry}` for an in-place run whose `current_node` is null (force
   `cancel`), so from-start re-application can never run unattended. Add a
   replay/fold test asserting an in-place run with an orphan side-effect does not
   resume on the start node.
3. **Decide the schedule-dispatcher lane-occupancy gate in or out of scope.**
   Either ship it with the lane (and resolve the `overlap:queue` coercion +
   `schedule_skipped` taxonomy sub-items) or cut it behind a Door with a
   documented known limitation.
4. **The in-place badge needs a new projected field** (e.g. `inPlace`) threaded
   through `@fragua/core/read-plane` + `@fragua/server` `schemas.ts` — the web
   consumes the projected HTTP schema, not `run_state` directly.
