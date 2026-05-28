# fragua — Filesystem Execution Model

> **Audience:** workflow authors. Read this before writing steps that create, edit, or reference files.

---

## 1. The worktree — where every step runs

When fragua starts a run against a git repository it provisions a **git linked worktree** for that run:

```
<run.cwd>/.fragua/worktrees/<run_id>/
```

`<run.cwd>` is the project root the run was enqueued from. The worktree is a detached-HEAD checkout of the branch HEAD at provision time — a full git checkout in its own directory, sharing the object database with the main repo but with its own index and working tree.

**All step execution is rooted at this worktree path.** There is no separate "agent sandbox" or "tool directory" — the three execution surfaces a workflow author touches all resolve to the same cwd:

| Surface | How cwd is set | Source |
|---|---|---|
| `bash` tool (inside an `llm` step) | `env.exec(command, { cwd })` → `LocalEnvironment._cwd` → worktree path | `packages/workspace/src/tools.ts` `bashTool.execute`, `packages/workspace/src/local-env.ts` line 249 |
| `tool` step `run:` command | `ctx.env.cwd()` → worktree path | `packages/core/src/handler/handlers/tool.ts` `const cwd = ctx.env?.cwd() ?? ""` |
| `read` / `write` / `edit` tools (inside an `llm` step) | `env.readFile` / `env.writeFile` resolve paths under `LocalEnvironment._cwd` → worktree path | `packages/workspace/src/tools.ts` `readFileTool.execute`, `writeFileTool.execute`, `editFileTool.execute` |

The `cwd()` method on `WorktreeEnvironment` returns `this.worktreePath` — the per-run worktree directory (`packages/workspace/src/worktree-env.ts`). All execution surfaces receive this environment; there is no fallback to the main project root for any production dispatch.

**Non-git projects** — runs enqueued from a directory that is not a git repository get a `LocalEnvironment` rooted at `<run.cwd>` directly (no worktree, no git). The same cwd-consistency rule holds; there is simply no isolation layer.

---

## 2. Fresh shell per `bash` call

Each invocation of the `bash` tool spawns a **new `/bin/sh -c <command>` process**. There is no persistent shell session across calls.

```
// packages/workspace/src/local-env.ts line 249
const child = spawn("/bin/sh", ["-c", command], { cwd, ... });
```

Consequences:

- A `cd` in one `bash` call has **no effect** on the next call. The next call's shell always starts with `cwd = worktree path`.
- Environment variable exports (`export FOO=bar`) do not persist across calls.
- Shell functions and aliases defined in one call are gone in the next.

To operate on a file in a subdirectory across multiple calls, either:

- Use a **relative path** from the worktree root: `cat src/foo.ts`
- Chain commands with `&&` in a single call: `cd src && cat foo.ts && cat bar.ts`
- Use an **absolute path** inside the worktree (e.g. from `pwd` captured earlier in the same call)

---

## 3. Worktree lifecycle

| Phase | What happens |
|---|---|
| **Provision** | `git worktree add --detach <worktreePath>` from the repo root. Bootstrap command runs inside the fresh worktree if configured. |
| **Run** | All nodes execute. The worktree persists across HITL pauses and daemon restarts — a resumed run reuses the same worktree. |
| **Terminal snapshot** | When the run reaches a terminal status, fragua captures the worktree's full state (committed + uncommitted) into `refs/fragua/snapshots/<run_id>` before removing the worktree directory. |
| **Dispose** | `git worktree remove --force <worktreePath>`. Dispose only runs after the terminal snapshot fact lands successfully — work is never discarded silently. |

Implementation: `packages/daemon/src/worktree-provisioner.ts`, `packages/workspace/src/worktree-env.ts`.

---

## 4. Snapshots and `fragua runs diff`

Snapshots capture the worktree's state (committed + uncommitted) at **step boundaries**. They are implemented as git commits under `refs/fragua/snapshots/<run_id>` — the real index and HEAD are never touched.

### When snapshots are taken

- **After each completed node** (`fact.node_completed`) — `step` boundary.
- **On HITL pause** (`fact.run_paused_human`) — `hitl` boundary.
- **On terminal status** — a `terminal` boundary, then dispose.

### Delta suppression

A `step` boundary snapshot is **suppressed when the worktree tree is identical to the previous snapshot's tree** — `captureSnapshot` returns `null` and no `snapshot.captured` event is written:

```typescript
// packages/daemon/src/snapshotter.ts
if (boundary === "step" && prevTreeSha != null && prevTreeSha === treeSha) {
  return null;
}
```

This is precisely why `fragua runs diff` shows "no changes" for a step that read files but wrote nothing — the tree SHA matched and no snapshot event was recorded. It is not a bug; it is intentional cost control.

`hitl` and `terminal` boundaries are **never** delta-suppressed — they always write a snapshot regardless of tree changes.

### What `fragua runs diff` shows

