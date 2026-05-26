// Composition test for the worktree+snapshot DESIGN, end-to-end through the
// REAL snapshotter (not synthetic refs): captureSnapshot → buildRunGitBundle →
// rehydrateRunWorktree → assert the rehydrated worktree faithfully reproduces
// the captured state. Covers the git-tree edge cases where snapshot/bundle
// assumptions usually break — additions, modifications, deletions, the
// executable bit, symlinks, binary files, .gitignore, and a multi-snapshot
// chain. Tree fidelity only; the run-row bundling is covered by store + cli
// tests.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunGitBundle, defaultGitExec, rehydrateRunWorktree } from "@fragua/workspace";
import { captureSnapshot } from "../src/snapshotter.ts";

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fragua-snapbundle-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function gitSync(cwd: string, args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** A repo with a base commit (`base.txt`) + fileMode tracking on. */
function initRepo(): { repo: string; baseSha: string } {
  const repo = join(freshDir(), "repo");
  mkdirSync(repo, { recursive: true });
  gitSync(repo, ["init", "-q"]);
  gitSync(repo, ["config", "core.fileMode", "true"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  gitSync(repo, ["add", "-A"]);
  gitSync(repo, ["commit", "-q", "-m", "base"]);
  return { repo, baseSha: gitSync(repo, ["rev-parse", "HEAD"]) };
}

/** Snapshot `repo`'s current working state with the REAL snapshotter, bundle
 *  it, and rehydrate into a fresh host repo. Returns the checked-out worktree. */
async function roundTrip(repo: string, baseSha: string, runId: string): Promise<string> {
  const snap = await captureSnapshot({
    worktree: repo,
    runId,
    baseGitSha: baseSha,
    parentSnap: "",
    boundary: "terminal",
  });
  expect(snap).not.toBeNull();
  const bundle = await buildRunGitBundle(defaultGitExec, repo, runId, baseSha, snap?.diffBaseSha ?? baseSha);
  expect(bundle).not.toBeNull();

  const host = join(freshDir(), "host");
  mkdirSync(host, { recursive: true });
  await defaultGitExec(host, ["init", "-q"]);
  const res = await rehydrateRunWorktree(defaultGitExec, host, runId, bundle ?? new Uint8Array());
  expect(res.ok).toBe(true);
  return res.ok ? res.worktree : "";
}

describe("snapshot → bundle → rehydrate (real snapshotter)", () => {
  test("additions, modifications, and deletions all travel", async () => {
    const { repo, baseSha } = initRepo();
    // A tracked file to delete: commit it (HEAD moves off base).
    writeFileSync(join(repo, "del.txt"), "doomed\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "add del.txt"]);
    // Working state: delete a tracked file, modify another, add a new one.
    rmSync(join(repo, "del.txt"));
    writeFileSync(join(repo, "base.txt"), "base-modified\n");
    writeFileSync(join(repo, "added.txt"), "added\n");

    const wt = await roundTrip(repo, baseSha, "run_add_mod_del");
    expect(existsSync(join(wt, "del.txt"))).toBe(false); // deletion travelled
    expect(readFileSync(join(wt, "base.txt"), "utf8")).toBe("base-modified\n"); // modification
    expect(readFileSync(join(wt, "added.txt"), "utf8")).toBe("added\n"); // addition
  });

  test("the executable bit is preserved", async () => {
    const { repo, baseSha } = initRepo();
    const script = join(repo, "run.sh");
    writeFileSync(script, "#!/bin/sh\necho hi\n");
    chmodSync(script, 0o755);

    const wt = await roundTrip(repo, baseSha, "run_mode");
    expect(lstatSync(join(wt, "run.sh")).mode & 0o111).not.toBe(0); // an exec bit survived
  });

  test("symlinks are preserved (as links, not dereferenced)", async () => {
    const { repo, baseSha } = initRepo();
    symlinkSync("base.txt", join(repo, "link"));

    const wt = await roundTrip(repo, baseSha, "run_link");
    const st = lstatSync(join(wt, "link"));
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(wt, "link"))).toBe("base.txt");
  });

  test("binary files round-trip byte-for-byte", async () => {
    const { repo, baseSha } = initRepo();
    const bin = new Uint8Array([0, 1, 2, 255, 254, 0, 128, 42, 13, 10]);
    writeFileSync(join(repo, "data.bin"), bin);

    const wt = await roundTrip(repo, baseSha, "run_bin");
    expect(new Uint8Array(readFileSync(join(wt, "data.bin")))).toEqual(bin);
  });

  test("gitignored files do NOT travel — the snapshot respects .gitignore", async () => {
    const { repo, baseSha } = initRepo();
    writeFileSync(join(repo, ".gitignore"), "ignored/\nsecret.env\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "gitignore"]);
    // Untracked-ignored content (secrets / build junk) + a tracked addition.
    mkdirSync(join(repo, "ignored"));
    writeFileSync(join(repo, "ignored/junk.txt"), "junk\n");
    writeFileSync(join(repo, "secret.env"), "SECRET=xyz\n");
    writeFileSync(join(repo, "tracked.txt"), "tracked\n");

    const wt = await roundTrip(repo, baseSha, "run_ignore");
    expect(existsSync(join(wt, "secret.env"))).toBe(false); // ignored secret didn't leak
    expect(existsSync(join(wt, "ignored/junk.txt"))).toBe(false); // ignored junk didn't travel
    expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("tracked\n"); // tracked addition did
  });

  test("a multi-snapshot chain travels; the tip rehydrates with every change", async () => {
    const { repo, baseSha } = initRepo();
    const runId = "run_multi";

    writeFileSync(join(repo, "s1.txt"), "one\n");
    const snap1 = await captureSnapshot({
      worktree: repo,
      runId,
      baseGitSha: baseSha,
      parentSnap: "",
      boundary: "step",
    });
    expect(snap1).not.toBeNull();
    if (snap1 == null) return;
    writeFileSync(join(repo, "s2.txt"), "two\n");
    const snap2 = await captureSnapshot({
      worktree: repo,
      runId,
      baseGitSha: baseSha,
      parentSnap: snap1.commitSha,
      boundary: "terminal",
      prevTreeSha: snap1.treeSha,
    });
    expect(snap2).not.toBeNull();
    if (snap2 == null) return;

    const bundle = await buildRunGitBundle(defaultGitExec, repo, runId, baseSha, snap2.diffBaseSha ?? baseSha);
    const host = join(freshDir(), "host");
    mkdirSync(host, { recursive: true });
    await defaultGitExec(host, ["init", "-q"]);
    const res = await rehydrateRunWorktree(defaultGitExec, host, runId, bundle ?? new Uint8Array());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The tip carries both changes.
    expect(readFileSync(join(res.worktree, "s1.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(res.worktree, "s2.txt"), "utf8")).toBe("two\n");
    // The chain self-contained: snap2's parent (snap1) travelled into the host.
    expect(gitSync(host, ["rev-parse", `refs/fragua/snapshots/${runId}^`])).toBe(snap1.commitSha);
  });
});
