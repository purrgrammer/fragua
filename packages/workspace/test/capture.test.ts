import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureBaseOver,
  captureTree,
  fraguaStateExcludes,
  isFraguaStatePath,
  pinDirtyBaseRef,
  prepareDirtyBase,
} from "../src/capture.ts";
import { defaultGitExec as git } from "../src/run-actions.ts";

setDefaultTimeout(30_000);

const FRAGUA_BLOCK = ".fragua/runs/\n.fragua/worktrees/\n.fragua/blobs/\n.fragua/fragua.db*\n.fragua/daemon/\n";
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function must(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function repo(opts: { ignoreBlock?: boolean; commit?: boolean } = {}): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "cap-"));
  dirs.push(cwd);
  await must(cwd, ["init", "-q", "-b", "main"]);
  await must(cwd, ["config", "user.name", "Operator"]);
  await must(cwd, ["config", "user.email", "op@ex"]);
  writeFileSync(join(cwd, ".gitignore"), `${opts.ignoreBlock === false ? "" : FRAGUA_BLOCK}*.log\n`);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  writeFileSync(join(cwd, "b.txt"), "b\n");
  if (opts.commit !== false) {
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-qm", "base"]);
  }
  return cwd;
}

const sentinels = (cwd: string) => readdirSync(join(cwd, ".git")).filter((f) => f.startsWith("fragua-index"));
const lsTree = (cwd: string, tree: string) => must(cwd, ["ls-tree", "-r", "--name-only", tree]);