`fragua runs diff` computes `git diff <baseSha>..<snapshotCommitSha>` over the stored snapshot refs. The base is `baseGitSha` — the HEAD SHA of the worktree at provision time. If a step produced no snapshot event (delta-suppressed), that step will not appear as a selectable diff point.

Implementation: `packages/daemon/src/snapshotter.ts` (`captureSnapshot`), `packages/daemon/src/snapshot-service.ts` (`captureBoundarySnapshot`, `disposeTerminalWorktree`).

---

## 5. ⚠ Critical: write inside the worktree

The worktree is the **only** filesystem surface that fragua tracks. Writing files outside it has two silent failure modes:

1. **Files never appear in snapshots or `fragua runs diff`.** Snapshots capture `refs/fragua/snapshots/<run_id>` — git objects within the worktree. Files written elsewhere are invisible to git and therefore invisible to the snapshot.
2. **Files bypass the accept/discard gate entirely.** `fragua runs accept` and `fragua runs discard` operate on `refs/fragua/{snapshots,heads}/<run_id>`. Files outside the worktree have no refs; accept/discard cannot touch them.

### The "I wrote a file but diff shows nothing" pattern

This almost always means one of:

- The step wrote to the main repo root (via an absolute path or `$(git rev-parse --show-toplevel)/..`) rather than the worktree cwd.
- The step's tree was identical to the previous snapshot (delta-suppressed, §4).

**Always write relative to the worktree cwd** — the cwd you are already in. Relative paths and `./subdir/file` automatically stay inside the worktree. If you use an absolute path, construct it from `pwd` captured inside the same shell call, not from a git plumbing command that returns the main repo root.

fragua enforces this at the tool layer: `write` and `edit` and `read` calls with absolute paths that resolve outside the worktree raise a `PathEscapeError` (turned into a tool error the LLM can self-correct). The `bash` tool also refuses `cd <absolute-path-outside-cwd>` segments with a non-zero exit. These guards exist because escaping the worktree silently is the single most common class of "my run succeeded but nothing changed" bugs.

---

## 6. Landing work: accept and discard

Once a run reaches a terminal status, its work sits in `refs/fragua/snapshots/<run_id>` and `refs/fragua/heads/<run_id>`. Two operator actions move it:

### `fragua runs accept <id>`

Lands the run's work on the operator's current branch in `<run.cwd>`:

1. **Pre-probe:** `git merge-tree` the whole run (commits + uncommitted tail) onto HEAD in memory. Returns a conflict error immediately if the merge would fail — no mutation.
2. **Replay:** `git cherry-pick <baseGitSha>..<heads/<run_id>>` — replays the workflow's commits onto HEAD, preserving their message and author.
3. **Stage the tail:** if there was uncommitted work on top of the workflow's commits (`snapTree != runTree`), applies it as a staged patch via `git apply --3way --index`.

The result: the operator's branch has the replayed commits and a staged-but-not-committed tail ready for `git commit`.

Implementation: `packages/workspace/src/run-actions.ts` (`applyAccept`).

### `fragua runs discard <id>`

Deletes `refs/fragua/snapshots/<run_id>` and `refs/fragua/heads/<run_id>`. The run's work is permanently dropped. Idempotent — a missing ref is tolerated.

Implementation: `packages/workspace/src/run-actions.ts` (`applyDiscard`).

Both actions require the run to be in a terminal status with an in-inbox state. A clean operator working tree is required for `accept`.

---

## 7. Gotchas — quick reference

| Gotcha | Why | Fix |
|---|---|---|
| `cd` in one `bash` call does not carry to the next | Each bash invocation spawns a fresh `/bin/sh` process | Chain with `&&` in one call, or use relative paths |
| Writing to the main repo root bypasses snapshots and accept/discard | Snapshots only capture the worktree; accept/discard only operate on its git refs | Use relative paths or `pwd` captured inside the same shell call |
| A read-only step shows no diff | Delta suppression: identical tree → no snapshot event | Expected behavior; only file-mutating steps produce selectable diffs |
| Bootstrap commands (`bun install`, etc.) do not re-run on resume | Idempotent provision: an existing worktree is reused, bootstrap is skipped | Re-bootstrap only on fresh provision; do not depend on it running on every resume |
| Files written to `/tmp` or other system paths are not tracked | Outside the worktree | Write to a path inside the worktree cwd; use `/tmp` only for genuinely ephemeral scratch |

---

## 8. Summary

```
<run.cwd>/
├── .fragua/
│   └── worktrees/
│       └── <run_id>/       ← every bash/tool/write/edit/read lands here
│           ├── src/
│           ├── package.json
│           └── ...         ← full git checkout, detached HEAD
└── (main checkout)         ← NOT where steps run; accept/discard land here
```

- **One cwd. All surfaces.** `bash`, `tool run:`, `write`, `edit`, `read` all resolve to `.fragua/worktrees/<run_id>/`.
- **Fresh shell per bash call.** No persistent session; `cd` does not carry.
- **Snapshots are tree-delta-gated.** Read-only steps produce no snapshot event.
- **Write inside the worktree or it doesn't exist** from fragua's perspective.
