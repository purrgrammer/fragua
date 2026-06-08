// Fan-out (Model A) — the on-log reactive frontier, end-to-end through the
// executor. docs/proposals/fan-out-nodes.md. Multi-node branches run as
// concurrent sub-pipelines (scan → verify) converging on a join; the frontier
// is folded from the log so replay matches the live projection and a mid-fan-out
// stop resumes by re-dispatching only the unfinished sub-nodes.

import { describe, expect, test } from "bun:test";
import { deriveRunState, readActiveNodes } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { enqueue, rig } from "./helpers.ts";

/** A `start → begin → fan(parallel) → [n single-node branches] → synth → exit`
 * workflow with `n` read-class llm branches, each emitting `findings` that the
 * join consumes — for fuzzing branch settle/commit order at width ≥3. */
function parallelYaml(n: number): string {
  const branches = Array.from({ length: n }, (_, i) => `b${i}`);
  const branchSteps = branches
    .map(
      (b) =>
        `  ${b}: { type: llm, prompt: x, allowed-tools: [read], next: synth, outputs: { findings: { type: string } } }`,
    )
    .join("\n");
  const reads = branches.map((b) => `\${{ outputs.${b}.findings }}`).join(" ");
  return `name: settle
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [${branches.join(", ")}], next: synth }
${branchSteps}
  synth: { type: llm, prompt: "combine ${reads}", next: exit }
`;
}

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

/** A parallel node carrying a per-node `max-cost` cap, with a MULTI-node branch
 * (a_scan → a_verify) so the closure spans more than the entries — the per-node
 * sum must cover the whole sub-pipeline, not just the branch entry. */
