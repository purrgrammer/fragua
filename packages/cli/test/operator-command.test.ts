// `swarm {branch,commit,merge,discard,diff}` CLI verbs against a live
// HTTP server (no executor — these are post-terminal). Asserts the verb
// posts the right intent / surfaces the server's refusal as a non-zero
// exit. Git mutation (operator-actions.test.ts) and endpoint validation
// (operator-actions.routes.test.ts) are covered in their own suites.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer } from "@swarm/server";
import { type IEventStore, SqliteStore } from "@swarm/store";
import { branchCommand, commitCommand, discardCommand, inboxCommand, mergeCommand } from "../src/commands/operator.ts";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

interface Rig {
  url: string;
  store: IEventStore;
  close: () => Promise<void>;
}

function rig(): Rig {
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf", "noop", "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n");
  const app = createServer({ store });
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

describe("swarm operator verbs", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await r.close();
  });

  test("branch: exit 0, appends intent.branch_run", async () => {
    seedCommitted(r.store, "r1");
    const code = await branchCommand({ runId: "r1", branch: "promoted", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r1")).toBe("intent.branch_run");
  });

  test("commit: -m required → exit 1, no network", async () => {
    const code = await commitCommand({ runId: "r-none", url: "http://127.0.0.1:1" });
    expect(code).toBe(1);
  });

  test("commit: exit 0, appends intent.commit_run", async () => {
    seedCommitted(r.store, "r2");
    const code = await commitCommand({ runId: "r2", message: "promote", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r2")).toBe("intent.commit_run");
  });

  test("merge: --no-ff + --squash together → exit 1", async () => {
    const code = await mergeCommand({ runId: "r3", noFf: true, squash: true, url: r.url });
    expect(code).toBe(1);
  });

  test("merge: exit 0, appends intent.merge_run", async () => {
    seedCommitted(r.store, "r4");
    const code = await mergeCommand({ runId: "r4", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r4")).toBe("intent.merge_run");
  });

  test("discard: exit 0, appends intent.discard_run", async () => {
    seedCommitted(r.store, "r5");
    const code = await discardCommand({ runId: "r5", url: r.url });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "r5")).toBe("intent.discard_run");
  });

  test("branch: unknown run → exit 1 (404 surfaced)", async () => {
    const code = await branchCommand({ runId: "nope", branch: "x", url: r.url });
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
