// applyAccept / applyDiscard against real temp git repos.
// Matrix: dirt-only / commits-only / both × target-at-base / moved /
// conflict, plus author + message preservation and "untouched on conflict".
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAccept, applyDiscard, defaultGitExec, type GitExec } from "../src/run-actions.ts";

const git: GitExec = defaultGitExec;
const RUN = "run";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function lines(): string {
  return Array.from({ length: 12 }, (_, i) => `L${String(i + 1).padStart(2, "0")}`).join("\n") + "\n";
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

describe("applyAccept", () => {
  test("A. dirt-only, target==base → stages the tail, branch not advanced", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r).toEqual({ ok: true, sha: base, replayed: 0, tailStaged: true });
    expect(await staged(cwd)).toBe("f.txt");
    expect((await must(cwd, ["show", ":f.txt"])).includes("L06-DIRT")).toBe(true); // staged content
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(base); // no commit authored
  });

  test("B. dirt-only, target moved (non-conflict) → 3-way stages tail, keeps user change", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    await moveTarget(cwd, "L11");
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
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
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("conflict");
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });

  test("D. commits-only (2), target==base → replays, author preserved", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 2, false);
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
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
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r.ok).toBe(true);
    expect(await has(cwd, "L02-RUN")).toBe(true);
    expect(await has(cwd, "L11-USER")).toBe(true);
    expect(await must(cwd, ["log", "-1", "--format=%ae"])).toBe("bot@fragua");
  });

  test("F. commits(1)+dirt → replays commit, stages tail", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, true);
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
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
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r.ok).toBe(false);
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(saved);
    expect(await clean(cwd)).toBe(true);
  });

  test("refuses on a dirty operator tree", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 0, true);
    writeFileSync(join(cwd, "f.txt"), lines().replace("L01\n", "LOCAL\n")); // operator's own dirt
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("dirty_tree");
  });

  test("no_work when there is no snapshot ref", async () => {
    const { cwd, base } = await setupRepo();
    const r = await applyAccept(git, { cwd, runId: RUN, baseGitSha: base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_work");
  });
});

describe("applyDiscard", () => {
  test("deletes both refs; idempotent", async () => {
    const { cwd, base } = await setupRepo();
    await makeRun(cwd, base, 1, true);
    const r = await applyDiscard(git, cwd, RUN);
    expect(r.refs.sort()).toEqual([`refs/fragua/heads/${RUN}`, `refs/fragua/snapshots/${RUN}`]);
    expect(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/fragua/snapshots/${RUN}`])).toMatchObject({
      exitCode: 1,
    });
    // second discard is a no-op
    expect((await applyDiscard(git, cwd, RUN)).refs).toEqual([]);
  });
});
