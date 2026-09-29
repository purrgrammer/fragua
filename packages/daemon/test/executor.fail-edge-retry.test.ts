// Fail-edge back-edge cap, end-to-end through the executor (SPEC §3.1). A
// `check` step whose `on: {fail: fix}` edge loops back through `fix` to `check`
// is bounded by `check`'s `max-retries`: after N re-entries the run pauses
// `fact.run_paused{reason:"max_retries"}` instead of looping until `max_loops`.

import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

async function dispatchOnce(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 50,
    shutdownSignal: new AbortController().signal,
  });
}

async function driveUntilSettled(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  const SETTLED = new Set(["paused", "paused_human", "completed", "halted", "cancelled", "quarantined"]);
  for (let i = 0; i < 100; i++) {
    const s = r.store.getState(runId);
    if (s == null) return;
    if (SETTLED.has(s.status)) return;
    if (s.status === "queued") {
      await dispatchOnce(r, runId);
      continue;
    }
    return;
  }
  throw new Error(`run ${runId} did not settle within 100 cycles`);
}

describe("executor — fail-edge back-edge cap", () => {
  test("a check→fix→check fail cycle with max-retries: 2 pauses max_retries after 2 re-entries", async () => {
    const yaml = `name: t
steps:
  check:
    type: llm
    prompt: x
    max-retries: 2
    on: {success: exit, fail: fix}
  fix:
    type: llm
    prompt: y
    next: check
`;
    const r = rig({ yaml });
    let checkCalls = 0;
    let fixCalls = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "check", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "check", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      // Always fail; let edge selection route the fail edge to fix (a back-edge).
      handler: async () => {
        checkCalls++;
        return { kind: "transition", outcomeStatus: "fail", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "fix", {
      kind: "llm",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => {
        fixCalls++;
        return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "exit", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "fer1", "start");
    await driveUntilSettled(r, "fer1");

    const state = r.store.getState("fer1")!;
    expect(state.status).toBe("paused");
    expect(state.currentNode).toBe("check");

    const pauses = r.store
      .getEvents("fer1")
      .filter((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "max_retries");
    expect(pauses.length).toBe(1);
    const p = pauses[0]!.payload as { nodeId: string; currentLimit: number; attempts: number };
    expect(p.nodeId).toBe("check");
    expect(p.currentLimit).toBe(2);
    expect(p.attempts).toBe(3);

    // check ran 3 times (2 re-entries after the first failure), fix ran twice.
    expect(checkCalls).toBe(3);
    expect(fixCalls).toBe(2);

    // No terminal halt ever landed — the cap pauses, it does not error out.
    const halts = r.store
      .getEvents("fer1")
      .filter((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect(halts.length).toBe(0);
  });
});
