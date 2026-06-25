// OCC ceiling.
//
// Wraps the store's `appendFact` to inject `ConcurrencyError` for the
// first N fact-append attempts, then succeed. Asserts the executor's
// counter halts at the ceiling with a structured `occ_exhausted` payload
// and emits an `occ_conflict_warning` observability event one step
// before the halt.

import { describe, expect, test } from "bun:test";
import { ConcurrencyError, type FactEvent } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, registerTerminalEcho, rig } from "./helpers.ts";

function registerStartAndDone(r: ReturnType<typeof rig>): void {
  r.dispatcher.register(r.workflowSha, "start", {
    kind: "start",
    sideEffect: "none",
    maxMs: 100,
    handler: async () => ({ kind: "transition", nextNode: "done", tokens: 0, costUsd: 0 }),
  });
  registerTerminalEcho(r.dispatcher, r.workflowSha, "done");
}

function wrapAppendFactWithOccBurst(
  store: ReturnType<typeof rig>["store"],
  failuresBeforeSuccess: number,
): { restore: () => void } {
  const originalAppendFact = store.appendFact.bind(store);
  let failuresRemaining = failuresBeforeSuccess;
  store.appendFact = ((
    runId: string,
    facts: FactEvent[],
    expectedVersion: number,
    opts?: { routingPatch?: Record<string, unknown>; advanceAppliedTo?: number },
  ) => {
    if (failuresRemaining > 0) {
      failuresRemaining--;
      throw new ConcurrencyError(expectedVersion, expectedVersion + 1);
    }
    return originalAppendFact(runId, facts, expectedVersion, opts);
  }) as typeof store.appendFact;
  return {
    restore: () => {
      store.appendFact = originalAppendFact;
    },
  };
}

describe("OCC ceiling — fact.run_started storm", () => {
  test("3 consecutive ConcurrencyError trips occ_exhausted halt with structured payload", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  work: {type: llm, prompt: x}\n` });
    enqueue(r, "occ-3", "start");
    r.store.claimNextRun(1);

    const { restore } = wrapAppendFactWithOccBurst(r.store, 3);
    try {
      await runOne("occ-3", {
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      });
    } finally {
      restore();
    }

    const events = r.store.getEvents("occ-3");
    const halt = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect(halt).not.toBeUndefined();
    const haltPayload = halt!.payload as {
      reason: string;
      detail?: string;
      occContext?: { count: number; nodeId: string; iteration: number; lastVersion: number; attemptedFactType: string };
    };
    expect(haltPayload.reason).toBe("occ_exhausted");
    expect(haltPayload.occContext).toBeDefined();
    expect(haltPayload.occContext!.count).toBe(3);
    expect(haltPayload.occContext!.attemptedFactType).toBe("fact.run_started");
    expect(haltPayload.occContext!.nodeId).toBe("start");

    const warnings = events.filter((e) => e.type === "occ_conflict_warning");
    expect(warnings.length).toBe(1);
    const warnPayload = warnings[0]!.payload as { count: number; ceiling: number; nodeId: string };
    expect(warnPayload.count).toBe(2);
    expect(warnPayload.ceiling).toBe(3);

    expect(r.store.getState("occ-3")?.status).toBe("halted");
  });

  test("2 consecutive ConcurrencyError emits one warning and recovers without halting", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  work: {type: llm, prompt: x}\n` });
    registerStartAndDone(r);
    enqueue(r, "occ-2", "start");
    r.store.claimNextRun(1);

    const { restore } = wrapAppendFactWithOccBurst(r.store, 2);
    try {
      await runOne("occ-2", {
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      });
    } finally {
      restore();
    }

    const events = r.store.getEvents("occ-2");
    const warnings = events.filter((e) => e.type === "occ_conflict_warning");
    expect(warnings.length).toBe(1);
    const resolved = events.filter((e) => e.type === "occ_conflict_resolved");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    const halts = events.filter(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    const occHalts = halts.filter((e) => (e.payload as { reason: string }).reason === "occ_exhausted");
    expect(occHalts.length).toBe(0);
  });

  test("1 ConcurrencyError followed by success — no warning, run proceeds", async () => {
    const r = rig({ yaml: `name: t\nsteps:\n  work: {type: llm, prompt: x}\n` });
    registerStartAndDone(r);
    enqueue(r, "occ-1", "start");
    r.store.claimNextRun(1);

    const { restore } = wrapAppendFactWithOccBurst(r.store, 1);
    try {
      await runOne("occ-1", {
        store: r.store,
        dispatcher: r.dispatcher,
        registry: new AbortRegistry(),
        tools: r.tools,
        llmCall: r.llmCall,
        maxConcurrentRuns: 1,
        maxTurnsForTesting: 10,
        shutdownSignal: new AbortController().signal,
      });
    } finally {
      restore();
    }

    const events = r.store.getEvents("occ-1");
    expect(events.filter((e) => e.type === "occ_conflict_warning").length).toBe(0);
    const resolved = events.filter((e) => e.type === "occ_conflict_resolved");
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved[0]!.payload).toMatchObject({ count: 1 });
  });
});
