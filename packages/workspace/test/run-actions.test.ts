// applyAccept / applyDiscard against real temp git repos.
// Matrix: dirt-only / commits-only / both × target-at-base / moved /
// conflict, plus author + message preservation and "untouched on conflict".
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAccept, applyDiscard, defaultGitExec, type GitExec, type RunActionGate } from "../src/run-actions.ts";

const git: GitExec = defaultGitExec;
const RUN = "run";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lines(): string {
  return `${Array.from({ length: 12 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`).join("\n")}\n`;
}
async function must(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Operator repo on `main` at BASE. Returns { cwd, base }. */
async function setupRepo(): Promise<{ cwd: string; base: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "ra-"));
  dirs.push(cwd);
  await must(cwd, ["init", "-q", "-b", "main"]);
  await must(cwd, ["config", "user.name", "Operator"]);
  await must(cwd, ["config", "user.email", "op@ex"]);
  writeFileSync(join(cwd, "f.txt"), lines());
  await must(cwd, ["add", "-A"]);
  await must(cwd, ["commit", "-qm", "base"]);
  return { cwd, base: await must(cwd, ["rev-parse", "HEAD"]) };
}

/** Build the run's refs (snapshots + heads) via a throwaway worktree, then
 * remove it — mirroring the post-dispose state applyAccept consumes. */
async function makeRun(cwd: string, base: string, nCommits: number, dirt: boolean): Promise<void> {
  const wt = mkdtempSync(join(tmpdir(), "ra-wt-"));
  dirs.push(wt);
  await must(cwd, ["worktree", "add", "-q", "--detach", wt, base]);
  const edit = (from: string, to: string) => {
    const content = lines().replace(`${from}\n`, `${to}\n`);
    writeFileSync(join(wt, "f.txt"), content);
  };
  let content = lines();
  const rewrite = () => writeFileSync(join(wt, "f.txt"), content);
  if (nCommits >= 1) {
    content = content.replace("L02\n", "L02-RUN\n");
    rewrite();
    await must(wt, ["commit", "-qam", "[run] edit L02", "--author=Bot <bot@fragua>"]);
  }
  if (nCommits >= 2) {
    content = content.replace("L04\n", "L04-RUN\n");
    rewrite();
    await must(wt, ["commit", "-qam", "[run] edit L04", "--author=Bot <bot@fragua>"]);
  }
  if (dirt) {
    content = content.replace("L06\n", "L06-DIRT\n");
    rewrite();
  }
  void edit;
  await must(wt, ["add", "-A"]);
  const snTree = await must(wt, ["write-tree"]);
  const runHead = await must(wt, ["rev-parse", "HEAD"]);
  const snapCommit = await must(cwd, ["commit-tree", snTree, "-p", runHead, "-m", "fragua-snap"]);
  await must(cwd, ["update-ref", `refs/fragua/snapshots/${RUN}`, snapCommit]);
  if (nCommits >= 1) await must(cwd, ["update-ref", `refs/fragua/heads/${RUN}`, runHead]);
  await must(cwd, ["worktree", "remove", "--force", wt]);
}

async function moveTarget(cwd: string, label: string): Promise<void> {
  const content = lines().replace(`${label}\n`, `${label}-USER\n`);
  writeFileSync(join(cwd, "f.txt"), content);
  await must(cwd, ["commit", "-qam", `user moves ${label}`]);
}

const has = async (cwd: string, needle: string) => (await must(cwd, ["show", "HEAD:f.txt"])).includes(needle);
const staged = async (cwd: string) => (await git(cwd, ["diff", "--cached", "--name-only"])).stdout.trim();
const clean = async (cwd: string) => (await git(cwd, ["status", "--porcelain"])).stdout.trim() === "";

/** A gate that passes every state precondition, isolating the git behaviour. */
const gate = (cwd: string, baseGitSha: string): RunActionGate => ({
  runId: RUN,
  status: "completed",
  inboxStatus: "pending",
  cwd,
  baseGitSha,
});

describe("applyAccept", () => {
  test("A. dirt-only, target==base → stages the tail, branch not advanced", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r).toEqual({ ok: true, sha: base, replayed: 0, tailStaged: true });
    expect(await staged(cwd)).toBe("f.txt");
    expect((await must(cwd, ["show", ":f.txt"])).includes("L06-DIRT")).toBe(true); // staged content
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(base); // no commit authored
  });

  test("B. dirt-only, target moved (non-conflict) → 3-way stages tail, keeps user change", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    await moveTarget(cwd, "L11");
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(true);
    const idx = await must(cwd, ["show", ":f.txt"]);
    expect(idx.includes("L06-DIRT")).toBe(true);
    expect(idx.includes("L11-USER")).toBe(true);
  });

  test("C. dirt-only, target moved CONFLICT → revive, repo untouched", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    await moveTarget(cwd, "L06"); // same line as the dirt
    const saved = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });

  test("D. commits-only (2), target==base → replays, author preserved", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 2, false);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r).toMatchObject({ ok: true, replayed: 2, tailStaged: false });
    expect(await has(cwd, "L02-RUN")).toBe(true);
    expect(await has(cwd, "L04-RUN")).toBe(true);
    const authors = await must(cwd, ["log", "-2", "--format=%ae"]);
    expect(authors.split("\n")).toEqual(["bot@fragua", "bot@fragua"]);
    expect(await clean(cwd)).toBe(true);
  });

  test("E. commits-only (2), target moved (non-conflict) → replays onto moved tip", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 2, false);
    await moveTarget(cwd, "L11");
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(true);
    expect(await has(cwd, "L02-RUN")).toBe(true);
    expect(await has(cwd, "L11-USER")).toBe(true);
    expect(await must(cwd, ["log", "-1", "--format=%ae"])).toBe("bot@fragua");
  });

  test("F. commits(1)+dirt → replays commit, stages tail", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, true);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r).toMatchObject({ ok: true, replayed: 1, tailStaged: true });
    expect(await has(cwd, "L02-RUN")).toBe(true); // committed
    expect(await must(cwd, ["log", "-1", "--format=%ae"])).toBe("bot@fragua");
    expect((await must(cwd, ["show", ":f.txt"])).includes("L06-DIRT")).toBe(true); // staged tail
    expect(await staged(cwd)).toBe("f.txt");
  });

  test("G. commits(1), target moved CONFLICT → revive, repo untouched", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, false);
    await moveTarget(cwd, "L02"); // same line as the run commit
    const saved = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(false);
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });

  test("refuses on a dirty operator tree", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    writeFileSync(join(cwd, "f.txt"), lines().replace("L01\n", "LOCAL\n")); // operator's own dirt
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dirty_tree");
  });

  test("no_work when there is no snapshot ref", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_work");
  });
});

describe("applyAccept --autostash", () => {
  /** Dirty the operator tree in a file the run never touches. */
  const dirtyUnrelated = (cwd: string) => writeFileSync(join(cwd, "unrelated.txt"), "operator's own edit\n");
  const stashCount = async (cwd: string) => (await git(cwd, ["stash", "list"])).stdout.trim();

  test("without the flag, an unrelated dirty file still refuses dirty_tree", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, false);
    dirtyUnrelated(cwd);
    const r = await applyAccept(git, gate(cwd, base));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dirty_tree");
    // The operator's file is left exactly as it was.
    expect((await git(cwd, ["show", ":unrelated.txt"])).exitCode).not.toBe(0); // never staged
    expect(await staged(cwd)).toBe("");
  });

  test("with the flag, lands the run and restores the unrelated dirty file", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, false);
    dirtyUnrelated(cwd);
    const r = await applyAccept(git, gate(cwd, base), { autostash: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stashPopConflict ?? false).toBe(false);
    expect(await has(cwd, "L02-RUN")).toBe(true); // run landed on HEAD
    // The unrelated dirt is back in the working tree, and no stash lingers.
    expect(readFileSync(join(cwd, "unrelated.txt"), "utf8")).toBe("operator's own edit\n");
    expect(await stashCount(cwd)).toBe("");
  });

  test("with the flag, a conflict refusal still restores the dirt", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, false);
    await moveTarget(cwd, "L02"); // HEAD now conflicts with the run's commit
    dirtyUnrelated(cwd);
    const r = await applyAccept(git, gate(cwd, base), { autostash: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
    expect(readFileSync(join(cwd, "unrelated.txt"), "utf8")).toBe("operator's own edit\n");
    expect(await stashCount(cwd)).toBe("");
  });

  test("with the flag, a pop conflict keeps the stash and reports it", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, false); // run lands an edit at L02
    // Operator dirt on the SAME line the run lands → the pop can't reapply.
    writeFileSync(join(cwd, "f.txt"), lines().replace("L02\n", "L02-LOCAL\n"));
    const r = await applyAccept(git, gate(cwd, base), { autostash: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stashPopConflict).toBe(true);
    // The stash is preserved, not dropped — the operator can resolve it.
    expect(await stashCount(cwd)).not.toBe("");
  });
});

describe("applyAccept across a squash-merged base (base not ancestor of HEAD)", () => {
  /** main at BASE → feature branch gains F1 (edits L02) → run refs created off
   * F1 (run commit edits L08) → feature gains F2 (re-edits L02) → feature is
   * SQUASH-merged to main and main is checked out. The run's base (F1) is no
   * longer an ancestor of HEAD, but the run's actual delta (F1..tip = L08
   * only) applies cleanly onto HEAD. */
  async function setupSquashScenario(opts: { mainConflictsWithRun: boolean; dirtOnly?: boolean }): Promise<{
    cwd: string;
    runBase: string;
  }> {
    const { cwd, base } = await setupRepo();
    const write = (content: string) => writeFileSync(join(cwd, "f.txt"), content);

    await must(cwd, ["checkout", "-qb", "feat", base]);
    let featContent = lines().replace("L02\n", "L02-F1\n");
    write(featContent);
    await must(cwd, ["commit", "-qam", "feat: F1"]);
    const runBase = await must(cwd, ["rev-parse", "HEAD"]);

    // Run refs off F1: the run edits L08 — as a workflow commit, or as
    // uncommitted dirt (snapshot-only) when dirtOnly.
    const wt = mkdtempSync(join(tmpdir(), "ra-wt-"));
    dirs.push(wt);
    await must(cwd, ["worktree", "add", "-q", "--detach", wt, runBase]);
    writeFileSync(join(wt, "f.txt"), featContent.replace("L08\n", "L08-RUN\n"));
    if (!opts.dirtOnly) await must(wt, ["commit", "-qam", "[run] edit L08", "--author=Bot <bot@fragua>"]);
    await must(wt, ["add", "-A"]);
    const runHead = await must(wt, ["rev-parse", "HEAD"]);
    const snTree = await must(wt, ["write-tree"]);
    const snapCommit = await must(cwd, ["commit-tree", snTree, "-p", runHead, "-m", "fragua-snap"]);
    await must(cwd, ["update-ref", `refs/fragua/snapshots/${RUN}`, snapCommit]);
    if (!opts.dirtOnly) await must(cwd, ["update-ref", `refs/fragua/heads/${RUN}`, runHead]);
    await must(cwd, ["worktree", "remove", "--force", wt]);

    // Feature moves past the run's base, re-editing the line F1 touched.
    featContent = featContent.replace("L02-F1\n", "L02-F2\n");
    write(featContent);
    await must(cwd, ["commit", "-qam", "feat: F2"]);

    // Squash-merge feature to main: ancestry to F1 is broken.
    await must(cwd, ["checkout", "-q", "main"]);
    await must(cwd, ["merge", "--squash", "-q", "feat"]);
    await must(cwd, ["commit", "-qm", "squash feat (PR 50)"]);

    if (opts.mainConflictsWithRun) {
      // A genuine textual conflict: main re-edits the run's line.
      write(`${(await must(cwd, ["show", "HEAD:f.txt"])).replace("L08", "L08-MAIN")}\n`);
      await must(cwd, ["commit", "-qam", "main edits L08"]);
    }
    return { cwd, runBase };
  }

  test("H. clean run delta lands despite the broken ancestry", async () => {
    const { cwd, runBase } = await setupSquashScenario({ mainConflictsWithRun: false });
    const r = await applyAccept(git, gate(cwd, runBase));
    expect(r).toMatchObject({ ok: true, replayed: 1 });
    expect(await has(cwd, "L08-RUN")).toBe(true); // the run's change landed
    expect(await has(cwd, "L02-F2")).toBe(true); // squashed feature content kept
  });

  test("I. genuine textual conflict still refuses with [conflict], repo untouched", async () => {
    const { cwd, runBase } = await setupSquashScenario({ mainConflictsWithRun: true });
    const saved = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await applyAccept(git, gate(cwd, runBase));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });

  test("J. dirt-only run: clean tail staged via 3-way despite the broken ancestry", async () => {
    const { cwd, runBase } = await setupSquashScenario({ mainConflictsWithRun: false, dirtOnly: true });
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await applyAccept(git, gate(cwd, runBase));
    expect(r).toEqual({ ok: true, sha: head, replayed: 0, tailStaged: true });
    expect(await staged(cwd)).toBe("f.txt");
    const idx = await must(cwd, ["show", ":f.txt"]);
    expect(idx.includes("L08-RUN")).toBe(true); // the run's dirt staged
    expect(idx.includes("L02-F2")).toBe(true); // squashed feature content kept
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(head); // no commit authored
  });

  test("K. dirt-only run: genuine conflict still refuses, repo untouched", async () => {
    const { cwd, runBase } = await setupSquashScenario({ mainConflictsWithRun: true, dirtOnly: true });
    const saved = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await applyAccept(git, gate(cwd, runBase));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });
});

describe("applyDiscard", () => {
  test("deletes both refs; idempotent", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, true);
    const r = await applyDiscard(git, gate(cwd, base));
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    expect(r.refs.sort()).toEqual([`refs/fragua/heads/${RUN}`, `refs/fragua/snapshots/${RUN}`]);
    expect(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/fragua/snapshots/${RUN}`])).toMatchObject({
      exitCode: 1,
    });
    // second discard is a no-op
    const r2 = await applyDiscard(git, gate(cwd, base));
    if (!r2.ok) throw new Error(`expected ok, got ${r2.reason}`);
    expect(r2.refs).toEqual([]);
  });
});

describe("run-action gate (folded into accept/discard)", () => {
  test("not_terminal: a running run is refused before any git", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, { ...gate(cwd, base), status: "running" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_terminal");
  });

  test("not_in_inbox: a terminal run not in the inbox is refused", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, { ...gate(cwd, base), inboxStatus: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_in_inbox");
  });

  test("discarded: an already-discarded run is refused", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, { ...gate(cwd, base), inboxStatus: "discarded" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("discarded");
  });

  test("no_worktree: a bare-cwd run is refused", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, { ...gate(cwd, base), cwd: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_worktree");
  });

  test("discard is gated too", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyDiscard(git, { ...gate(cwd, base), status: "running" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_terminal");
  });
});
