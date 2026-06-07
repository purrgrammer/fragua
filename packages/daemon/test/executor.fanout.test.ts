// Fan-out (Model A) — the on-log reactive frontier, end-to-end through the
// executor. docs/proposals/fan-out-nodes.md. Multi-node branches run as
// concurrent sub-pipelines (scan → verify) converging on a join; the frontier
// is folded from the log so replay matches the live projection and a mid-fan-out
// stop resumes by re-dispatching only the unfinished sub-nodes.

import { describe, expect, test } from "bun:test";
import { deriveRunState, readActiveNodes } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

const FANOUT_YAML = `name: fo
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan:
    type: parallel
    branches: [a_scan, b_scan]
    next: synth
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: a_verify, outputs: { f: { type: string } } }
  a_verify: { type: llm, prompt: x, allowed-tools: [read], next: synth, outputs: { f: { type: string } } }
  b_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth, outputs: { f: { type: string } } }
  synth: { type: llm, prompt: "combine \${{ outputs.a_verify.f }} \${{ outputs.b_scan.f }}", next: exit }
`;

function registerHandlers(r: ReturnType<typeof rig>, calls: Record<string, () => void> = {}): void {
  const llm = (id: string, out?: Record<string, string>) =>
    r.dispatcher.register(r.workflowSha, id, {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        calls[id]?.();
        return {
          kind: "transition",
          outcomeStatus: "success",
          tokens: 10,
          costUsd: 0.01,
          ...(out !== undefined ? { outputs: out } : {}),
        };
      },
    });
  r.dispatcher.register(r.workflowSha, "begin", {
    kind: "llm",
    sideEffect: "external",
    maxMs: 1000,
    handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
  });
  llm("a_scan", { f: "a_scan_finding" });
  llm("a_verify", { f: "a_verify_filtered" });
  llm("b_scan", { f: "b_scan_finding" });
  llm("synth");
}

/** Per-node call counters as block-body callbacks (no assign-in-expression). */
function counter(seen: Record<string, number>, ...ids: string[]): Record<string, () => void> {
  const calls: Record<string, () => void> = {};
  for (const id of ids) {
    calls[id] = () => {
      seen[id] = (seen[id] ?? 0) + 1;
    };
  }
  return calls;
}

async function drive(r: ReturnType<typeof rig>, runId: string, maxTurns = 60): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: maxTurns,
    shutdownSignal: new AbortController().signal,
  });
}

describe("executor — fan-out (Model A on-log frontier)", () => {
  test("multi-node branches run and converge on the join; replay matches live", async () => {
    const r = rig({ yaml: FANOUT_YAML });
    const seen: Record<string, number> = {};
    registerHandlers(r, counter(seen, "a_scan", "a_verify", "b_scan", "synth"));
    enqueue(r, "fo1", "begin");
    await drive(r, "fo1");

    const state = r.store.getState("fo1")!;
    expect(state.status).toBe("completed");

    // Every branch sub-node ran exactly once; the join ran once.
    expect(seen).toEqual({ a_scan: 1, a_verify: 1, b_scan: 1, synth: 1 });

    const events = r.store.getEvents("fo1");
    const types = events.map((e) => e.type);
    expect(types).toContain("fact.fanout_started");
    expect(types).toContain("fact.fanout_joined");

    // The frontier drained (active set cleared) and current_node landed past
    // the join.
    expect(readActiveNodes(state.routing)).toBeNull();

    // Replay equivalence: deriving the state from the log alone reproduces the
    // live projection's terminal pointer + status (the frontier folds from the
    // log, interleaving frozen in seq order).
    const replayed = deriveRunState("fo1", events);
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(state.currentNode);
    expect(readActiveNodes(replayed.routing)).toBeNull();

    r.store.close();
  });

  test("each branch's node_completed carries the BRANCH id (not the parallel node)", async () => {
    const r = rig({ yaml: FANOUT_YAML });
    registerHandlers(r);
    enqueue(r, "fo2", "begin");
    await drive(r, "fo2");

    const completed = r.store
      .getEvents("fo2")
      .filter((e) => e.type === "fact.node_completed")
      .map((e) => (e.payload as { nodeId: string }).nodeId);
    // Each sub-pipeline node + the join completed under its own id.
    for (const id of ["a_scan", "a_verify", "b_scan", "synth"]) {
      expect(completed).toContain(id);
    }
    // The parallel node never emits a node_completed (it joins, not completes).
    expect(completed).not.toContain("fan");
    r.store.close();
  });

  test("mid-fan-out stop resumes by re-dispatching only the unfinished frontier", async () => {
    const r = rig({ yaml: FANOUT_YAML });
    const seen: Record<string, number> = {};
    registerHandlers(r, counter(seen, "a_scan", "a_verify", "b_scan", "synth"));
    enqueue(r, "fo3", "begin");

    // Stop early, mid-fan-out: run_started, dispatch_started{begin}, begin→fan,
    // fanout_started seed, then superstep 1 (a_scan + b_scan run, frontier
    // advances to a_verify) — then stop before a_verify / the join.
    await drive(r, "fo3", 5);
    const mid = r.store.getState("fo3")!;
    expect(mid.status).not.toBe("completed");
    const midActive = readActiveNodes(mid.routing);
    expect(midActive).not.toBeNull();
    // a_scan + b_scan ran in the first superstep.
    expect(seen["a_scan"]).toBe(1);
    expect(seen["b_scan"]).toBe(1);

    // Resume: re-drive to completion. The done branches must NOT re-run.
    await drive(r, "fo3");
    const final = r.store.getState("fo3")!;
    expect(final.status).toBe("completed");
    expect(seen["a_scan"]).toBe(1); // not re-run
    expect(seen["b_scan"]).toBe(1); // not re-run
    expect(seen["a_verify"]).toBe(1); // ran on resume
    expect(seen["synth"]).toBe(1);

    // Replay still matches after the resume.
    const replayed = deriveRunState("fo3", r.store.getEvents("fo3"));
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(final.currentNode);
    r.store.close();
  });
});
