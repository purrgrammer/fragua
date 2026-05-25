// Integration tests for the snapshot read endpoints.
// Covers:
//   (a) scrubber list (GET /runs/:id/snapshots)
//   (b) tree listing (GET /runs/:id/snapshots/:eventIdx/tree)
//   (c) file read (GET /runs/:id/snapshots/:eventIdx/file)
//   (d) diff (GET /runs/:id/snapshots/:eventIdx/diff)
//
// A real git repo is synthesised under mkdtemp so the git invocations
// hit the actual object database — the same objects the daemon would
// write via git commit-tree. Snapshot commits are made directly with
// `git commit-tree` against the fixture's tree objects so no worktree
// checkout is needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import { createRunSnapshotReader } from "../../src/adapters/run-snapshot-reader.ts";
import { runSnapshotsRoutes } from "../../src/routes/run-snapshots.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

interface SnapFixture {
  cwd: string;
  runId: string;
  baseSha: string;
  snap1CommitSha: string;
  snap1TreeSha: string;
  snap1EventIdx: number;
  snap2CommitSha: string;
  snap2TreeSha: string;
  snap2EventIdx: number;
  store: SqliteStore;
  app: ReturnType<typeof runSnapshotsRoutes>;
}

async function setupFixture(): Promise<SnapFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "fragua-snap-test-"));
  const runId = "snap-run-1";

  // Init a git repo with a base commit
  await git(cwd, ["init", "--quiet", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@test.com"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);

  await writeFile(join(cwd, "base.txt"), "hello from base\n");
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-m", "base", "--no-gpg-sign", "--quiet"]);
  const baseSha = await git(cwd, ["rev-parse", "HEAD"]);

  // Snapshot 1: add snap1.txt
  await writeFile(join(cwd, "snap1.txt"), "snapshot one\n");
  await git(cwd, ["add", "-A"]);
  const snap1TreeSha = await git(cwd, ["write-tree"]);
  const snap1CommitSha = await git(cwd, ["commit-tree", snap1TreeSha, "-p", baseSha, "-m", "snap1"]);
  // Reset index to avoid snap1.txt leaking into snap2
  await git(cwd, ["reset", "--hard", baseSha]);

  // Snapshot 2: add snap2.txt
  await writeFile(join(cwd, "snap2.txt"), "snapshot two\n");
  await git(cwd, ["add", "-A"]);
  const snap2TreeSha = await git(cwd, ["write-tree"]);
  const snap2CommitSha = await git(cwd, ["commit-tree", snap2TreeSha, "-p", snap1CommitSha, "-m", "snap2"]);
  await git(cwd, ["reset", "--hard", baseSha]);

  // Create the tip ref so both snapshot commits are reachable
  await git(cwd, ["update-ref", `refs/fragua/snapshots/${runId}`, snap2CommitSha]);

  // Build the store
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "wf1",
    "noop",
    "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  store.enqueueRun({ runId, workflowSha: "wf1", cwd });

  // Stamp base sha via fact.run_started
  const enqueued = store.getState(runId);
  if (enqueued == null) throw new Error("no state");
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: "wf1", contractVersion: 1, startNode: "n1", baseGitSha: baseSha },
      },
    ],
    enqueued.version,
  );

  // Per-step snapshot.captured (observability)
  store.appendObservabilityEvents(runId, [
    {
      type: "snapshot.captured",
      payload: {
        runId,
        eventIdx: 2,
        nodeId: "step1",
        treeSha: snap1TreeSha,
        commitSha: snap1CommitSha,
        parentSnap: "",
        headSha: null,
      },
    },
  ]);
  const afterObs = store.getSnapshotEvents(runId);
  const snap1EventIdx = afterObs[0]!.seq;

  // Terminal fact.snapshot_recorded
  const state2 = store.getState(runId);
  if (state2 == null) throw new Error("no state2");
  store.appendFact(
    runId,
    [
      {
        type: "fact.snapshot_recorded",
        payload: {
          eventIdx: 3,
          treeSha: snap2TreeSha,
          commitSha: snap2CommitSha,
          parentSnap: snap1CommitSha,
          headSha: null,
          headRef: null,
          diffBaseSha: baseSha,
          committed: null,
          uncommitted: null,
        },
      },
    ],
    state2.version,
  );
  const allSnaps = store.getSnapshotEvents(runId);
  const snap2EventIdx = allSnaps[1]!.seq;

  const reader = createRunSnapshotReader();
  const app = runSnapshotsRoutes({ store, reader });

  return {
    cwd,
    runId,
    baseSha,
    snap1CommitSha,
    snap1TreeSha,
    snap1EventIdx,
    snap2CommitSha,
    snap2TreeSha,
    snap2EventIdx,
    store,
    app,
  };
}

