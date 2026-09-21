// Supervisor + executor on ONE run. Every other supervisor test hands the
// fiber a pre-registered controller; this one lets `runOne` register it, so
// the test covers the seam where the executor's intent fold and the
// supervisor's intent detection disagree about what "new" means.

import { afterEach, describe, expect, test } from "bun:test";
import type { IntentEvent } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { startSupervisor } from "../src/supervisor.ts";
import { enqueue, rig } from "./helpers.ts";
import { dispositionType } from "./invariants.ts";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length > 0) closers.pop()?.();
});

/** Drive one run whose only handler blocks until released, with the
 * supervisor ticking against the same registry. `when: "pre-claim"`
 * appends the intent so the fold consumes it and it sits unapplied while the
 * handler runs — the shape a cap raise takes in production. `"mid-flight"`
 * appends it while the handler is blocked. */
async function driveWithSupervisor(
  intent: IntentEvent,
  when: "pre-claim" | "mid-flight",
): Promise<{ types: string[]; sawAbort: boolean }> {
  const r = rig();
  closers.push(() => r.store.close());
  const runId = "seam";

  let release!: () => void;
  const gate = new Promise<void>((res) => {
    release = res;
  });
  let started!: () => void;
  const handlerStarted = new Promise<void>((res) => {
    started = res;
  });
  let sawAbort = false;

  r.dispatcher.register(r.workflowSha, "start", {
    kind: "llm",
    sideEffect: "none",
    maxMs: 5_000,
    handler: async (ctx) => {
      started();
      await gate;
      sawAbort = ctx.signal.aborted;
      // Honour the signal the way a real handler does (I4), so a trip shows
      // up as `fact.node_aborted` rather than a completed node.
      if (sawAbort) throw new DOMException("aborted", "AbortError");
      return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
    },
  });

  enqueue(r, runId, "start");
  r.store.claimNextRun(1);
  if (when === "pre-claim") r.store.appendIntent(runId, intent);

  const registry = new AbortRegistry();
  const shutdown = new AbortController();
  const sup = startSupervisor({
    store: r.store,
    registry,
    pid: process.pid,
    shutdownSignal: shutdown.signal,
    tickMs: 1,
    heartbeatIntervalMs: 1_000_000,
  });

  const run = runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry,
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 10,
    shutdownSignal: shutdown.signal,
  });

  await handlerStarted;
  if (when === "mid-flight") r.store.appendIntent(runId, intent);
  // Several supervisor ticks while the handler is in flight.
  await new Promise((res) => setTimeout(res, 30));
  release();
  await run;
  shutdown.abort();
  await sup.promise;

  return { types: r.store.getEvents(runId).map(dispositionType), sawAbort };
}

describe("supervisor ↔ executor seam", () => {
  const raise: IntentEvent = {
    type: "intent.budget_adjusted",
    payload: { scope: "run", metric: "cost", newLimit: 10 },
  };

  test.each(["pre-claim", "mid-flight"] as const)(
    "a budget raise (%s) does not abort the in-flight handler",
    async (when) => {
      const { types, sawAbort } = await driveWithSupervisor(raise, when);
      expect(sawAbort).toBe(false);
      expect(types).not.toContain("fact.node_aborted");
      expect(types.filter((t) => t === "fact.node_completed")).toHaveLength(1);
      expect(types).toContain("fact.run_completed");
    },
  );

  test("control: a mid-flight pause request DOES abort the in-flight handler", async () => {
    const { types, sawAbort } = await driveWithSupervisor(
      { type: "intent.pause_requested", payload: {} },
      "mid-flight",
    );
    expect(sawAbort).toBe(true);
    expect(types).toContain("fact.node_aborted");
    expect(types).toContain("fact.run_paused");
  });
});
