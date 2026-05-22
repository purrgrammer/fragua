// `fragua {branch,commit,merge,discard,diff}` CLI verbs against a live
// HTTP server (no executor — these are post-terminal). Asserts the verb
// posts the right intent / surfaces the server's refusal as a non-zero
// exit. Git mutation (operator-actions.test.ts) and endpoint validation
// (operator-actions.routes.test.ts) are covered in their own suites.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { RunActionExec, RunSnapshotReader } from "@fragua/server";
import { createServer } from "@fragua/server";
import { type IEventStore, SqliteStore } from "@fragua/store";
import {
  acceptCommand,
  budgetCommand,
  cancelCommand,
  discardCommand,
  inboxCommand,
  pauseCommand,
  priorityCommand,
  respondCommand,
  resumeCommand,
  steerCommand,
  unquarantineCommand,
} from "../src/commands/operator.ts";

// Permissive git reader — these tests exercise the CLI client against a fake
// cwd (no real repo), so the snapshot reader (diff) and the accept/discard git
// actions are stubbed satisfiable. The real git lives in @fragua/workspace tests.
const permissiveReader: RunSnapshotReader = {
  lsTree: async () => null,
  showFile: async () => ({ kind: "not_found" }),
  diff: async () => "",
  mergeability: async () => ({ resolved: true, ff: true, conflict: false }),
  refExists: async () => true,
};

const okActions: RunActionExec = {
  accept: async () => ({ ok: true, sha: "tip1", replayed: 1, tailStaged: false }),
  discard: async () => ({ ok: true, refs: [] }),
};

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

interface Rig {
  url: string;
  store: IEventStore;
  close: () => Promise<void>;
}

function rig(): Rig {
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "wf",
    "noop",
    "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  n1: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  const app = createServer({ store, ports: { runSnapshotReader: permissiveReader, runActions: okActions } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    store,
    close: async () => {
      await server.stop(true);
      store.close();
    },
  };
}

/** Seed a terminal run with committed history in the inbox. */
function seedCommitted(store: IEventStore, runId: string): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd: "/tmp/repo" });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf",
          schemaVersion: s0.schemaVersion,
          startNode: "n1",
          baseGitSha: BASE,
          baseGitRef: "main",
        },
      },
    ],
    s0.version,
  );
  const s1 = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "n1" } }], s1.version);
  const s2 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.snapshot_recorded",
        payload: {
          eventIdx: 3,
          treeSha: "t".repeat(40),
          commitSha: "s".repeat(40),
          parentSnap: "",
          headSha: COMMIT,
          headRef: null,
          diffBaseSha: BASE,
          committed: { filesChanged: 1, insertions: 5, deletions: 0 },
          uncommitted: null,
        },
      },
    ],
    s2.version,
  );
}

function lastIntent(store: IEventStore, runId: string): string | undefined {
  const evs = store.getEvents(runId);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i]!.type.startsWith("intent.")) return evs[i]!.type;
  }
  return undefined;
}

describe("fragua operator verbs", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await r.close();
  });

  test("accept: exit 0, appends intent.accept_run", async () => {
    seedCommitted(r.store, "r1");
    const code = await acceptCommand({ runId: "r1", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r1")).toBe("intent.accept_run");
  });

  test("discard: exit 0, appends intent.discard_run", async () => {
    seedCommitted(r.store, "r5");
    const code = await discardCommand({ runId: "r5", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r5")).toBe("intent.discard_run");
  });

  test("accept: unknown run → exit 1 (404 surfaced)", async () => {
    const code = await acceptCommand({ runId: "nope", url: r.url });
    expect(code).toBe(1);
  });

  test("resume: exit 0, appends intent.resume", async () => {
    seedCommitted(r.store, "rr");
    const code = await resumeCommand({ runId: "rr", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rr")).toBe("intent.resume");
  });

  test("cancel: exit 0, appends intent.cancel_requested", async () => {
    seedCommitted(r.store, "rc");
    const code = await cancelCommand({ runId: "rc", reason: "qa", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rc")).toBe("intent.cancel_requested");
  });

  test("unquarantine: missing --resolution → exit 1, no network", async () => {
    const code = await unquarantineCommand({ runId: "rq", url: "http://127.0.0.1:1" });
    expect(code).toBe(1);
  });

  test("steer: exit 0, appends intent.steering_requested", async () => {
    seedCommitted(r.store, "rs");
    const code = await steerCommand({ runId: "rs", text: "skip the migration", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rs")).toBe("intent.steering_requested");
  });

  test("steer: empty text → exit 1, no network", async () => {
    const code = await steerCommand({ runId: "rs", text: "  ", url: "http://127.0.0.1:1" });
    expect(code).toBe(1);
  });

  test("pause: exit 0, appends intent.pause_requested", async () => {
    seedCommitted(r.store, "rp");
    const code = await pauseCommand({ runId: "rp", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rp")).toBe("intent.pause_requested");
  });

  test("priority: exit 0, appends intent.priority_adjusted", async () => {
    seedCommitted(r.store, "rpr");
    const code = await priorityCommand({ runId: "rpr", newPriority: 10, url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rpr")).toBe("intent.priority_adjusted");
  });

  test("priority: non-numeric → exit 1, no network", async () => {
    const code = await priorityCommand({ runId: "rpr", newPriority: Number.NaN, url: "http://127.0.0.1:1" });
    expect(code).toBe(1);
  });

  test("budget: exit 0, appends intent.budget_adjusted", async () => {
    seedCommitted(r.store, "rb");
    const code = await budgetCommand({ runId: "rb", scope: "run", metric: "cost", newLimit: 5, url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rb")).toBe("intent.budget_adjusted");
  });

  test("budget: missing flags → exit 1, no network", async () => {
    const code = await budgetCommand({ runId: "rb", url: "http://127.0.0.1:1" });
    expect(code).toBe(1);
  });

  test("respond: run not at a HITL gate → exit 1", async () => {
    seedCommitted(r.store, "rh"); // terminal, not paused_human
    const code = await respondCommand({ runId: "rh", route: "approve", url: r.url });
    expect(code).toBe(1);
  });

  test("inbox: lists pending runs by id, filters cwd, exit 0", async () => {
    seedCommitted(r.store, "in-1"); // committed-history → inbox_status=pending, cwd=/tmp/repo
    const logs: string[] = [];
    (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const code = await inboxCommand({ url: r.url, cwd: "/tmp/repo" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("in-1");
    expect(out).toContain("+5"); // committed stat round-trips server → adapter → CLI
  });
});
