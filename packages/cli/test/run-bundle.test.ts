// `fragua runs export` / `fragua runs import` command layer. The store-level
// round-trip + fail-closed paths live in @fragua/store's bundle.test.ts; here we
// cover the CLI wiring: export of a real run, import into an EXISTING store
// (import is a migrate:false store-client — it never creates/migrates), and the
// error paths (missing run, absent target store).

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadPlane } from "@fragua/core/read-plane";
import { SqliteStore } from "@fragua/store";
import { defaultGitExec, gitDiff } from "@fragua/workspace";
import { exportCommand, importCommand } from "../src/commands/run-bundle.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });
const dirs: string[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fragua-runbundle-"));
  dirs.push(d);
  return d;
}

/** Create a real file-backed store at `<dir>/store.db`, seed a run with an
 *  artifact (→ a blob in `<dir>/blobs`), and return its path + run id. */
function seedStore(dir: string): { dbPath: string; runId: string } {
  const dbPath = join(dir, "store.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow("wf1", "test", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
  const runId = "run_1";
  store.enqueueRun({ runId, workflowSha: "wf1", priority: 0 });
  store.putArtifact({ runId, nodeId: "work", iteration: 0, key: "out" }, new TextEncoder().encode("hello-bytes"));
  store.close();
  return { dbPath, runId };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe("fragua runs export/import", () => {
  test("export → import round-trips a run (+ its blob) into an existing store", async () => {
    const { dbPath: srcDb, runId } = seedStore(freshDir());
    const dstDir = freshDir();
    const dstDb = join(dstDir, "store.db");
    const bundle = join(dstDir, "r.fragua");
    // The target must already exist — import never creates a store.
    new SqliteStore({ path: dstDb }).close();

    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);
    expect(await importCommand({ bundle, dbPath: dstDb })).toBe(0);

    // src + dst have separate blobs dirs, so a readable artifact on dst proves
    // the blob travelled inside the bundle and was rehydrated.
    const dst = new SqliteStore({ path: dstDb, migrate: false });
    try {
      expect(dst.getState(runId)).not.toBeNull();
      const art = dst.getArtifact({ runId, nodeId: "work", iteration: 0, key: "out" });
      expect(new TextDecoder().decode(art)).toBe("hello-bytes");
    } finally {
      dst.close();
    }
  });

  test("import into an absent store errors (no implicit create/migrate)", async () => {
    const { dbPath: srcDb, runId } = seedStore(freshDir());
    const dstDir = freshDir();
    const bundle = join(dstDir, "r.fragua");
    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);
    // The target db does not exist → migrate:false open fails → exit 1.
    expect(await importCommand({ bundle, dbPath: join(dstDir, "absent.db") })).toBe(1);
  });

  test("export of a missing run errors", async () => {
    const { dbPath: srcDb } = seedStore(freshDir());
    expect(await exportCommand({ runId: "run_nope", to: join(freshDir(), "x.fragua"), dbPath: srcDb })).toBe(1);
  });

  test("import of a missing bundle errors", async () => {
    const { dbPath } = seedStore(freshDir());
    expect(await importCommand({ bundle: join(freshDir(), "nope.fragua"), dbPath })).toBe(1);
  });

  // End-to-end A+B (db-import §3.2): export carries the run's tree state as a
  // git-bundle; `import --rehydrate` rebuilds the worktree at the snapshot tip
  // in a fresh host repo AND the imported run is `runs diff`-able — the snapshot
  // events + base sha travel, and the base↔snapshot range resolves + diffs
  // against the rehydrated repo.
  test("export + import --rehydrate → worktree at snapshot tip, and the run is diff-able", async () => {
    const srcDir = freshDir();
    const repo = join(srcDir, "repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[], env?: Record<string, string>) =>
      Bun.spawnSync({ cmd: ["git", ...args], cwd: repo, ...(env ? { env: { ...process.env, ...env } } : {}) });
    const out = (args: string[], env?: Record<string, string>) =>
      new TextDecoder().decode(git(args, env).stdout).trim();
    const ident = ["-c", "user.name=t", "-c", "user.email=t@t"];

    git(["init", "-q"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(["add", "-A"]);
    git([...ident, "commit", "-q", "-m", "base"]);
    const baseSha = out(["rev-parse", "HEAD"]);

    // The run's working state → a fragua snapshot commit, parented on base (what
    // the snapshotter does: add -A into a sentinel index → write-tree → commit-tree).
    writeFileSync(join(repo, "work.txt"), "work-state\n");
    const idx = join(srcDir, "sentinel-index");
    git(["add", "-A"], { GIT_INDEX_FILE: idx });
    const tree = out(["write-tree"], { GIT_INDEX_FILE: idx });
    const snap = out([...ident, "commit-tree", tree, "-p", baseSha, "-m", "snap"]);
    const runId = "run_rehy";
    git(["update-ref", `refs/fragua/snapshots/${runId}`, snap]);

    // Source store: run pinned to the repo, baseGitSha stamped (fact.run_started),
    // one snapshot event (so diff resolves) — what a real run accumulates.
    const srcDb = join(srcDir, "store.db");
    const s = new SqliteStore({ path: srcDb });
    s.saveWorkflow("wf1", "t", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", STUB_IR, 1);
    s.enqueueRun({ runId, workflowSha: "wf1", cwd: repo });
    s.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf1", contractVersion: 1, startNode: "work", baseGitSha: baseSha },
        },
      ],
      s.getState(runId)!.version,
    );
    s.appendObservabilityEvents(runId, [
      {
        type: "snapshot.captured",
        payload: { runId, eventIdx: 1, nodeId: "work", treeSha: tree, commitSha: snap, parentSnap: "", headSha: null },
      },
    ]);
    s.close();

    const bundle = join(srcDir, "r.fragua");
    expect(await exportCommand({ runId, to: bundle, dbPath: srcDb })).toBe(0);

    // Import + rehydrate into a fresh host repo (git-init'd by --into).
    const hostDir = freshDir();
    const host = join(hostDir, "host");
    const tgtDb = join(hostDir, "store.db");
    new SqliteStore({ path: tgtDb }).close();
    expect(await importCommand({ bundle, dbPath: tgtDb, rehydrate: true, into: host })).toBe(0);

    // (B) worktree at the snapshot tip carries the run's working state.
    const wt = join(host, ".fragua/worktrees", runId);
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(join(wt, "work.txt"), "utf8")).toBe("work-state\n");

    // (last mile) the imported run is diff-able: snapshots resolve, the base↔snap
    // range resolves against the rehydrated repo, and the diff shows the change.
    const tgt = new SqliteStore({ path: tgtDb, migrate: false });
    try {
      expect(tgt.getState(runId)?.cwd).toBe(host);
      const rp = makeReadPlane({ store: tgt });
      const snaps = rp.snapshots(runId);
      expect(snaps?.length ?? 0).toBeGreaterThan(0);
      const range = rp.diffRange(runId, snaps?.[snaps.length - 1]?.eventIdx ?? -1, "base");
      expect(range.ok).toBe(true);
      if (range.ok) {
        const text = await gitDiff(defaultGitExec, range.cwd, range.fromSha, range.toSha);
        expect(text).toContain("work.txt");
      }
    } finally {
      tgt.close();
    }
  });
});
