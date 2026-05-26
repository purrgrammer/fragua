// Composition test for the worktree+snapshot DESIGN, end-to-end through the
// REAL snapshotter (not synthetic refs): captureSnapshot → buildRunGitBundle →
// rehydrateRunWorktree → assert the rehydrated worktree faithfully reproduces
// the captured state. Covers the git-tree edge cases where snapshot/bundle
// assumptions usually break — additions, modifications, deletions, the
// executable bit, symlinks, binary files, .gitignore, deep/unicode paths, and a
// multi-snapshot chain — plus the host-side stress cases: rehydrating into a
// clone that already shares history, two runs coexisting in one host,
// re-rehydration, and bootstrap regenerating the ignored deps a bundle can't
// carry. Tree fidelity only; the run-row bundling is covered by store + cli
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

/** Snapshot `repo`'s current working state with the REAL snapshotter and package
 *  it as a self-contained git-bundle (terminal boundary). */
async function snapshotAndBundle(repo: string, baseSha: string, runId: string): Promise<Uint8Array> {
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
  return bundle ?? new Uint8Array();
}

/** A fresh, empty host repo sharing no history with any source. */
async function freshHost(): Promise<string> {
  const host = join(freshDir(), "host");
  mkdirSync(host, { recursive: true });
  await defaultGitExec(host, ["init", "-q"]);
  return host;
}

