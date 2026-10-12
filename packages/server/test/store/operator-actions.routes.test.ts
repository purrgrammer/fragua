// POST /runs/:id/{accept,discard} — operator post-run primitives.
// The intent write is asserted via the run's event log; the daemon sweep
// (operator-actions.test.ts) folds it into the git mutation + fact.

import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { type IEventStore, SqliteStore } from "@fragua/store";
import type { RunActionExec } from "../../src/ports.ts";
import { createRoutes } from "../../src/store/routes.ts";

// Stub the synchronous git action so route tests assert the route's job (gate
// → run action → on ok append intent + return result; on fail 409) without a
// real repo. The real applyAccept/applyDiscard are covered in @fragua/workspace.
const okActions: RunActionExec = {
  accept: async () => ({ ok: true, sha: "tip1", replayed: 1, tailStaged: false }),
  discard: async () => ({ ok: true, refs: ["refs/fragua/snapshots/x", "refs/fragua/heads/x"] }),
};

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
          contractVersion: s0.contractVersion,
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
  store.appendFact(
    o.runId,
    [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
    s1.version,
  );
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
    store.saveWorkflow(
      "wf",
      "noop",
      "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n",
      serializeGraph(parseWorkflow("name: t\nsteps:\n  n1: {type: llm, prompt: x}\n")),
      CURRENT_IR_VERSION,
    );
  });

  test("accept: 200 with the sync result + intent.accept_run on a recoverable run", async () => {
    const app = createRoutes({ store, runActions: okActions });
    seed(store, { runId: "r1" });
    const res = await app.request("/runs/r1/accept", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sha: "tip1", replayed: 1, tailStaged: false });
    expect(lastIntent(store, "r1")).toBe("intent.accept_run");
  });

  test("accept: 200 response carries landedUnstaged for a dirty-base land", async () => {
    let seenGate: { baseHeadSha: string | null; diffBaseSha: string | null } | undefined;
    const dirtyActions: RunActionExec = {
      ...okActions,
      accept: async (gate) => {
        seenGate = gate;
        return { ok: true, sha: "head1", replayed: 0, tailStaged: false, landedUnstaged: true };
      },
    };
    const app = createRoutes({ store, runActions: dirtyActions });
    seed(store, { runId: "rd" });
    const res = await app.request("/runs/rd/accept", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sha: "head1", replayed: 0, tailStaged: false, landedUnstaged: true });
    expect(seenGate?.diffBaseSha).toBe(BASE);
    const intent = store
      .getEvents("rd")
      .filter((e) => e.type === "intent.accept_run")
      .at(-1);
    expect(intent?.payload).toEqual({ sha: "head1", replayed: 0, tailStaged: false, landedUnstaged: true });
  });

  test("accept: 409 checkout_busy with the CLI's message when run.cwd's checkout is held", async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "srv-busy-")));
    try {
      spawnSync("git", ["init", "-q", repo]);
      writeFileSync(join(repo, "a.txt"), "a\n");
      spawnSync("git", ["-C", repo, "add", "-A"]);
      spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]);
      store.enqueueRun({ runId: "holder", workflowSha: "wf", cwd: repo, inCheckout: true, checkoutPath: repo });
      seed(store, { runId: "rb", cwd: repo });
      // the real workspace accept: the busy gate refuses before any git write
      const app = createRoutes({ store });
      const res = await app.request("/runs/rb/accept", { method: "POST" });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        code: "checkout_busy",
        error: `checkout ${repo} is held by run holder (queued); wait for it to finish, or run \`fragua runs release holder\` once it is terminal`,
      });
      expect(lastIntent(store, "rb")).not.toBe("intent.accept_run");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("unquarantine: 409 checkout_replay for retry and treat_as_done on an in-checkout run", async () => {
    const app = createRoutes({ store, runActions: okActions });
    store.enqueueRun({ runId: "rq", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/tmp/co" });
    for (const resolution of ["retry", "treat_as_done"]) {
      const res = await app.request("/runs/rq/unquarantine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as { code?: string }).toMatchObject({ code: "checkout_replay" });
    }
    expect(lastIntent(store, "rq")).toBe("intent.run_enqueued");
    const cancel = await app.request("/runs/rq/unquarantine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "cancel" }),
    });
    expect(cancel.status).toBeLessThan(300);
    expect(lastIntent(store, "rq")).toBe("intent.unquarantine");
  });

  test("unquarantine: 404 for an unknown run", async () => {
    const app = createRoutes({ store, runActions: okActions });
    const res = await app.request("/runs/nope/unquarantine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolution: "cancel" }),
    });
    expect(res.status).toBe(404);
  });

  test("accept: 409 passes checkout_moved through as code", async () => {
    const movedActions: RunActionExec = {
      ...okActions,
      accept: async () => ({ ok: false, reason: "checkout_moved", detail: "HEAD is abc1234" }),
    };
    const app = createRoutes({ store, runActions: movedActions });
    seed(store, { runId: "rm" });
    const res = await app.request("/runs/rm/accept", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "checkout_moved" });
    expect(lastIntent(store, "rm")).not.toBe("intent.accept_run");
  });

  test("accept: 409 with the reason + no intent when the action refuses (conflict)", async () => {
    const conflictActions: RunActionExec = {
      ...okActions,
      accept: async () => ({ ok: false, reason: "conflict", detail: "run does not merge cleanly onto HEAD" }),
    };
    const app = createRoutes({ store, runActions: conflictActions });
    seed(store, { runId: "rc" });
    const res = await app.request("/runs/rc/accept", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "conflict" });
    expect(lastIntent(store, "rc")).not.toBe("intent.accept_run"); // refusal appends no accept intent
  });

  test("discard: 200 + intent.discard_run", async () => {
    const app = createRoutes({ store, runActions: okActions });
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
