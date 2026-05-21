// POST /runs/:id/{accept,discard} — operator post-run primitives
// (docs/proposals/worktrees.md). The intent write is asserted via the run's
// event log; the daemon sweep (operator-actions.test.ts) folds it into the
// git mutation + fact.

import { beforeEach, describe, expect, test } from "bun:test";
import { type IEventStore, SqliteStore } from "@swarm/store";
import { createRoutes } from "../../src/store/routes.ts";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

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

  test("accept: 200 + intent.accept_run on a recoverable run", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r1" });
    const res = await app.request("/runs/r1/accept", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("seq");
    expect(lastIntent(store, "r1")).toBe("intent.accept_run");
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
    const res = await app.request("/runs/r11/accept", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "not_in_inbox" });
  });

  test("409 discarded after a discard fact", async () => {
    const app = createRoutes({ store });
    seed(store, { runId: "r12", discard: true });
    const res = await app.request("/runs/r12/accept", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "discarded" });
  });

  test("404 on an unknown run", async () => {
    const app = createRoutes({ store });
    const res = await app.request("/runs/nope/discard", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