/** Snapshot → bundle → rehydrate into a fresh host. Returns the worktree. */
async function roundTrip(repo: string, baseSha: string, runId: string): Promise<string> {
  const bundle = await snapshotAndBundle(repo, baseSha, runId);
  const res = await rehydrateRunWorktree(defaultGitExec, await freshHost(), runId, bundle);
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
    const host = await freshHost();
    const res = await rehydrateRunWorktree(defaultGitExec, host, runId, bundle ?? new Uint8Array());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The tip carries both changes.
    expect(readFileSync(join(res.worktree, "s1.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(res.worktree, "s2.txt"), "utf8")).toBe("two\n");
    // The chain self-contained: snap2's parent (snap1) travelled into the host.
    expect(gitSync(host, ["rev-parse", `refs/fragua/snapshots/${runId}^`])).toBe(snap1.commitSha);
  });

  test("deep paths and a unicode filename round-trip", async () => {
    const { repo, baseSha } = initRepo();
    mkdirSync(join(repo, "a/b/c/d"), { recursive: true });
    writeFileSync(join(repo, "a/b/c/d/deep.txt"), "deep\n");
    writeFileSync(join(repo, "ünïcøde-文件.txt"), "u\n");

    const wt = await roundTrip(repo, baseSha, "run_paths");
    expect(readFileSync(join(wt, "a/b/c/d/deep.txt"), "utf8")).toBe("deep\n");
    expect(readFileSync(join(wt, "ünïcøde-文件.txt"), "utf8")).toBe("u\n");
  });

  test("rehydrates into a clone that already shares base history (objects overlap)", async () => {
    const { repo, baseSha } = initRepo();
    writeFileSync(join(repo, "feature.txt"), "feature\n"); // uncommitted run state
    const bundle = await snapshotAndBundle(repo, baseSha, "run_clone");

    // The host is a CLONE of the source — it already has base + its objects, so
    // the self-contained bundle's objects overlap what's there. git dedupes on
    // fetch; rehydrate must still succeed without disturbing the host checkout.
    const host = join(freshDir(), "clone");
    await defaultGitExec(freshDir(), ["clone", "-q", repo, host]);
    expect(gitSync(host, ["rev-parse", "HEAD"])).toBe(baseSha); // clone shares the base sha

    const res = await rehydrateRunWorktree(defaultGitExec, host, "run_clone", bundle);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readFileSync(join(res.worktree, "feature.txt"), "utf8")).toBe("feature\n"); // run state arrived
    expect(gitSync(host, ["rev-parse", "HEAD"])).toBe(baseSha); // host's own checkout untouched
  });

  test("two runs rehydrate into one host without colliding (per-run refs + worktrees)", async () => {
    const a = initRepo();
    writeFileSync(join(a.repo, "a.txt"), "alpha\n");
    const bundleA = await snapshotAndBundle(a.repo, a.baseSha, "run_a");
    const b = initRepo();
    writeFileSync(join(b.repo, "b.txt"), "bravo\n");
    const bundleB = await snapshotAndBundle(b.repo, b.baseSha, "run_b");

    const host = await freshHost();
    const resA = await rehydrateRunWorktree(defaultGitExec, host, "run_a", bundleA);
    const resB = await rehydrateRunWorktree(defaultGitExec, host, "run_b", bundleB);
    expect(resA.ok && resB.ok).toBe(true);
    if (!resA.ok || !resB.ok) return;
    // Distinct worktrees, each carrying only its own run's state — no cross-talk.
    expect(resA.worktree).not.toBe(resB.worktree);
    expect(readFileSync(join(resA.worktree, "a.txt"), "utf8")).toBe("alpha\n");
    expect(existsSync(join(resA.worktree, "b.txt"))).toBe(false);
    expect(readFileSync(join(resB.worktree, "b.txt"), "utf8")).toBe("bravo\n");
    expect(existsSync(join(resB.worktree, "a.txt"))).toBe(false);
  });

  test("re-rehydrating the same run reuses the worktree (resume-aware, no error)", async () => {
    const { repo, baseSha } = initRepo();
    writeFileSync(join(repo, "x.txt"), "x\n");
    const bundle = await snapshotAndBundle(repo, baseSha, "run_re");
    const host = await freshHost();

    const first = await rehydrateRunWorktree(defaultGitExec, host, "run_re", bundle);
    expect(first.ok).toBe(true);
    // A second rehydrate of the same run into the same host: WorktreeEnvironment
    // detects the already-registered worktree and reuses it (the same path the
    // executor's provisioner takes on resume) rather than failing on `worktree add`.
    const second = await rehydrateRunWorktree(defaultGitExec, host, "run_re", bundle);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.worktree).toBe(first.worktree);
    expect(readFileSync(join(second.worktree, "x.txt"), "utf8")).toBe("x\n");
  });

  test("rehydrate runs bootstrap — regenerating ignored deps the bundle couldn't carry", async () => {
    const { repo, baseSha } = initRepo();
    // deps/ is an install artifact: gitignored, so it never enters the snapshot.
    writeFileSync(join(repo, ".gitignore"), "deps/\n");
    gitSync(repo, ["add", "-A"]);
    gitSync(repo, ["commit", "-q", "-m", "gitignore"]);
    writeFileSync(join(repo, "src.txt"), "source\n"); // tracked run output → travels
    mkdirSync(join(repo, "deps"));
    writeFileSync(join(repo, "deps/lib"), "installed-in-source\n"); // ignored → does NOT travel

    const bundle = await snapshotAndBundle(repo, baseSha, "run_boot");
    const res = await rehydrateRunWorktree(defaultGitExec, await freshHost(), "run_boot", bundle, {
      bootstrap: "mkdir -p deps && printf regenerated > deps/lib",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bootstrapRan).toBe(true);
    expect(readFileSync(join(res.worktree, "src.txt"), "utf8")).toBe("source\n"); // tracked output travelled
    // deps/ didn't travel (gitignored), but bootstrap regenerated it in the worktree —
    // exactly what a native run's provisioning does.
    expect(readFileSync(join(res.worktree, "deps/lib"), "utf8")).toBe("regenerated");
  });

  test("a failing bootstrap fails the rehydrate (surfaced, not swallowed)", async () => {
    const { repo, baseSha } = initRepo();
    writeFileSync(join(repo, "x.txt"), "x\n");
    const bundle = await snapshotAndBundle(repo, baseSha, "run_bootfail");
    const res = await rehydrateRunWorktree(defaultGitExec, await freshHost(), "run_bootfail", bundle, {
      bootstrap: "exit 7",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("bootstrap");
  });
});
