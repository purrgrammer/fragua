// The executor's release hooks (`onNodeExited` / `onRunTerminal`) that the CLI
// wires to the MCP connection pool: a node is released only when a committed
// transition moves the run's cursor off it — never on a scheduled retry or a
// self-loop — and a run is released only when it reaches a hard-terminal status,
// never on a pause.

import { describe, expect, test } from "bun:test";
import type * as core from "@fragua/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

type Rig = ReturnType<typeof rig>;

interface HookLog {
  exited: Array<[string, string]>;
  terminal: string[];
}

async function dispatchOnce(r: Rig, runId: string, log: HookLog): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 20,
    shutdownSignal: new AbortController().signal,
    onNodeExited: (runId, nodeId) => log.exited.push([runId, nodeId]),
    onRunTerminal: (runId) => log.terminal.push(runId),
  });
}

function register(r: Rig, nodeId: string, handler: core.Handler): void {
  r.dispatcher.register(r.workflowSha, nodeId, { kind: "llm", sideEffect: "external", maxMs: 1_000, handler });
}

const success: core.Handler = async () => ({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 });

describe("executor — MCP release hooks", () => {
  test("onNodeExited fires when the cursor leaves a node", async () => {
    const r = rig({ yaml: "name: t\nsteps:\n  a: {type: llm, prompt: x}\n  b: {type: llm, prompt: y}\n" });
    register(r, "a", success);
    register(r, "b", success);
    const log: HookLog = { exited: [], terminal: [] };
    enqueue(r, "rel-1", "a");
    await dispatchOnce(r, "rel-1", log);

    expect(r.store.getState("rel-1")?.status).toBe("completed");
    expect(log.exited.filter(([, n]) => n === "a")).toEqual([["rel-1", "a"]]);
    // The final node's cursor never moves on; the terminal hook releases it.
    expect(log.terminal).toEqual(["rel-1"]);
  });

  test("onNodeExited does not fire on a self-loop or a scheduled retry", async () => {
    const r = rig({ yaml: "name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 3}\n" });
    let calls = 0;
    register(r, "work", async () => {
      calls++;
      if (calls === 1) return { kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 };
      if (calls === 2) return { kind: "transition", outcomeStatus: "success", nextNode: "work", tokens: 0, costUsd: 0 };
      return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
    });
    const log: HookLog = { exited: [], terminal: [] };
    enqueue(r, "rel-2", "work");

    await dispatchOnce(r, "rel-2", log);
    expect(r.store.getState("rel-2")?.status).toBe("paused_auto");
    expect(log.exited.filter(([, n]) => n === "work")).toEqual([]);

    wakePending(r.store, () => Date.now() + 60_000);
    await dispatchOnce(r, "rel-2", log);
    expect(calls).toBe(3);
    expect(r.store.getState("rel-2")?.status).toBe("completed");
    expect(log.exited.filter(([, n]) => n === "work")).toEqual([["rel-2", "work"]]);
  });

  test("onRunTerminal fires once on hard-terminal, not on pause", async () => {
    const r = rig({ yaml: "name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 3}\n" });
    let calls = 0;
    register(r, "work", async () => {
      calls++;
      if (calls === 1) return { kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 };
      return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
    });
    const log: HookLog = { exited: [], terminal: [] };
    enqueue(r, "rel-3", "work");

    await dispatchOnce(r, "rel-3", log);
    expect(r.store.getState("rel-3")?.status).toBe("paused_auto");
    expect(log.terminal).toEqual([]);

    wakePending(r.store, () => Date.now() + 60_000);
    await dispatchOnce(r, "rel-3", log);
    expect(r.store.getState("rel-3")?.status).toBe("completed");
    expect(log.terminal).toEqual(["rel-3"]);
  });
});
