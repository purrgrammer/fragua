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

/** Two single-node branches converging on a join — for the head-of-line probe. */
const HOL_YAML = `name: hol
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a_scan, b_scan], next: synth }
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;

/** A perpetually-failing branch beside a healthy MULTI-node branch (y_ok→y2). */
const ABLOOP_YAML = `name: abloop
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [x_fail, y_ok], next: synth }
  x_fail: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  y_ok: { type: llm, prompt: x, allowed-tools: [read], next: y2 }
  y2: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;

/** A branch that never resolves on its own beside a healthy one — the deadline. */
const HUNG_YAML = `name: hung
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [hung, ok], next: synth }
  hung: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  ok: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
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

interface DriveOpts {
  maxTurns?: number;
  fanoutBranchTimeoutMs?: number;
  abortLoopCeiling?: number;
}

async function drive(r: ReturnType<typeof rig>, runId: string, opts: DriveOpts = {}): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: opts.maxTurns ?? 60,
    shutdownSignal: new AbortController().signal,
    ...(opts.fanoutBranchTimeoutMs !== undefined ? { fanoutBranchTimeoutMs: opts.fanoutBranchTimeoutMs } : {}),
    ...(opts.abortLoopCeiling !== undefined ? { abortLoopCeiling: opts.abortLoopCeiling } : {}),
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

  test("a branch's transient abort re-drives WITHOUT re-running its completed siblings", async () => {
    const r = rig({ yaml: FANOUT_YAML });
    const seen: Record<string, number> = {};
    const c = counter(seen, "a_scan", "a_verify", "b_scan", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    const okLlm = (id: string, out?: Record<string, string>) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => {
          c[id]?.();
          return {
            kind: "transition",
            outcomeStatus: "success",
            tokens: 10,
            costUsd: 0.01,
            ...(out ? { outputs: out } : {}),
          };
        },
      });
    okLlm("a_scan", { f: "a_scan_finding" });
    okLlm("a_verify", { f: "a_verify_filtered" });
    okLlm("synth");
    // b_scan throws on its first dispatch (a transient error), succeeds the next.
    let bScanCalls = 0;
    r.dispatcher.register(r.workflowSha, "b_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        c["b_scan"]?.();
        bScanCalls++;
        if (bScanCalls === 1) throw new Error("transient");
        return {
          kind: "transition",
          outcomeStatus: "success",
          tokens: 10,
          costUsd: 0.01,
          outputs: { f: "b_scan_finding" },
        };
      },
    });
    enqueue(r, "fo3", "begin");

    await drive(r, "fo3");
    const final = r.store.getState("fo3")!;
    expect(final.status).toBe("completed");
    // a_scan / a_verify completed in the same pool pass where b_scan aborted; the
    // re-drive of b_scan must NOT re-run them — the frontier folds from the log.
    expect(seen["a_scan"]).toBe(1);
    expect(seen["a_verify"]).toBe(1);
    expect(seen["b_scan"]).toBe(2); // aborted once, then succeeded
    expect(seen["synth"]).toBe(1);

    const types = r.store.getEvents("fo3").map((e) => e.type);
    expect(types).toContain("fact.node_aborted");
    expect(types).toContain("fact.fanout_joined");

    // Replay matches the live projection after the abort + re-drive.
    const replayed = deriveRunState("fo3", r.store.getEvents("fo3"));
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(final.currentNode);
    r.store.close();
  });

  test("head-of-line: a fast branch commits BEFORE a slow sibling settles", async () => {
    const r = rig({ yaml: HOL_YAML });
    // a_scan resolves immediately; b_scan blocks until it OBSERVES a_scan's
    // node_completed in the store. The run can only converge if the fast branch's
    // commit lands WITHOUT waiting on the slow sibling. Under the old Promise.all
    // batch, a_scan's commit was gated behind b_scan's resolution (the barrier) →
    // b_scan would never see it → deadlock. The reactive pool commits a_scan the
    // instant it settles.
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    const instant = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 }),
      });
    instant("a_scan");
    instant("synth");
    let bSawAScan = false;
    r.dispatcher.register(r.workflowSha, "b_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        for (let i = 0; i < 400 && !bSawAScan; i++) {
          const committed = r.store
            .getEvents(ctx.runId)
            .some((e) => e.type === "fact.node_completed" && (e.payload as { nodeId?: string }).nodeId === "a_scan");
          if (committed) bSawAScan = true;
          else await new Promise((res) => setTimeout(res, 5));
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
      },
    });
    enqueue(r, "hol1", "begin");
    await drive(r, "hol1");

    expect(bSawAScan).toBe(true); // the fast branch committed mid-flight of the slow one
    expect(r.store.getState("hol1")!.status).toBe("completed");
    r.store.close();
  });

  test("per-branch abort-loop: a branch that aborts every turn pauses the run, naming that branch", async () => {
    const r = rig({ yaml: ABLOOP_YAML });
    const seen: Record<string, number> = {};
    const c = counter(seen, "x_fail", "y_ok", "y2", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "x_fail", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        c["x_fail"]?.();
        throw new Error("always fails");
      },
    });
    const okLlm = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => {
          c[id]?.();
          return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
        },
      });
    okLlm("y_ok");
    okLlm("y2");
    okLlm("synth");
    enqueue(r, "abl1", "begin");

    await drive(r, "abl1", { abortLoopCeiling: 3 });
    const final = r.store.getState("abl1")!;
    expect(final.status).toBe("paused");
    const paused = r.store.getEvents("abl1").find((e) => e.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("abort_loop");
    expect((paused?.payload as { nodeId?: string }).nodeId).toBe("x_fail");
    // The healthy multi-node sibling ran exactly once and is NOT re-driven while
    // the failing branch climbs its OWN streak (the run-wide counter's masking).
    expect(seen["y_ok"]).toBe(1);
    expect(seen["y2"]).toBe(1);
    expect(seen["x_fail"]).toBe(3);
    r.store.close();
  });

  test("hung-branch deadline: the parallel backstop aborts a branch whose own timeout is too long", async () => {
    const r = rig({ yaml: HUNG_YAML });
    let hungDispatches = 0;
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `hung` would run for 100s on its own; only the injected 50ms fan-out
    // backstop reclaims it. It honours its signal, so it ABORTS (not leaks).
    r.dispatcher.register(r.workflowSha, "hung", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100_000,
      handler: async (ctx) => {
        hungDispatches++;
        await new Promise<void>((_, reject) => {
          if (ctx.signal.aborted) return reject(ctx.signal.reason ?? new Error("aborted"));
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason ?? new Error("aborted")), { once: true });
        });
        return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 }; // unreachable — the await always rejects
      },
    });
    let okRuns = 0;
    r.dispatcher.register(r.workflowSha, "ok", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        okRuns++;
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
      },
    });
    r.dispatcher.register(r.workflowSha, "synth", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 }),
    });
    enqueue(r, "hung1", "begin");

    await drive(r, "hung1", { fanoutBranchTimeoutMs: 50, abortLoopCeiling: 2 });
    const final = r.store.getState("hung1")!;
    // The deadline made the unbounded branch terminable: it aborted each turn and
    // climbed to the ceiling rather than hanging the run forever.
    expect(final.status).toBe("paused");
    const paused = r.store.getEvents("hung1").find((e) => e.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("abort_loop");
    expect((paused?.payload as { nodeId?: string }).nodeId).toBe("hung");
    expect(hungDispatches).toBe(2); // aborted at the 50ms deadline, twice → ceiling
    expect(okRuns).toBe(1); // the healthy sibling completed and was not re-driven
    r.store.close();
  });
});
