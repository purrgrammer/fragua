// Coverage for the per-parent descendant SSE route mounted by
// `storeRunsRoutes` (GET /runs/:id/events/stream?include=descendants).
//
// The route reuses `runGlobalFeedLoop` with the recursive-CTE-scoped
// store helpers (`getEventsForRunWithDescendantsForward` /
// `…AtFloor`). These tests pin:
//   - bad / missing ?include= → 400
//   - unknown runId → 404
//   - live wire delivers parent + sub-run events, ignores unrelated
//   - Last-Event-ID resumes correctly from the boundary cursor
//
// docs/proposals/descendant-event-stream.md.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { storeRunsRoutes } from "../../src/store/runs-routes.ts";

let store: SqliteStore;
let server: { fetch: (req: Request) => Response | Promise<Response> };

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf", "t", "digraph {}");
  server = storeRunsRoutes({ store, ssePollMs: 10 });
});

afterEach(() => {
  store.close();
});

/** Seed a parent and one descendant child run, both ready for fact
 *  appends. Returns the OCC versions so the test can drive the run
 *  forward. */
function seedTree(parent = "p", child = "c"): { pv: number; cv: number } {
  store.enqueueRun({ runId: parent, workflowSha: "wf" });
  store.enqueueRun({
    runId: child,
    workflowSha: "wf",
    parentRunId: parent,
    parentNodeId: "fan",
    parallelIndex: 0,
    subgraphRootNodeId: "branch",
    subgraphTerminalNodeId: "branch_end",
  });
  return { pv: store.getState(parent)!.version, cv: store.getState(child)!.version };
}

/** Drain SSE response into a single string until `marker` appears or
 *  the timeout elapses. */
async function drainSSE(res: Response, marker: string, timeoutMs = 500): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let chunks = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks += decoder.decode(value, { stream: true });
    if (chunks.includes(marker)) break;
  }
  await reader.cancel();
  return chunks;
}

describe("GET /runs/:id/events/stream?include=descendants", () => {
  test("400 when ?include is missing or not 'descendants'", async () => {
    seedTree();
    const r1 = await server.fetch(new Request("http://test/runs/p/events/stream"));
    expect(r1.status).toBe(400);
    const r2 = await server.fetch(new Request("http://test/runs/p/events/stream?include=other"));
    expect(r2.status).toBe(400);
  });

  test("404 on unknown run id", async () => {
    const res = await server.fetch(new Request("http://test/runs/does-not-exist/events/stream?include=descendants"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("serves parent + descendant events, ignores unrelated runs", async () => {
    const { pv, cv } = seedTree();

    // Pre-seed: open the stream right after enqueue so the run_enqueued
    // events sit at older ts. Use ?fromTs= at "now" so we pick up only
    // new events.
    const cursorTs = Date.now();

    const res = await server.fetch(
      new Request(`http://test/runs/p/events/stream?include=descendants&fromTs=${cursorTs}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    // Append a fact on the child (in scope) and on an unrelated run
    // (out of scope). The child's fact should land in the wire; the
    // unrelated run's fact should not.
    store.appendFact(
      "c",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: 1, startNode: "n" } }],
      cv,
    );
    // Unrelated top-level run (no parent linkage to "p").
    store.enqueueRun({ runId: "unrelated", workflowSha: "wf" });
    const uv = store.getState("unrelated")!.version;
    store.appendFact(
      "unrelated",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: 1, startNode: "n" } }],
      uv,
    );
    // And one on the parent so we have a clear marker to wait for.
    store.appendFact("p", [{ type: "fact.run_completed", payload: { finalNode: "end" } }], pv);

    const chunks = await drainSSE(res, "fact.run_completed");
    expect(chunks).toContain("fact.run_completed");
    expect(chunks).toContain("fact.run_started");
    // The unrelated run's runId must not appear on the wire (its event
    // is filtered out by the recursive CTE).
    expect(chunks).not.toContain('"unrelated"');
  });

  test("replays cleanly on Last-Event-ID", async () => {
    // Two facts on the parent at distinct ts. Reconnect with
    // Last-Event-ID = the first event's `(ts.runId.seq)`; only the
    // second event should appear on the wire.
    const { pv } = seedTree();

    // Append the first fact and read its (ts, seq).
    store.appendFact(
      "p",
      [{ type: "fact.run_started", payload: { workflowSha: "wf", schemaVersion: 1, startNode: "n" } }],
      pv,
    );
    const firstEvents = store.getEvents("p");
    const first = firstEvents.find((e) => e.type === "fact.run_started")!;
    const firstId = `${first.ts}.${first.runId}.${first.seq}`;

    // Wait a tick so the second fact lands at a strictly greater ts.
    await new Promise((r) => setTimeout(r, 5));
    const pv2 = store.getState("p")!.version;
    store.appendFact("p", [{ type: "fact.run_completed", payload: { finalNode: "end" } }], pv2);

    const res = await server.fetch(
      new Request("http://test/runs/p/events/stream?include=descendants", {
        headers: { "Last-Event-ID": firstId },
      }),
    );
    expect(res.status).toBe(200);

    const chunks = await drainSSE(res, "fact.run_completed");
    expect(chunks).toContain("fact.run_completed");
    // The first event must not be re-delivered \u2014 the strict-tuple
    // cursor in `parseGlobalCursorFromHeader` seeds maxAt from the
    // Last-Event-ID triple so the forward query skips it.
    expect(chunks).not.toContain(`id:${firstId}\n`);
  });
});
