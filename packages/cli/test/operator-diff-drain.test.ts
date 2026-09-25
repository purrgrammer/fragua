// Regression: `fragua runs diff <run>` must emit the WHOLE diff of a completed,
// worktree-disposed run's snapshot ref against its base — not just the first
// file. The diff is resolved correctly (base..snapshot commit), but the command
// wrote it with a fire-and-forget `process.stdout.write` and then let `main`
// call `process.exit`. On a pipe that discards everything past the kernel pipe
// buffer (~64KB), so a multi-file diff whose first file alone exceeds the buffer
// is truncated to that one file — under-reporting the run's work.
//
// This spawns the real bin through a genuine shell pipe (the operator's
// `runs diff | pager` case) and asserts the emitted file count matches the
// snapshot ref. The pipe is what forces the truncation: on a non-blocking OS
// pipe, `process.exit` drops node's still-buffered stdout past the ~64KB kernel
// buffer.

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";

const WF_SRC = "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n";

setDefaultTimeout(30_000);

const BIN = join(import.meta.dir, "..", "bin", "fragua.ts");

function git(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString()
    .trim();
}

/** A file whose contents change from base to snapshot, big enough that a
 * handful of them push the diff past the 64KB pipe buffer. */
function bigLines(tag: string): string {
  return `${Array.from({ length: 80 }, (_, i) => `${tag} line ${i} ${"x".repeat(40)}`).join("\n")}\n`;
}

describe("runs diff — full-diff emission (stdout drain)", () => {
  test("emits every file in the snapshot ref, not just the first (pipe not truncated)", () => {
    const repo = mkdtempSync(join(tmpdir(), "diff-drain-"));
    const dbPath = join(repo, "t.db");
    const runId = "01m399yz74x088hgpcykrbdeew";
    const N = 24;
    try {
      const ident = {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      };
      git(repo, ["init", "-q", "-b", "main"]);
      git(repo, ["config", "commit.gpgsign", "false"]);
      for (let i = 0; i < N; i++) writeFileSync(join(repo, `f${String(i).padStart(2, "0")}.txt`), bigLines("base"));
      git(repo, ["add", "-A"], ident);
      git(repo, ["commit", "-qm", "base"], ident);
      const base = git(repo, ["rev-parse", "HEAD"]);

      // The run's worktree: rewrite every file, snapshot the tree into
      // refs/fragua/snapshots/<run>, then remove the worktree (the completed,
      // disposed state the diff runs against).
      const wt = mkdtempSync(join(tmpdir(), "diff-drain-wt-"));
      git(repo, ["worktree", "add", "-q", "--detach", wt, base]);
      for (let i = 0; i < N; i++) writeFileSync(join(wt, `f${String(i).padStart(2, "0")}.txt`), bigLines("run"));
      const snapTree = git(wt, ["add", "-A"], ident) || git(wt, ["write-tree"], ident);
      const commitSha = git(repo, ["commit-tree", snapTree, "-p", base, "-m", "snap"], ident);
      git(repo, ["update-ref", `refs/fragua/snapshots/${runId}`, commitSha]);
      git(repo, ["worktree", "remove", "--force", wt]);

      const filesInSnapshot = git(repo, ["diff", "--name-only", `${base}..${commitSha}`])
        .split("\n")
        .filter((l) => l.length > 0).length;
      expect(filesInSnapshot).toBe(N);

      // Seed a completed run pointing cwd at the repo and a terminal
      // snapshot_recorded fact at the snapshot commit.
      const store = new SqliteStore({ path: dbPath });
      store.saveWorkflow("wf", "test-wf", WF_SRC, serializeGraph(parseWorkflow(WF_SRC)), CURRENT_IR_VERSION);
      store.enqueueRun({ runId, workflowSha: "wf", cwd: repo });
      const s0 = store.getState(runId)!;
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_started",
            payload: {
              workflowSha: "wf",
              contractVersion: s0.contractVersion,
              startNode: "n1",
              baseGitSha: base,
              baseGitRef: "main",
            },
          },
        ],
        s0.version,
      );
      const s1 = store.getState(runId)!;
      store.appendFact(
        runId,
        [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
        s1.version,
      );
      const s2 = store.getState(runId)!;
      store.appendFact(
        runId,
        [
          {
            type: "fact.snapshot_recorded",
            payload: {
              eventIdx: s2.nextSeq - 1,
              treeSha: snapTree,
              commitSha,
              parentSnap: base,
              headSha: base,
              headRef: null,
              diffBaseSha: base,
              committed: null,
              uncommitted: { filesChanged: N, insertions: N * 80, deletions: N * 80 },
            },
          },
        ],
        s2.version,
      );
      store.close();

      // The operator's case: stdout through a real shell pipe. `| cat` gives
      // the bin a non-blocking OS pipe whose 64KB buffer truncates a
      // fire-and-forget write; `cat` then relays whatever survived.
      const cmd = `bun ${JSON.stringify(BIN)} runs diff ${runId} --db ${JSON.stringify(dbPath)} 2>/dev/null | cat`;
      const out = execFileSync("sh", ["-c", cmd], {
        maxBuffer: 256 * 1024 * 1024,
      }).toString();
      const emitted = (out.match(/^diff --git/gm) ?? []).length;
      expect(emitted).toBe(filesInSnapshot);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
