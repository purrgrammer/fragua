import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countChangedFiles, resolveDefaultBranch, resolveHeadBase } from "../src/base-resolve.ts";
import { defaultGitExec as git } from "../src/run-actions.ts";

setDefaultTimeout(30_000);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function must(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function repo(branch: string, commit = true): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "base-resolve-"));
  dirs.push(cwd);
  await must(cwd, ["init", "-q", "-b", branch]);
  if (commit) {
    writeFileSync(join(cwd, "a.txt"), "a\n");
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-qm", "base"]);
  }
  return cwd;
}

describe("resolveDefaultBranch", () => {
  test("resolveDefaultBranch prefers origin/HEAD over local main", async () => {
    const cwd = await repo("main");
    const head = await must(cwd, ["rev-parse", "HEAD"]);
    await must(cwd, ["update-ref", "refs/remotes/origin/trunk", head]);
    await must(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
    expect(await resolveDefaultBranch(git, cwd)).toBe("trunk");
  });

  test("resolveDefaultBranch falls back to main, then master, else null", async () => {
    expect(await resolveDefaultBranch(git, await repo("main"))).toBe("main");
    expect(await resolveDefaultBranch(git, await repo("master"))).toBe("master");
    expect(await resolveDefaultBranch(git, await repo("trunk"))).toBeNull();
  });
});

describe("resolveHeadBase", () => {
  test("resolveHeadBase reports sha + branch, null ref when detached, not_git / unborn_head otherwise", async () => {
    const onBranch = await repo("feat");
    const sha = await must(onBranch, ["rev-parse", "HEAD"]);
    expect(await resolveHeadBase(git, onBranch)).toEqual({ ok: true, sha, ref: "feat" });

    await must(onBranch, ["checkout", "-q", "--detach"]);
    expect(await resolveHeadBase(git, onBranch)).toEqual({ ok: true, sha, ref: null });

    const notGit = mkdtempSync(join(tmpdir(), "base-resolve-nogit-"));
    dirs.push(notGit);
    expect(await resolveHeadBase(git, notGit)).toEqual({ ok: false, reason: "not_git" });

    expect(await resolveHeadBase(git, await repo("main", false))).toEqual({ ok: false, reason: "unborn_head" });
  });
});

describe("countChangedFiles", () => {
  test("counts the paths that differ between two commits", async () => {
    const cwd = await repo("main");
    const from = await must(cwd, ["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "a.txt"), "changed\n");
    writeFileSync(join(cwd, "b.txt"), "b\n");
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-qm", "two"]);
    expect(await countChangedFiles(git, cwd, from, "HEAD")).toBe(2);
  });
});
