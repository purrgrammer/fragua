// POST /runs/:id/{branch,commit,merge,discard} — operator post-run
// primitives (docs/proposals/worktrees.md §7). Validation is column-based
// for branch/commit; merge additionally consults an injected
// RunSnapshotReader.mergeability. The intent write is asserted via the
// run's event log; the daemon sweep (operator-actions.test.ts) covers the
// git mutation half.

import { beforeEach, describe, expect, test } from "bun:test";
import { type IEventStore, SqliteStore } from "@swarm/store";
import type { RunSnapshotReader } from "../../src/ports.ts";
import { createRoutes } from "../../src/store/routes.ts";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

function fakeReader(mergeability: Awaited<ReturnType<RunSnapshotReader["mergeability"]>>): RunSnapshotReader {
  return {
    lsTree: async () => null,
    showFile: async () => ({ kind: "not_found" }),
    diff: async () => "",
    mergeability: async () => mergeability,
  };
}

interface SeedOpts {
  runId: string;
  cwd?: string | null;
  baseGitRef?: string | null;
  baseGitSha?: string;
  headSha?: string | null;
  headRef?: string | null;
  diffBaseSha?: string;
  committed?: { filesChanged: number; insertions: number; deletions: number } | null;
  uncommitted?: { filesChanged: number; insertions: number; deletions: number } | null;
  terminal?: boolean;
  discard?: boolean;
}

/** Drive a run to terminal with a projected fact.snapshot_recorded. */
function seed(store: IEventStore, o: SeedOpts): void {
  const cwd = o.cwd === undefined ? "/tmp/repo" : o.cwd;
  store.enqueueRun({ runId: o.runId, workflowSha: "wf", ...(cwd != null ? { cwd } : {}) });
  const s0 = store.getState(o.runId)!;
  store.appendFact(
    o.runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf",
          schemaVersion: s0.schemaVersion,
          startNode: "n1",
          baseGitSha: o.baseGitSha ?? BASE,
          ...(o.baseGitRef === undefined
            ? { baseGitRef: "main" }
            : o.baseGitRef === null
              ? {}
              : { baseGitRef: o.baseGitRef }),
        },
      },
    ],
    s0.version,
  );
  if (o.terminal === false) return; // leave it running
  const s1 = store.getState(o.runId)!;
  store.appendFact(o.runId, [{ type: "fact.run_completed", payload: { finalNode: "n1" } }], s1.version);
  const s2 = store.getState(o.runId)!;
  store.appendFact(
    o.runId,
    [
      {
        type: "fact.snapshot_recorded",
        payload: {
          eventIdx: 3,
          treeSha: "t".repeat(40),
          commitSha: "s".repeat(40),
          parentSnap: "",
          headSha: o.headSha === undefined ? COMMIT : o.headSha,
          headRef: o.headRef ?? null,
          diffBaseSha: o.diffBaseSha ?? o.baseGitSha ?? BASE,
          committed: o.committed === undefined ? { filesChanged: 1, insertions: 5, deletions: 0 } : o.committed,
          uncommitted: o.uncommitted ?? null,
        },
      },
    ],
    s2.version,
  );
  if (o.discard === true) {
    const s3 = store.getState(o.runId)!;
    store.appendFact(o.runId, [{ type: "fact.run_discarded", payload: { refs: [] } }], s3.version);
  }
}

function lastIntent(store: IEventStore, runId: string): string | undefined {
  const evs = store.getEvents(runId);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i]!.type.startsWith("intent.")) return evs[i]!.type;
  }
  return undefined;
}

describe("operator post-run primitive endpoints", () => {
  let store: IEventStore;

  beforeEach(() => {
    store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow("wf", "noop", "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n");
  });

  test("branch: 200 + intent.branch_run on a committed-history run", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r1" }); // committed history (headSha=COMMIT != base)
    const res = await app.request("/runs/r1/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "promoted" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("seq");
    expect(lastIntent(store, "r1")).toBe("intent.branch_run");
  });

  test("branch: 400 when branch name missing", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r2" });
    const res = await app.request("/runs/r2/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("branch: 409 nothing_to_branch when the run made no commits", async () => {
    const app = createRoutes({ store });
    // dirt-only: headSha null → no committed history; uncommitted keeps it in inbox
    seed(store, {
      runId: "r3",
      headSha: null,
      committed: null,
      uncommitted: { filesChanged: 1, insertions: 2, deletions: 0 },
    });
    const res = await app.request("/runs/r3/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "x" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "nothing_to_branch" });
  });

  test("commit: 200 + intent.commit_run; 400 without a message", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r4" });
    const ok = await app.request("/runs/r4/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "promote" }),
    });
    expect(ok.status).toBe(200);
    expect(lastIntent(store, "r4")).toBe("intent.commit_run");

    const bad = await app.request("/runs/r4/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
  });

  test("commit: 400 onto_required when provisioned detached and no --onto", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r5", baseGitRef: null });
    const res = await app.request("/runs/r5/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "m" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "onto_required" });
  });

  test("commit: explicit --onto overrides a detached default", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r5b", baseGitRef: null });
    const res = await app.request("/runs/r5b/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "m", onto: "main" }),
    });
    expect(res.status).toBe(200);
    expect(lastIntent(store, "r5b")).toBe("intent.commit_run");
  });

  test("merge: 200 ff when the reader reports fast-forwardable", async () => {
    const app = createRoutes({ store, runSnapshotReader: fakeReader({ resolved: true, ff: true, conflict: false }) });
    seed(store, { runId: "r6" });
    const res = await app.request("/runs/r6/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(lastIntent(store, "r6")).toBe("intent.merge_run");
  });

  test("merge: 409 not_fast_forward when ff requested but not possible", async () => {
    const app = createRoutes({ store, runSnapshotReader: fakeReader({ resolved: true, ff: false, conflict: false }) });
    seed(store, { runId: "r7" });
    const res = await app.request("/runs/r7/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "not_fast_forward" });
  });

  test("merge: 409 merge_conflict on a conflicting no-ff merge", async () => {
    const app = createRoutes({ store, runSnapshotReader: fakeReader({ resolved: true, ff: false, conflict: true }) });
    seed(store, { runId: "r8" });
    const res = await app.request("/runs/r8/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "no-ff" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "merge_conflict" });
  });

  test("merge: 400 on an invalid mode", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r8b" });
    const res = await app.request("/runs/r8b/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "rebase" }),
    });
    expect(res.status).toBe(400);
  });

  test("discard: 200 + intent.discard_run", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r9" });
    const res = await app.request("/runs/r9/discard", { method: "POST" });
    expect(res.status).toBe(200);
    expect(lastIntent(store, "r9")).toBe("intent.discard_run");
  });

  test("409 not_terminal on a still-running run", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r10", terminal: false });
    const res = await app.request("/runs/r10/discard", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "not_terminal" });
  });

  test("409 not_in_inbox on a clean terminal run", async () => {
    const app = createRoutes({ store });
    // no recoverable work: committed=null, uncommitted=null → inboxStatus null
    seed(store, { runId: "r11", committed: null, uncommitted: null });
    const res = await app.request("/runs/r11/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "x" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "not_in_inbox" });
  });

  test("409 discarded after a discard fact", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r12", discard: true });
    const res = await app.request("/runs/r12/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "x" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "discarded" });
  });

  test("404 on an unknown run", async () => {
    const app = createRoutes({ store });
    const res = await app.request("/runs/nope/discard", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