describe("captureTree", () => {
  test("untouched checkout with skip-worktree and assume-unchanged entries captures tree(HEAD)", async () => {
    const cwd = await repo();
    await must(cwd, ["update-index", "--skip-worktree", "a.txt"]);
    await must(cwd, ["update-index", "--assume-unchanged", "b.txt"]);
    writeFileSync(join(cwd, "a.txt"), "changed a\n");
    writeFileSync(join(cwd, "b.txt"), "changed b\n");
    const tree = await captureTree({ dir: cwd, label: "t", excludes: [] });
    expect(tree).toBe(await must(cwd, ["rev-parse", "HEAD^{tree}"]));
  });

  test("includes untracked, excludes ignored, leaves real index/HEAD and no sentinel", async () => {
    const cwd = await repo();
    writeFileSync(join(cwd, "u.txt"), "u\n");
    writeFileSync(join(cwd, "i.log"), "ignored\n");
    const indexBefore = readFileSync(join(cwd, ".git", "index"));
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    const tree = await captureTree({ dir: cwd, label: "t", excludes: [] });
    const files = await lsTree(cwd, tree);
    expect(files).toContain("u.txt");
    expect(files).not.toContain("i.log");
    expect(readFileSync(join(cwd, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(await must(cwd, ["rev-parse", "HEAD"])).toBe(head);
    expect(sentinels(cwd)).toEqual([]);
  });

  test("state excludes drop run.cwd's .fragua state paths only", async () => {
    const cwd = await repo({ ignoreBlock: false });
    mkdirSync(join(cwd, ".fragua", "runs"), { recursive: true });
    writeFileSync(join(cwd, ".fragua", "runs", "x"), "x\n");
    writeFileSync(join(cwd, ".fragua", "fragua.db"), "db\n");
    writeFileSync(join(cwd, ".fragua", "config.yaml"), "id: x\n");
    const tree = await captureTree({ dir: cwd, label: "t", excludes: fraguaStateExcludes("") });
    const files = await lsTree(cwd, tree);
    expect(files).not.toContain(".fragua/runs/x");
    expect(files).not.toContain(".fragua/fragua.db");
    expect(files).toContain(".fragua/config.yaml");
  });

  test("subdirectory excludes escape wildcard characters in rel", async () => {
    const cwd = await repo({ ignoreBlock: false });
    const rel = "p[1]*";
    mkdirSync(join(cwd, rel, ".fragua", "daemon"), { recursive: true });
    writeFileSync(join(cwd, rel, ".fragua", "daemon", "x"), "x\n");
    writeFileSync(join(cwd, rel, ".fragua", "fragua.db-wal"), "db\n");
    writeFileSync(join(cwd, rel, "keep.txt"), "k\n");
    const tree = await captureTree({ dir: cwd, label: "t", excludes: fraguaStateExcludes(rel) });
    const files = await lsTree(cwd, tree);
    expect(files).not.toContain(`${rel}/.fragua/daemon/x`);
    expect(files).not.toContain(`${rel}/.fragua/fragua.db-wal`);
    expect(files).toContain(`${rel}/keep.txt`);
  });

  test("isFraguaStatePath matches the five state entries under rel", () => {
    expect(isFraguaStatePath(".fragua/runs/a", "")).toBe(true);
    expect(isFraguaStatePath(".fragua/fragua.db-shm", "")).toBe(true);
    expect(isFraguaStatePath(".fragua/config.yaml", "")).toBe(false);
    expect(isFraguaStatePath("sub/.fragua/worktrees/r/x", "sub")).toBe(true);
    expect(isFraguaStatePath(".fragua/worktrees/r/x", "sub")).toBe(false);
  });
});

describe("prepareDirtyBase", () => {
  test("clean tree degenerates to HEAD", async () => {
    const cwd = await repo();
    const r = await prepareDirtyBase(git, cwd);
    if (!r.ok || !r.clean) throw new Error("expected a clean result");
    expect(r.headSha).toBe(await must(cwd, ["rev-parse", "HEAD"]));
    expect(r.baseGitRef).toBe("main");
  });

  test("dirty tree yields S with S^ = HEAD under SNAPSHOT_IDENT", async () => {
    const cwd = await repo();
    writeFileSync(join(cwd, "a.txt"), "wip\n");
    writeFileSync(join(cwd, "u.txt"), "untracked\n");
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await prepareDirtyBase(git, cwd);
    if (!r.ok || r.clean) throw new Error("expected a dirty result");
    expect(r.baseHeadSha).toBe(head);
    expect(await must(cwd, ["rev-parse", `${r.baseGitSha}^`])).toBe(head);
    expect(await lsTree(cwd, r.baseGitSha)).toContain("u.txt");
    expect(await must(cwd, ["log", "-1", "--format=%an <%ae>", r.baseGitSha])).toBe("fragua <fragua@localhost>");
    expect(r.baseGitRef).toBe("main");
    expect(await must(cwd, ["diff", "--cached", "--name-only"])).toBe("");
    expect(sentinels(cwd)).toEqual([]);
  });

  test("refuses not_git / unborn_head / ignore_block_missing", async () => {
    const nogit = mkdtempSync(join(tmpdir(), "cap-nogit-"));
    dirs.push(nogit);
    const a = await prepareDirtyBase(git, nogit);
    expect(a.ok ? null : a.reason).toBe("not_git");

    const unborn = await repo({ commit: false });
    const b = await prepareDirtyBase(git, unborn);
    expect(b.ok ? null : b.reason).toBe("unborn_head");
    if (!b.ok) expect(b.detail).toContain("--dirty needs a commit to capture over:");

    const noBlock = await repo({ ignoreBlock: false });
    writeFileSync(join(noBlock, "a.txt"), "wip\n");
    const c = await prepareDirtyBase(git, noBlock);
    expect(c.ok ? null : c.reason).toBe("ignore_block_missing");
    if (!c.ok) expect(c.detail).toContain("fragua init");

    for (const d of [unborn, noBlock]) {
      expect(await must(d, ["for-each-ref", "refs/fragua"])).toBe("");
    }
  });

  test("pinDirtyBaseRef is idempotent", async () => {
    const cwd = await repo();
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    await pinDirtyBaseRef(cwd, "r1", head);
    await pinDirtyBaseRef(cwd, "r1", head);
    expect(await must(cwd, ["rev-parse", "refs/fragua/bases/r1"])).toBe(head);
  });
});

describe("captureBaseOver", () => {
  test("an untouched checkout with skip-worktree, assume-unchanged and sparse entries captures tree(HEAD)", async () => {
    const cwd = await repo();
    mkdirSync(join(cwd, "sparse"));
    writeFileSync(join(cwd, "sparse", "s.txt"), "s\n");
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-qm", "sparse"]);
    await must(cwd, ["update-index", "--skip-worktree", "a.txt"]);
    await must(cwd, ["update-index", "--assume-unchanged", "b.txt"]);
    writeFileSync(join(cwd, "a.txt"), "changed a\n");
    writeFileSync(join(cwd, "b.txt"), "changed b\n");
    // a sparse entry: skip-worktree and absent from disk
    await must(cwd, ["update-index", "--skip-worktree", "sparse/s.txt"]);
    rmSync(join(cwd, "sparse"), { recursive: true, force: true });
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await captureBaseOver({ top: cwd, head, label: "run1", excludes: [] });
    expect(r.clean).toBe(true);
    expect(sentinels(cwd)).toEqual([]);
  });

  test("a dirty checkout yields S parented on HEAD", async () => {
    const cwd = await repo();
    writeFileSync(join(cwd, "a.txt"), "wip\n");
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    const r = await captureBaseOver({ top: cwd, head, label: "run1", excludes: [] });
    if (r.clean) throw new Error("expected dirty");
    expect(await must(cwd, ["rev-parse", `${r.s}^`])).toBe(head);
  });
});
