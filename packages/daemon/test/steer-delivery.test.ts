// buildSteerDelivery — records fact.steering_applied for a forwarded steer.
//
// The registry does the in-memory injection; this wrapper turns the outcome
// into a durable, operator-visible fact joinable to the originating intent.

import { afterEach, describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore, type SteerDelivery } from "@fragua/store";
import { buildSteerDelivery, type SteerForwarder } from "../src/steer-delivery.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

function makeRunningStore(runId: string): SqliteStore {
  const store = new SqliteStore({ path: ":memory:" });
  closers.push(() => store.close());
  const wfSrc = `name: t\nsteps:\n  impl: {type: llm, prompt: x}\n`;
  store.saveWorkflow("sha", "t", wfSrc, serializeGraph(parseWorkflow(wfSrc)), CURRENT_IR_VERSION);
  store.enqueueRun({ runId, workflowSha: "sha", initialRouting: { start_node: "impl" } });
  store.claimNextRun(1);
  const v = store.getState(runId)?.version ?? 0;
  store.appendFact(
    runId,
    [{ type: "fact.run_started", payload: { workflowSha: "sha", contractVersion: 1, startNode: "impl" } }],
    v,
    { advanceAppliedTo: v },
  );
  return store;
}

function stubForwarder(result: SteerDelivery): SteerForwarder {
  return { steer: () => result };
}

function steeringAppliedEvents(store: SqliteStore, runId: string) {
  return store.getEvents(runId).filter((e) => e.type === "fact.steering_applied");
}

describe("buildSteerDelivery", () => {
  test("records fact.steering_applied with disposition=delivered and per-branch targets when agents are live", () => {
    const store = makeRunningStore("r1");
    const targets = [
      { nodeId: "adversarial", iteration: 0 },
      { nodeId: "scope", iteration: 0 },
    ];
    const onSteer = buildSteerDelivery({ store, registry: stubForwarder({ disposition: "delivered", targets }) });

    onSteer("r1", "tighten the scope", 7);

    const facts = steeringAppliedEvents(store, "r1");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toEqual({ intentSeq: 7, disposition: "delivered", targets });
  });

  test("records disposition=buffered with no targets when no agent is live", () => {
    const store = makeRunningStore("r2");
    const onSteer = buildSteerDelivery({ store, registry: stubForwarder({ disposition: "buffered", targets: [] }) });

    onSteer("r2", "later", 3);

    const facts = steeringAppliedEvents(store, "r2");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.payload).toEqual({ intentSeq: 3, disposition: "buffered", targets: [] });
  });

  test("does not record when the run is not running (missing / terminal)", () => {
    const store = makeRunningStore("r3");
    // Terminate the run so the fact append is skipped.
    const v = store.getState("r3")?.version ?? 0;
    store.appendFact("r3", [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "impl" } }], v);
    const onSteer = buildSteerDelivery({ store, registry: stubForwarder({ disposition: "buffered", targets: [] }) });

    onSteer("r3", "too late", 9);
    onSteer("missing", "nope", 1);

    expect(steeringAppliedEvents(store, "r3")).toHaveLength(0);
  });
});

describe("buildSteerDelivery — a store fault must not escape", () => {
  // This runs inside the supervisor's tick, whose only try/catch wraps the
  // heartbeat ("supervisor must never crash the daemon"). A throw here
  // rejects the loop promise and takes the watchdog fiber down with it, so
  // every other run loses oversight because one steer receipt failed.
  test("a non-OCC appendFact error is swallowed, not rethrown", () => {
    const registry: SteerForwarder = {
      steer: () => ({ disposition: "delivered", targets: [{ nodeId: "n", iteration: 0 }] }) as SteerDelivery,
    };
    const store = {
      getState: () => ({ status: "running", version: 1 }),
      appendFact: () => {
        throw new Error("SQLITE_FULL: database or disk is full");
      },
    } as unknown as Parameters<typeof buildSteerDelivery>[0]["store"];

    const deliver = buildSteerDelivery({ store, registry });
    expect(() => deliver("run-1", "steer text", 7)).not.toThrow();
  });

  test("the steer still reaches the registry even when the receipt fails", () => {
    let seen: string | undefined;
    const registry: SteerForwarder = {
      steer: (_runId, text) => {
        seen = text;
        return { disposition: "buffered", targets: [] } as SteerDelivery;
      },
    };
    const store = {
      getState: () => ({ status: "running", version: 1 }),
      appendFact: () => {
        throw new Error("SQLITE_IOERR");
      },
    } as unknown as Parameters<typeof buildSteerDelivery>[0]["store"];

    buildSteerDelivery({ store, registry })("run-1", "focus on the cache", 9);
    expect(seen).toBe("focus on the cache");
  });
});
