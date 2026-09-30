// getLatestHumanPause — the bounded control-surface read that recovers a
// paused run's declared route enum without scanning the event log. Exercised
// against a real `:memory:` SQLite so the JSON-extract + legacy-fold matching
// is hit end-to-end.

import { describe, expect, test } from "bun:test";
import type { FactEvent } from "@fragua/types";
import { freshStore, seedRun } from "./helpers.ts";

async function pause(store: Awaited<ReturnType<typeof freshStore>>, runId: string, f: FactEvent): Promise<void> {
  store.appendFact(runId, [f], store.getState(runId)!.version);
}

describe("getLatestHumanPause", () => {
  test("returns null when the run never paused at a human node", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    expect(store.getLatestHumanPause(runId)).toBeNull();
    store.close();
  });

  test("returns the v4 fact.run_paused{reason:human} with its declared routes", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    await pause(store, runId, {
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "ask", text: "?", routes: ["approve", "reject"] },
    });
    const ev = store.getLatestHumanPause(runId);
    expect(ev?.type).toBe("fact.run_paused");
    expect((ev?.payload as { routes?: unknown }).routes).toEqual(["approve", "reject"]);
    store.close();
  });

  test("folds the LEGACY fact.run_paused_human shape", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    await pause(store, runId, {
      type: "fact.run_paused_human",
      payload: { nodeId: "ask", text: "?", routes: ["a", "b"] },
    });
    const ev = store.getLatestHumanPause(runId);
    expect(ev?.type).toBe("fact.run_paused_human");
    expect((ev?.payload as { routes?: unknown }).routes).toEqual(["a", "b"]);
    store.close();
  });

  test("returns the newest human pause when a run pauses more than once", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    await pause(store, runId, {
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "ask", text: "?", routes: ["A"] },
    });
    await pause(store, runId, { type: "fact.run_resumed", payload: { fromStatus: "paused_human" } });
    await pause(store, runId, {
      type: "fact.run_paused",
      payload: { reason: "human", nodeId: "ask", text: "?", routes: ["B", "C"] },
    });
    const ev = store.getLatestHumanPause(runId);
    expect((ev?.payload as { routes?: unknown }).routes).toEqual(["B", "C"]);
    store.close();
  });

  test("ignores non-human pauses", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    await pause(store, runId, { type: "fact.run_paused", payload: { reason: "operator", nodeId: "n1" } });
    expect(store.getLatestHumanPause(runId)).toBeNull();
    store.close();
  });
});