const BUDGET_FANOUT_YAML = `name: bfo
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan:
    type: parallel
    branches: [a_scan, b_scan]
    max-cost: 0.015
    next: synth
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: a_verify }
  a_verify: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
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
  leakGraceMs?: number;
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
    ...(opts.leakGraceMs !== undefined ? { leakGraceMs: opts.leakGraceMs } : {}),
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

    const events = r.store.getEvents("fo3");
    const types = events.map((e) => e.type);
    expect(types).toContain("fact.node_aborted");
    expect(types).toContain("fact.fanout_joined");
    // The re-drive of b_scan emits a dispatch_started — the durable failed→running
    // transition fact (so the projection doesn't read it as failed mid-re-run).
    expect(
      events.some(
        (e) =>
          e.type === "fact.dispatch_started" &&
          (e.payload as { nodeId?: string; resumeOf?: string }).nodeId === "b_scan" &&
          (e.payload as { resumeOf?: string }).resumeOf === "paused",
      ),
    ).toBe(true);

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

  test("abort-loop streak is process-local — a restart resets it (best-effort liveness, not durable safety)", async () => {
    const r = rig({ yaml: ABLOOP_YAML });
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
        throw new Error("always fails");
      },
    });
    const okLlm = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 }),
      });
    okLlm("y_ok");
    okLlm("y2");
    okLlm("synth");
    enqueue(r, "ablr1", "begin");

    const xAborts = (): number =>
      r.store
        .getEvents("ablr1")
        .filter((e) => e.type === "fact.node_aborted" && (e.payload as { nodeId?: string }).nodeId === "x_fail").length;

    // Session 1 (one daemon process): cut short after a single x_fail abort, then
    // "crash" — the run is left running. ceiling=2, so one abort does NOT pause.
    // Turns: run_started → begin → fan seed → first dispatch+abort = 4 turns.
    await drive(r, "ablr1", { abortLoopCeiling: 2, maxTurns: 4 });
    expect(r.store.getState("ablr1")!.status).toBe("running");
    expect(xAborts()).toBe(1);

    // Restart: the startup sweep requeues the orphaned running run.
    expect(r.store.startupSweep().requeued.length).toBe(1);

    // Session 2 (fresh process ⇒ fresh branchAborts): x_fail climbs the streak
    // from ZERO again — a FULL ceiling (2 more aborts) to pause, not 1. A durable
    // streak would have paused after a single post-restart abort (total 2).
    await drive(r, "ablr1", { abortLoopCeiling: 2 });
    const final = r.store.getState("ablr1")!;
    expect(final.status).toBe("paused");
    const paused = r.store.getEvents("ablr1").find((e) => e.type === "fact.run_paused");
    expect((paused?.payload as { reason?: string }).reason).toBe("abort_loop");
    expect((paused?.payload as { nodeId?: string }).nodeId).toBe("x_fail");
    expect(xAborts()).toBe(3); // 1 (pre-crash) + 2 (post-restart, reset) — not 2
    r.store.close();
  });

  test("a re-driven branch reuses its iteration (resume continues the attempt, no retry rotation)", async () => {
    const r = rig({ yaml: HOL_YAML });
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
    let bCalls = 0;
    r.dispatcher.register(r.workflowSha, "b_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        bCalls++;
        if (bCalls === 1) throw new Error("transient abort");
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
      },
    });
    enqueue(r, "iter1", "begin");
    await drive(r, "iter1");

    expect(r.store.getState("iter1")!.status).toBe("completed");
    expect(bCalls).toBe(2); // aborted once, then succeeded on the re-drive

    // The aborted attempt, the re-dispatch, and the eventual completion ALL carry
    // iteration 0: `fact.node_aborted` does NOT run the retry-policy rotation, so
    // the re-drive reuses the slot. That reuse is what makes
    // loadPriorMessagesForNode((b_scan, 0)) re-feed the aborted attempt's partial
    // transcript on resume — resume continues the thread; only retry rotates it.
    const bFacts = r.store
      .getEvents("iter1")
      .filter(
        (e) =>
          (e.type === "fact.dispatch_started" ||
            e.type === "fact.node_started" ||
            e.type === "fact.node_aborted" ||
            e.type === "fact.node_completed") &&
          (e.payload as { nodeId?: string }).nodeId === "b_scan",
      );
    expect(bFacts.some((e) => e.type === "fact.node_aborted")).toBe(true);
    expect(bFacts.some((e) => e.type === "fact.node_completed")).toBe(true);
    expect(bFacts.every((e) => (e.payload as { iteration?: number }).iteration === 0)).toBe(true);
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

  test("an in-flight branch STREAMS its observability mid-handler, not held until completion", async () => {
    const r = rig({ yaml: HOL_YAML });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // a_scan emits a cost.recorded, then polls for it to LAND in the store BEFORE
    // it returns. With the mid-handler flush timer it streams within ~50ms; without
    // it, the event is held until the branch completes (after this poll) → sawStreamed
    // stays false. (The head-of-line trick, applied to observability — this is what
    // kept an in-flight branch off the live Cost view + frozen in the transcript.)
    let sawStreamed = false;
    r.dispatcher.register(r.workflowSha, "a_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        ctx.emit("cost.recorded", { total_tokens: 7, cost_usd: 0.01, input_tokens: 5, output_tokens: 2 });
        for (let i = 0; i < 400 && !sawStreamed; i++) {
          const landed = r.store
            .getEvents(ctx.runId)
            .some((e) => e.type === "cost.recorded" && (e.payload as { nodeId?: string }).nodeId === "a_scan");
          if (landed) sawStreamed = true;
          else await new Promise((res) => setTimeout(res, 5));
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      },
    });
    const instant = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
      });
    instant("b_scan");
    instant("synth");
    enqueue(r, "stream1", "begin");
    await drive(r, "stream1");

    expect(sawStreamed).toBe(true); // the branch's cost.recorded streamed BEFORE it completed
    expect(r.store.getState("stream1")!.status).toBe("completed");
    r.store.close();
  });

  test("an UNBOUNDED branch that ignores its abort signal leak-halts the run rather than hanging the pool", async () => {
    const r = rig({ yaml: HUNG_YAML });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `hung` is UNBOUNDED (no maxMs) AND ignores ctx.signal — the worst case. The
    // branch backstop must reach invokeHandler's watchdog (maxMsOverride) so it
    // leak-halts at the deadline instead of awaiting the handler forever (which
    // wedged the whole run permanently, across restarts).
    r.dispatcher.register(r.workflowSha, "hung", {
      kind: "llm",
      sideEffect: "external",
      handler: () => new Promise<never>(() => {}), // never resolves, never checks the signal
    });
    const instant = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
      });
    instant("ok");
    instant("synth");
    enqueue(r, "leak1", "begin");

    await drive(r, "leak1", { fanoutBranchTimeoutMs: 40, leakGraceMs: 20 });
    const final = r.store.getState("leak1")!;
    expect(final.status).toBe("halted"); // reclaimed, not hung
    const halted = r.store.getEvents("leak1").find((e) => e.type === "fact.run_halted");
    expect((halted?.payload as { detail?: string }).detail).toBe("handler_leaked");
    r.store.close();
  });

  test("a leak-halt aborts the in-flight HEALTHY sibling rather than leaving it burning cost", async () => {
    const r = rig({ yaml: HUNG_YAML });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `hung` ignores its signal and has a SHORT maxMs, so the watchdog leak-halts
    // it fast (maxMs + leakGrace ≈ 50ms) — independent of the generous branch
    // backstop that keeps `ok` alive.
    r.dispatcher.register(r.workflowSha, "hung", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 30,
      handler: () => new Promise<never>(() => {}),
    });
    // `ok` is a healthy SLOW sibling with a LONG maxMs: still in-flight when the
    // leak fires. It records its abort SYNCHRONOUSLY via the signal listener (fires
    // inside the `.abort()` call), then throws — so it never commits a completion.
    // Without abortInflightPool the leak-halt would abandon it: it would run to its
    // own (5000ms) backstop, never observing the abort.
    let okSawAbort = false;
    r.dispatcher.register(r.workflowSha, "ok", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            okSawAbort = true;
            return resolve();
          }
          ctx.signal.addEventListener(
            "abort",
            () => {
              okSawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw ctx.signal.reason ?? new Error("aborted");
      },
    });
    r.dispatcher.register(r.workflowSha, "synth", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
    });
    enqueue(r, "leakabort1", "begin");

    await drive(r, "leakabort1", { fanoutBranchTimeoutMs: 5000, leakGraceMs: 20 });
    const final = r.store.getState("leakabort1")!;
    expect(final.status).toBe("halted");
    const halted = r.store.getEvents("leakabort1").find((e) => e.type === "fact.run_halted");
    expect((halted?.payload as { detail?: string }).detail).toBe("handler_leaked");
    // The healthy sibling OBSERVED its abort — it was signalled, not abandoned.
    expect(okSawAbort).toBe(true);
    // ...and it never committed a completion (it was reclaimed mid-flight).
    const okCompleted = r.store
      .getEvents("leakabort1")
      .some((e) => e.type === "fact.node_completed" && (e.payload as { nodeId?: string }).nodeId === "ok");
    expect(okCompleted).toBe(false);
    r.store.close();
  });

  test("a parallel node's max-cost cap sums its fan-out closure and trips (per-node bucket is always 0)", async () => {
    const r = rig({ yaml: BUDGET_FANOUT_YAML });
    const seen: Record<string, number> = {};
    const c = counter(seen, "a_scan", "a_verify", "b_scan", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    const spend = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => {
          c[id]?.();
          return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
        },
      });
    // Each branch entry spends 0.01 → closure cost reaches ≥0.02 > the 0.015 cap.
    // With the bug (reading nodeCosts[parallelNode], always 0) the cap never fires.
    spend("a_scan");
    spend("a_verify");
    spend("b_scan");
    spend("synth");
    enqueue(r, "bfo1", "begin");

    await drive(r, "bfo1");
    const final = r.store.getState("bfo1")!;
    expect(final.status).toBe("paused"); // default budget_policy=pause

    const pause = r.store.getEvents("bfo1").find((e) => e.type === "fact.run_paused");
    const p = pause?.payload as { reason?: string; nodeId?: string; scope?: string; metric?: string; limit?: number };
    expect(p.reason).toBe("budget");
    expect(p.scope).toBe("node");
    expect(p.metric).toBe("cost");
    expect(p.limit).toBe(0.015);
    // The disposition names the PARALLEL node (the cap's owner), not a sub-node.
    expect(p.nodeId).toBe("fan");
    r.store.close();
  });

  test("a parallel node crossing 80% of its max-cost emits budget.warn ONCE (not silent, not repeated)", async () => {
    const r = rig({
      yaml: `name: wfo
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan:
    type: parallel
    branches: [a_scan, b_scan]
    max-cost: 0.10
    next: synth
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // Each branch spends 0.045 → closure sum 0.09 = 90% of the 0.10 cap: warn, no breach.
    const spend = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.045 }),
      });
    spend("a_scan");
    spend("b_scan");
    r.dispatcher.register(r.workflowSha, "synth", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 }),
    });
    enqueue(r, "warn1", "begin");
    await drive(r, "warn1");

    const final = r.store.getState("warn1")!;
    expect(final.status).toBe("completed"); // a warn neither pauses nor halts
    const warns = r.store
      .getEvents("warn1")
      .filter((e) => e.type === "budget.warn" && (e.payload as { caller_node_id?: string }).caller_node_id === "fan");
    // Exactly once: not silent (the pre-fix gap), and not re-fired across the
    // region's many per-commit budget gates (the __budget_warned mark persisted).
    expect(warns).toHaveLength(1);
    expect(Array.isArray(final.routing["__budget_warned"])).toBe(true);
    r.store.close();
  });

  test("crash after branches commit but before join → committed branches do NOT re-run on recovery", async () => {
    const r = rig({ yaml: HOL_YAML });
    const seen: Record<string, number> = {};
    const c = counter(seen, "a_scan", "b_scan", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
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
    okLlm("a_scan");
    okLlm("b_scan");
    okLlm("synth");
    enqueue(r, "crash1", "begin");

    // Session 1: stop right after both branches commit node_completed but BEFORE
    // the join (run_started → begin → seed → dispatch-pool = 4 turns), then "crash".
    await drive(r, "crash1", { maxTurns: 4 });
    expect(r.store.getState("crash1")!.status).toBe("running");
    expect(r.store.getEvents("crash1").some((e) => e.type === "fact.fanout_joined")).toBe(false);
    expect(seen["a_scan"]).toBe(1);
    expect(seen["b_scan"]).toBe(1);

    // Restart: the sweep requeues the orphaned run; recovery joins + completes.
    expect(r.store.startupSweep().requeued.length).toBe(1);
    await drive(r, "crash1");
    expect(r.store.getState("crash1")!.status).toBe("completed");

    // Frontier-level recovery: the committed branches are NOT re-dispatched — their
    // handlers stay at ONE call across the crash. Only the un-run join advances.
    expect(seen["a_scan"]).toBe(1);
    expect(seen["b_scan"]).toBe(1);
    expect(seen["synth"]).toBe(1);
    r.store.close();
  });

  test("settle-order fuzz: ≥3 branches with varied per-branch latencies → replay(log) == live", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3, max: 5 }),
        fc.array(fc.nat({ max: 12 }), { minLength: 5, maxLength: 5 }),
        async (n, latencies) => {
          const r = rig({ yaml: parallelYaml(n) });
          const seen: Record<string, number> = {};
          r.dispatcher.register(r.workflowSha, "begin", {
            kind: "llm",
            sideEffect: "external",
            maxMs: 1000,
            handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
          });
          for (let i = 0; i < n; i++) {
            const id = `b${i}`;
            const delayMs = latencies[i % latencies.length]!;
            r.dispatcher.register(r.workflowSha, id, {
              kind: "llm",
              sideEffect: "external",
              maxMs: 1000,
              handler: async () => {
                // The varied delay fuzzes the Promise.race settle order so the
                // serialized commit lane is exercised under many interleavings.
                await new Promise((res) => setTimeout(res, delayMs));
                seen[id] = (seen[id] ?? 0) + 1;
                return {
                  kind: "transition",
                  outcomeStatus: "success",
                  tokens: 10,
                  costUsd: 0.01,
                  outputs: { findings: "x" },
                };
              },
            });
          }
          r.dispatcher.register(r.workflowSha, "synth", {
            kind: "llm",
            sideEffect: "external",
            maxMs: 1000,
            handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 }),
          });
          enqueue(r, "s", "begin");
          await drive(r, "s");

          const live = r.store.getState("s")!;
          expect(live.status).toBe("completed");
          // Every branch ran exactly once, whatever the settle order; no double-commit.
          for (let i = 0; i < n; i++) expect(seen[`b${i}`]).toBe(1);
          // The linearization point holds under any settle/commit interleaving:
          // folding the log alone reproduces the live projection.
          const replayed = deriveRunState("s", r.store.getEvents("s"));
          expect(replayed.status).toBe(live.status);
          expect(replayed.currentNode).toBe(live.currentNode);
          expect(readActiveNodes(replayed.routing)).toBeNull();
          r.store.close();
        },
      ),
      { numRuns: pbtRuns(40) },
    );
  });
});
