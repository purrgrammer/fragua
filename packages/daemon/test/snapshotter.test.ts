import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot, parseShortstat, type SnapshotResult } from "../src/snapshotter.ts";

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** git verb that may legitimately fail (e.g. rev-parse of a missing ref). */
function gStatus(cwd: string, ...args: string[]): number {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status ?? 1;
}

function expectSnapshot(res: SnapshotResult | null): SnapshotResult {
  if (res === null) throw new Error("expected a snapshot, got null (unexpected delta-suppression)");
  return res;
}

describe("captureSnapshot", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "fragua-snap-"));
    g(repo, "init", "-q");
    g(repo, "config", "user.email", "test@fragua.local");
    g(repo, "config", "user.name", "fragua test");
    g(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.txt"), "A\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "A");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("clean worktree → snapshot, no committed/uncommitted delta, no heads ref", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    const res = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r1", baseGitSha: base, parentSnap: base, boundary: "terminal" }),
    );
    expect(res.headSha).toBe(base);
    expect(res.committed).toBeNull();
    expect(res.uncommitted).toBeNull();
    expect(res.diffBaseSha).toBe(base);
    // tip ref points at the snapshot commit; no heads ref since HEAD == base.
    expect(g(repo, "rev-parse", "refs/fragua/snapshots/r1")).toBe(res.commitSha);
    expect(gStatus(repo, "rev-parse", "--verify", "refs/fragua/heads/r1")).not.toBe(0);
    // real index + HEAD untouched, sentinel cleaned up.
    expect(g(repo, "rev-parse", "HEAD")).toBe(base);
    expect(gStatus(repo, "cat-file", "-e", ":fragua-index")).not.toBe(0);
  });

  test("uncommitted dirt → uncommitted delta; snapshot tree captures untracked files", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "new.txt"), "untracked\n");
    await writeFile(join(repo, "a.txt"), "A changed\n");
    const res = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r2", baseGitSha: base, parentSnap: base, boundary: "terminal" }),
    );
    expect(res.uncommitted).not.toBeNull();
    expect(res.uncommitted?.filesChanged).toBeGreaterThanOrEqual(1);
    expect(res.committed).toBeNull();
    const tree = g(repo, "ls-tree", "-r", "--name-only", res.commitSha);
    expect(tree).toContain("new.txt");
    expect(g(repo, "rev-parse", "HEAD")).toBe(base); // HEAD untouched
  });

  test("step boundary computes the uncommitted delta (feeds the per-step Diff selector)", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "a.txt"), "A changed at this step\n");
    const res = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r-step", baseGitSha: base, parentSnap: base, boundary: "step" }),
    );
    expect(res.uncommitted).not.toBeNull();
    expect(res.uncommitted?.filesChanged).toBeGreaterThanOrEqual(1);
    expect(res.committed).toBeNull();
    // headRef / diffBaseSha stay hitl/terminal-only — not recorded per step.
    expect(res.headRef).toBeUndefined();
    expect(res.diffBaseSha).toBeUndefined();
  });

  test("commit-as-you-go → committed delta + heads ref", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "b.txt"), "B\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "B");
    const head = g(repo, "rev-parse", "HEAD");
    const res = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r3", baseGitSha: base, parentSnap: base, boundary: "terminal" }),
    );
    expect(res.headSha).toBe(head);
    expect(res.committed).not.toBeNull();
    expect(res.diffBaseSha).toBe(base); // base is an ancestor of head
    expect(g(repo, "rev-parse", "refs/fragua/heads/r3")).toBe(head);
  });

  test("HEAD relocation (checkout a divergent branch) → diff base is the merge-base", async () => {
    const a = g(repo, "rev-parse", "HEAD");
    g(repo, "branch", "feature", a);
    await writeFile(join(repo, "main.txt"), "main\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "C");
    const mainTip = g(repo, "rev-parse", "HEAD");
    g(repo, "checkout", "-q", "feature");
    await writeFile(join(repo, "feat.txt"), "feat\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "B");
    const featTip = g(repo, "rev-parse", "HEAD");

    // Provisioned from main, but the workflow checked out feature.
    const res = expectSnapshot(
      await captureSnapshot({
        worktree: repo,
        runId: "r4",
        baseGitSha: mainTip,
        parentSnap: mainTip,
        boundary: "terminal",
      }),
    );
    expect(res.headSha).toBe(featTip);
    expect(res.headRef).toBe("feature");
    expect(res.diffBaseSha).toBe(a); // merge-base(mainTip, featTip), not mainTip
  });

  test("delta-suppression: a step snapshot with an unchanged tree returns null", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    const first = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r5", baseGitSha: base, parentSnap: base, boundary: "step" }),
    );
    const second = await captureSnapshot({
      worktree: repo,
      runId: "r5",
      baseGitSha: base,
      parentSnap: first.commitSha,
      boundary: "step",
      prevTreeSha: first.treeSha,
    });
    expect(second).toBeNull();
  });

  test("parentSnap empty → parentless root commit", async () => {
    const base = g(repo, "rev-parse", "HEAD");
    const res = expectSnapshot(
      await captureSnapshot({ worktree: repo, runId: "r6", baseGitSha: base, parentSnap: "", boundary: "step" }),
    );
    expect(g(repo, "rev-list", "--count", res.commitSha)).toBe("1"); // itself only, no parent
  });

  test("parseShortstat parses git diff --shortstat output", () => {
    expect(parseShortstat("")).toBeNull();
    expect(parseShortstat(" 8 files changed, 127 insertions(+), 14 deletions(-)")).toEqual({
      filesChanged: 8,
      insertions: 127,
      deletions: 14,
    });
    expect(parseShortstat(" 1 file changed, 2 insertions(+)")).toEqual({
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });
  });
});
