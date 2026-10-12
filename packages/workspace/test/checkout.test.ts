import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCheckout, resolveCheckoutKey } from "../src/checkout.ts";
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
  const cwd = mkdtempSync(join(tmpdir(), "co-"));
  dirs.push(cwd);
  await must(cwd, ["init", "-q", "-b", "main"]);
  await must(cwd, ["config", "user.name", "Operator"]);
  await must(cwd, ["config", "user.email", "op@ex"]);
  writeFileSync(join(cwd, ".gitignore"), opts.ignoreBlock === false ? "*.log\n" : FRAGUA_BLOCK);
  writeFileSync(join(cwd, "a.txt"), "a\n");
  if (opts.commit !== false) {
    await must(cwd, ["add", "-A"]);
    await must(cwd, ["commit", "-qm", "base"]);
  }
  return cwd;
}

describe("inspectCheckout", () => {
  test("--checkout . from a project subdirectory keys on the realpath toplevel", async () => {
    const cwd = await repo();
    const sub = join(cwd, "proj");
    mkdirSync(sub);
    writeFileSync(join(sub, ".gitignore"), FRAGUA_BLOCK);
    expect(await resolveCheckoutKey(git, sub)).toBe(realpathSync.native(cwd));
    const r = await inspectCheckout(git, { path: sub, runCwd: sub, checkIgnore: true });
    if (!r.ok) throw new Error(r.detail);
    expect(r.key).toBe(realpathSync.native(cwd));
    expect(r.rel).toBe("proj");
    expect(r.ref).toBe("main");
  });

  test("accepts a linked worktree of the same repo", async () => {
    const cwd = await repo();
    const wt = join(mkdtempSync(join(tmpdir(), "co-wt-")), "feature-wt");
    dirs.push(join(wt, ".."));
    await must(cwd, ["worktree", "add", "-q", "-b", "feature", wt]);
    const r = await inspectCheckout(git, { path: wt, runCwd: cwd, checkIgnore: true });
    if (!r.ok) throw new Error(r.detail);
    expect(r.key).toBe(realpathSync.native(wt));
    expect(r.rel).toBeNull();
    expect(r.ref).toBe("feature");
  });

  test("refuses checkout_missing for a nonexistent path", async () => {
    const cwd = await repo();
    const r = await inspectCheckout(git, { path: join(cwd, "nope"), runCwd: cwd, checkIgnore: true });
    expect(r.ok ? "ok" : r.reason).toBe("checkout_missing");
  });

  test("refuses checkout_unregistered for a checkout of another repository", async () => {
    const cwd = await repo();
    const other = await repo();
    const r = await inspectCheckout(git, { path: other, runCwd: cwd, checkIgnore: true });
    expect(r.ok ? "ok" : r.reason).toBe("checkout_unregistered");
  });

  test("refuses checkout_fragua_owned for <cwd>/.fragua/worktrees/<id>", async () => {
    const cwd = await repo();
    const wt = join(cwd, ".fragua", "worktrees", "run1");
    await must(cwd, ["worktree", "add", "-q", "--detach", wt]);
    const r = await inspectCheckout(git, { path: wt, runCwd: cwd, checkIgnore: true });
    expect(r.ok ? "ok" : r.reason).toBe("checkout_fragua_owned");
    const viaStore = await inspectCheckout(git, {
      path: cwd,
      runCwd: cwd,
      checkIgnore: true,
      isRunWorktree: (k) => k === realpathSync.native(cwd),
    });
    expect(viaStore.ok ? "ok" : viaStore.reason).toBe("checkout_fragua_owned");
  });

  test("refuses checkout_unborn on a repo with no commits", async () => {
    const cwd = await repo({ commit: false });
    const r = await inspectCheckout(git, { path: cwd, runCwd: cwd, checkIgnore: true });
    expect(r.ok ? "ok" : r.reason).toBe("checkout_unborn");
  });

  test("refuses ignore_block_missing only when checkIgnore is set", async () => {
    const cwd = await repo({ ignoreBlock: false });
    const r = await inspectCheckout(git, { path: cwd, runCwd: cwd, checkIgnore: true });
    expect(r.ok ? "ok" : r.reason).toBe("ignore_block_missing");
    if (!r.ok) expect(r.detail).toContain("fragua init");
    const attach = await inspectCheckout(git, { path: cwd, runCwd: cwd, checkIgnore: false });
    expect(attach.ok).toBe(true);
  });
});