let fx: SnapFixture;

afterEach(async () => {
  fx?.store.close();
  if (fx?.cwd) await rm(fx.cwd, { recursive: true, force: true });
});

async function get(path: string): Promise<Response> {
  return fx.app.fetch(new Request(`http://test${path}`));
}

// ── GET /runs/:id/snapshots ───────────────────────────────────────────

describe("GET /runs/:id/snapshots", () => {
  beforeEach(async () => {
    fx = await setupFixture();
  });

  test("404 when run unknown", async () => {
    const res = await get("/runs/does-not-exist/snapshots");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("empty array when run exists but has no snapshots", async () => {
    // Fresh run with no snapshot events
    fx.store.saveWorkflow(
      "wf_empty",
      "noop2",
      "name: t\nsteps:\n  w: {type: llm, prompt: x}\n",
      serializeGraph(parseWorkflow("name: t\nsteps:\n  w: {type: llm, prompt: x}\n")),
      CURRENT_IR_VERSION,
    );
    fx.store.enqueueRun({ runId: "empty-run", workflowSha: "wf_empty", cwd: fx.cwd });
    const res = await fx.app.fetch(new Request("http://test/runs/empty-run/snapshots"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns ordered items across observability + terminal fact", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{
      eventIdx: number;
      nodeId: string | null;
      label: string;
      commitSha: string;
      treeSha: string;
      committed: unknown;
      uncommitted: unknown;
    }>;

    expect(body.length).toBe(2);

    // First item: per-step snapshot.captured
    expect(body[0]!.label).toBe("step");
    expect(body[0]!.nodeId).toBe("step1");
    expect(body[0]!.commitSha).toBe(fx.snap1CommitSha);
    expect(body[0]!.treeSha).toBe(fx.snap1TreeSha);
    expect(body[0]!.eventIdx).toBe(fx.snap1EventIdx);

    // Second item: terminal fact.snapshot_recorded
    expect(body[1]!.label).toBe("terminal");
    expect(body[1]!.nodeId).toBe(null);
    expect(body[1]!.commitSha).toBe(fx.snap2CommitSha);
    expect(body[1]!.treeSha).toBe(fx.snap2TreeSha);
    expect(body[1]!.eventIdx).toBe(fx.snap2EventIdx);

    // Must be in ascending event order
    expect(body[0]!.eventIdx).toBeLessThan(body[1]!.eventIdx);
  });
});

// ── GET /runs/:id/snapshots/:eventIdx/tree ────────────────────────────

describe("GET /runs/:id/snapshots/:eventIdx/tree", () => {
  beforeEach(async () => {
    fx = await setupFixture();
  });

  test("404 when run unknown", async () => {
    const res = await get(`/runs/no-such-run/snapshots/${fx.snap1EventIdx}/tree`);
    expect(res.status).toBe(404);
  });

  test("404 when eventIdx does not resolve to a snapshot", async () => {
    // seq 1 is fact.run_started, not a snapshot event
    const res = await get(`/runs/${fx.runId}/snapshots/1/tree`);
    expect(res.status).toBe(404);
  });

  test("returns ls-tree entries for resolved commitSha", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/tree`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      entries: Array<{ path: string; mode: string; size: number; type: string }>;
    };
    expect(Array.isArray(body.entries)).toBe(true);

    const baseEntry = body.entries.find((e) => e.path === "base.txt");
    expect(baseEntry).toBeDefined();
    expect(baseEntry!.type).toBe("blob");
    expect(baseEntry!.size).toBeGreaterThan(0);
    expect(baseEntry!.mode.length).toBeGreaterThan(0);

    // snap1.txt was added in snap1 tree
    const snap1Entry = body.entries.find((e) => e.path === "snap1.txt");
    expect(snap1Entry).toBeDefined();
    expect(snap1Entry!.type).toBe("blob");
  });
});

// ── GET /runs/:id/snapshots/:eventIdx/file ────────────────────────────

describe("GET /runs/:id/snapshots/:eventIdx/file", () => {
  beforeEach(async () => {
    fx = await setupFixture();
  });

  test("400 on missing path", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/file`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_path");
  });

  test("400 on traversal path", async () => {
    const res = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/file?path=${encodeURIComponent("../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_path");
  });

  test("200 text/plain with file contents from git show", async () => {
    const res = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/file?path=${encodeURIComponent("base.txt")}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("hello from base\n");
  });

  test("404 when path absent from that snapshot", async () => {
    const res = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/file?path=${encodeURIComponent("no-such-file.txt")}`,
    );
    expect(res.status).toBe(404);
  });

  test("snap1.txt visible in snap1 but not snap2 file listing", async () => {
    // snap1.txt is in snap1 tree
    const res1 = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/file?path=${encodeURIComponent("snap1.txt")}`,
    );
    expect(res1.status).toBe(200);
    expect(await res1.text()).toBe("snapshot one\n");

    // snap1.txt is NOT in snap2 tree (we reset before creating snap2)
    const res2 = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap2EventIdx}/file?path=${encodeURIComponent("snap1.txt")}`,
    );
    expect(res2.status).toBe(404);
  });
});

// ── GET /runs/:id/snapshots/:eventIdx/diff ────────────────────────────

describe("GET /runs/:id/snapshots/:eventIdx/diff", () => {
  beforeEach(async () => {
    fx = await setupFixture();
  });

  test("404 when run unknown", async () => {
    const res = await get(`/runs/no-run/snapshots/${fx.snap1EventIdx}/diff?against=base`);
    expect(res.status).toBe(404);
  });

  test("400 on unknown against= value", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap2EventIdx}/diff?against=garbage`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_against");
  });

  test("against=base diffs snapshot vs diff_base_sha and returns text/x-diff", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/diff?against=base`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/x-diff/);
    const text = await res.text();
    expect(text).toContain("diff --git");
    expect(text).toContain("snap1.txt");
  });

  test("against=previous for first snapshot diffs against base", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/diff?against=previous`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Should show snap1.txt added vs base
    expect(text).toContain("snap1.txt");
  });

  test("against=previous for second snapshot diffs against prior snapshot", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap2EventIdx}/diff?against=previous`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // snap2 tree has snap2.txt (snap1.txt was not included)
    // vs snap1 tree which has snap1.txt — so snap2.txt added, snap1.txt removed
    expect(text).toContain("snap2.txt");
  });

  test("against=<eventIdx> diffs against that snapshot's commit", async () => {
    const res = await get(`/runs/${fx.runId}/snapshots/${fx.snap2EventIdx}/diff?against=${fx.snap1EventIdx}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("diff --git");
  });

  test("path filter scopes the diff", async () => {
    const resAll = await get(`/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/diff?against=base`);
    const allText = await resAll.text();

    const resFiltered = await get(
      `/runs/${fx.runId}/snapshots/${fx.snap1EventIdx}/diff?against=base&path=${encodeURIComponent("snap1.txt")}`,
    );
    expect(resFiltered.status).toBe(200);
    const filteredText = await resFiltered.text();
    // Filtered result should only mention snap1.txt
    expect(filteredText).toContain("snap1.txt");
    // If there are multiple files in allText, filtered should be <= allText length
    expect(filteredText.length).toBeLessThanOrEqual(allText.length + 1);
  });
});
