// Fan-out (Model A) — the on-log reactive frontier, end-to-end through the
// executor. docs/proposals/fan-out-nodes.md. Multi-node branches run as
// concurrent sub-pipelines (scan → verify) converging on a join; the frontier
// is folded from the log so replay matches the live projection and a mid-fan-out
// stop resumes by re-dispatching only the unfinished sub-nodes.

import { describe, expect, test } from "bun:test";
import { OPERATOR_NOTES_KEY, type OperatorNote, readOperatorNotes } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { ConcurrencyError, deriveRunState, getFrontier } from "@fragua/store";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
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

/** Asymmetric per-branch depth: a MULTI-node branch A (a0 → a1 → join) beside a
 * single-node branch B (b0 → join). The two branches reach different depths, so a
 * mid-region crash can leave A deeper than B — the asymmetric-crash recovery probe. */
const ASYM_YAML = `name: asym
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a0, b0], next: synth }
  a0: { type: llm, prompt: x, allowed-tools: [read], next: a1 }
  a1: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b0: { type: llm, prompt: x, allowed-tools: [read], next: synth }
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
  maxLoops?: number;
  /** Drive under a caller-owned shutdown signal so a test can simulate the daemon
   * dying mid-region (an in-handler `.abort()` leaves the run `running`). Defaults
   * to a never-aborting signal. */
  shutdownSignal?: AbortSignal;
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
    shutdownSignal: opts.shutdownSignal ?? new AbortController().signal,
    ...(opts.fanoutBranchTimeoutMs !== undefined ? { fanoutBranchTimeoutMs: opts.fanoutBranchTimeoutMs } : {}),
    ...(opts.abortLoopCeiling !== undefined ? { abortLoopCeiling: opts.abortLoopCeiling } : {}),
    ...(opts.leakGraceMs !== undefined ? { leakGraceMs: opts.leakGraceMs } : {}),
    ...(opts.maxLoops !== undefined ? { maxLoops: opts.maxLoops } : {}),
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
    expect(getFrontier(state.routing)).toBeNull();

    // Replay equivalence: deriving the state from the log alone reproduces the
    // live projection's terminal pointer + status (the frontier folds from the
    // log, interleaving frozen in seq order).
    const replayed = deriveRunState("fo1", events);
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(state.currentNode);
    expect(getFrontier(replayed.routing)).toBeNull();

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
    const halted = r.store
      .getEvents("leak1")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
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
    const halted = r.store
      .getEvents("leakabort1")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
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

  test("ASYMMETRIC crash mid-region (A deeper than B): each branch's cursor re-derives from the log — no re-run of the completed sub-node, no global barrier", async () => {
    const r = rig({ yaml: ASYM_YAML });
    const seen: Record<string, number> = {};
    const c = counter(seen, "a0", "a1", "b0", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });

    // The daemon dies mid-fan-out. `crashArmed` is true for session 1 (drives the
    // asymmetric crash) and flipped off before session 2 (recovery), so the SAME
    // handler registrations decide their behaviour by store-observable state, not
    // by re-registration (the dispatcher forbids re-registering a node).
    let crashArmed = true;
    const crash = new AbortController();
    let a1InFlight = false;
    const a0Committed = (): boolean =>
      r.store
        .getEvents("asym1")
        .some((e) => e.type === "fact.node_completed" && (e.payload as { nodeId?: string }).nodeId === "a0");
    const untilAborted = (signal: AbortSignal): Promise<never> =>
      new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
      });

    // a0 (branch A entry) succeeds immediately → commits node_completed(a0) and
    // seeds a1 (its dispatch_started rides the same commit). a0 is the DEEPER
    // branch's already-finished sub-node — the one recovery must NOT re-run.
    r.dispatcher.register(r.workflowSha, "a0", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        c["a0"]?.();
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
      },
    });
    // a1 (branch A's SECOND node) is in-flight at the crash: it marks itself live,
    // then parks on its abort signal. Session 1 → crash.abort() trips it (it never
    // commits a completion). Session 2 → crashArmed is false, so it just succeeds.
    r.dispatcher.register(r.workflowSha, "a1", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        c["a1"]?.();
        if (!crashArmed) return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
        a1InFlight = true;
        await untilAborted(ctx.signal);
        throw ctx.signal.reason ?? new Error("aborted"); // unreachable — untilAborted rejects first
      },
    });
    // b0 (single-node branch B) is the crash coordinator: it waits until a0 has
    // COMMITTED and a1 is confirmed in-flight (so the crash is asymmetric — A at a1,
    // B at b0, a0 already done), THEN fires the shutdown and parks on its own signal.
    // Session 2 → crashArmed is false, so it just succeeds.
    r.dispatcher.register(r.workflowSha, "b0", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        c["b0"]?.();
        if (!crashArmed) return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
        for (let i = 0; i < 400 && !(a0Committed() && a1InFlight); i++) {
          await new Promise((res) => setTimeout(res, 5));
        }
        crash.abort(new Error("daemon died")); // the asymmetric crash — a1 + b0 in-flight, a0 committed
        await untilAborted(ctx.signal);
        throw ctx.signal.reason ?? new Error("aborted"); // unreachable
      },
    });
    r.dispatcher.register(r.workflowSha, "synth", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        c["synth"]?.();
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
      },
    });
    enqueue(r, "asym1", "begin");

    // Session 1: drive under the crash signal. b0's coordinator fires crash.abort()
    // the moment a0 is committed AND a1 is in-flight; runOne's loop then drains the
    // two in-flight aborts and returns (shutdown observed) with the run still running.
    await drive(r, "asym1", { shutdownSignal: crash.signal });

    // The asymmetric crash state, read from the log alone:
    const crashState = r.store.getState("asym1")!;
    expect(crashState.status).toBe("running"); // orphaned, not terminal
    // a0 committed (deeper branch's first node done); the join never happened.
    expect(a0Committed()).toBe(true);
    expect(r.store.getEvents("asym1").some((e) => e.type === "fact.fanout_joined")).toBe(false);
    // The frontier is asymmetric: A sits at a1 (one deeper than its entry), B at b0.
    expect([...(getFrontier(crashState.routing) ?? [])].sort()).toEqual(["a1", "b0"]);
    // Both in-flight sub-nodes aborted WITHOUT committing a completion. Scope to the
    // fan-out region's sub-nodes (the linear `begin` completes ahead of the region).
    const region = new Set(["a0", "a1", "b0", "synth"]);
    const regionCompleted = (): string[] =>
      r.store
        .getEvents("asym1")
        .filter((e) => e.type === "fact.node_completed" && region.has((e.payload as { nodeId: string }).nodeId))
        .map((e) => (e.payload as { nodeId: string }).nodeId);
    expect(regionCompleted()).toEqual(["a0"]); // ONLY a0 — a1 + b0 aborted, never completed
    expect(seen).toEqual({ a0: 1, a1: 1, b0: 1 }); // each ran once so far; synth never

    // Restart: the startup sweep requeues the orphaned running run. No global
    // barrier is rebuilt — the active set [a1, b0] survives as the per-branch cursor.
    expect(r.store.startupSweep().requeued.length).toBe(1);

    // Session 2: a fresh (non-aborting) executor pass. crashArmed off ⇒ a1 + b0 now
    // succeed. Recovery re-dispatches ONLY the in-flight (aborted) frontier; a0 is
    // not in the active set, so it is never handed to its handler again.
    crashArmed = false;
    await drive(r, "asym1");
    expect(r.store.getState("asym1")!.status).toBe("completed");

    // The proof, per assertion:
    //  - a0 ran EXACTLY ONCE across the crash — a completed deeper-branch sub-node
    //    is NOT re-dispatched on recovery (it left the active set when it committed).
    expect(seen["a0"]).toBe(1);
    //  - a1 + b0 ran AGAIN — they were in-flight (aborted, never committed), so
    //    re-running them on recovery is correct, not a regression.
    expect(seen["a1"]).toBe(2);
    expect(seen["b0"]).toBe(2);
    //  - the join ran once and the run completed.
    expect(seen["synth"]).toBe(1);
    expect(getFrontier(r.store.getState("asym1")!.routing)).toBeNull(); // frontier drained
    // Every region sub-node + the join committed exactly one completion across the
    // crash (a0 once — NOT twice; a1 + b0 once each, on the recovery pass; synth once).
    expect(regionCompleted().sort()).toEqual(["a0", "a1", "b0", "synth"]);

    // Replay equivalence: folding the event log alone re-derives the live projection
    // (status + currentNode; active set null). This IS the "no barrier needed — the
    // active-set fold is the per-branch cursor" proof: the same log that recorded an
    // asymmetric crash replays to the same terminal state the live pass reached.
    const live = r.store.getState("asym1")!;
    const replayed = deriveRunState("asym1", r.store.getEvents("asym1"));
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(live.currentNode);
    expect(getFrontier(replayed.routing)).toBeNull();
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
          expect(getFrontier(replayed.routing)).toBeNull();
          r.store.close();
        },
      ),
      { numRuns: pbtRuns(40) },
    );
  });

  test("a downstream goal-gate re-enters the parallel node: clean second pass, cumulative cost, frontier re-seed", async () => {
    // begin → fan(parallel a,b → synth) → synth → gate → exit
    // `gate` (retry: fan) fails once, retargeting the parallel node, so the whole
    // region runs a SECOND pass. We assert it re-runs cleanly: both branches fire
    // twice, the frontier re-seeds from empty each pass (a replace, not append),
    // per-node cost is CUMULATIVE across passes (the run budget — not a per-pass
    // reset — governs a looped fan-out), and the log alone replays to the same
    // terminal. Each pass's facts carry the goal-gate re-entry epoch (`pass`),
    // so the two executions of the same (nodeId, iteration: 0) stay distinct in
    // the log and the node-state projection — the second pass no longer
    // silently overwrites the first.
    const yaml = `name: reentry
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: gate }
  gate:
    type: llm
    prompt: g
    retry: fan
    max-retries: 2
    next: exit
`;
    const r = rig({ yaml });
    const seen: Record<string, number> = {};
    const c = counter(seen, "a", "b", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    const branch = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => {
          c[id]?.();
          return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.01 };
        },
      });
    branch("a");
    branch("b");
    branch("synth");
    let gateCalls = 0;
    r.dispatcher.register(r.workflowSha, "gate", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        gateCalls++;
        return {
          kind: "transition",
          outcomeStatus: gateCalls === 1 ? "fail" : "success",
          tokens: 10,
          costUsd: 0.01,
        };
      },
    });

    enqueue(r, "re1", "begin");
    await drive(r, "re1", { maxTurns: 80 });

    const state = r.store.getState("re1")!;
    expect(state.status).toBe("completed");

    // Two full passes: each branch + the join fired once per pass; the gate failed
    // once then succeeded.
    expect(seen).toEqual({ a: 2, b: 2, synth: 2 });
    expect(gateCalls).toBe(2);

    const events = r.store.getEvents("re1");
    const types = events.map((e) => e.type);
    // One fan-out region per pass — re-entry opens a fresh started/joined pair.
    expect(types.filter((t) => t === "fact.fanout_started").length).toBe(2);
    expect(types.filter((t) => t === "fact.fanout_joined").length).toBe(2);

    // Each pass re-seeds the frontier with the SAME branch set (replace, not
    // append — no stale branch from the prior pass leaks in).
    const seeds = events.filter((e) => e.type === "fact.fanout_started");
    expect(seeds.map((e) => (e.payload as { branches: string[] }).branches)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    // The second seed carries the goal-gate re-entry epoch; the first omits it
    // (pass 0). Branch completions inherit their pass's epoch, so the two
    // executions of (a, iteration 0) are distinct facts, not a silent overwrite.
    expect(seeds.map((e) => (e.payload as { pass?: number }).pass)).toEqual([undefined, 1]);
    const aCompletions = events
      .filter((e) => e.type === "fact.node_completed" && (e.payload as { nodeId?: string }).nodeId === "a")
      .map((e) => (e.payload as { pass?: number }).pass);
    expect(aCompletions).toEqual([undefined, 1]);

    // Per-node cost is CUMULATIVE across passes: two 0.01 dispatches each.
    expect(state.metrics.nodeCosts["a"]?.costUsd).toBeCloseTo(0.02, 6);
    expect(state.metrics.nodeCosts["b"]?.costUsd).toBeCloseTo(0.02, 6);

    // Frontier drained; the log alone replays to the same terminal pointer.
    expect(getFrontier(state.routing)).toBeNull();
    const replayed = deriveRunState("re1", events);
    expect(replayed.status).toBe("completed");
    expect(replayed.currentNode).toBe(state.currentNode);
    expect(getFrontier(replayed.routing)).toBeNull();

    r.store.close();
  });
});

// ── Hardening: the adversarial-review fixes over the pool's bail, ceiling,
// disposition, and fold paths. Each test pins one repaired hole.
describe("executor — fan-out hardening", () => {
  test("a branch resolving to a run terminal halts the run (fail closed) instead of completing it mid-fan-out", async () => {
    const r = rig({
      yaml: `name: bterm
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [bad, ok], next: synth }
  bad: { type: llm, prompt: x, allowed-tools: [read], next: exit }
  ok: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    const seen: Record<string, number> = {};
    registerHandlers(r, counter(seen, "synth"));
    const llm = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
      });
    llm("bad");
    llm("ok");
    enqueue(r, "bterm1", "begin");

    await drive(r, "bterm1");
    const final = r.store.getState("bterm1")!;
    // The validator rejects this shape (E032/E039/E041) but unvalidated saves
    // still reach the executor: the branch terminal must never complete the run.
    expect(final.status).toBe("halted");
    const events = r.store.getEvents("bterm1");
    expect(
      events.some((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "completed"),
    ).toBe(false);
    const halted = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect((halted?.payload as { detail?: string }).detail).toBe("fanout_branch_terminal:bad");
    // The branch's own work is still durable; only the run terminal was refused.
    expect(
      events.some((e) => e.type === "fact.node_completed" && (e.payload as { nodeId?: string }).nodeId === "bad"),
    ).toBe(true);
    // The join never ran, and no sentinel successor was dispatched into the pool.
    expect(seen["synth"]).toBeUndefined();
    r.store.close();
  });

  test("a fanout_branch_terminal halt that loses its OCC race is re-committed next turn, never silently lost", async () => {
    // The halt is derived from an in-memory branch outcome (the branch's
    // node_completed already removed it from the active set), so "re-derive
    // from fresh state next turn" can never recapture it. Pre-fix: an
    // OCC-exhausted disposition commit returned `continue`, the next turn saw
    // a drained frontier, committed fanout_joined, and the run sailed through
    // the join as if healthy. Now the disposition parks in
    // `pendingFanoutDisposition` and lands at the next turn's entry.
    const r = rig({
      yaml: `name: btermocc
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [bad, ok], next: synth }
  bad: { type: llm, prompt: x, allowed-tools: [read], next: exit }
  ok: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    const seen: Record<string, number> = {};
    registerHandlers(r, counter(seen, "synth"));
    const llm = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
      });
    llm("bad");
    llm("ok");
    // Storm the FIRST disposition commit into OCC exhaustion (one full
    // commitFanoutFact round), then let the re-commit through.
    const origAppend = r.store.appendFact.bind(r.store);
    let haltConflicts = 0;
    r.store.appendFact = (runId, facts, version, appendOpts) => {
      if (facts[0]?.type === "fact.run_terminated" && haltConflicts < 8) {
        haltConflicts++;
        throw new ConcurrencyError(version, version + 1);
      }
      return origAppend(runId, facts, version, appendOpts);
    };
    enqueue(r, "btermocc1", "begin");

    await drive(r, "btermocc1", { maxTurns: 40 });
    const final = r.store.getState("btermocc1")!;
    expect(haltConflicts).toBe(8); // the storm actually exhausted one commit round
    expect(final.status).toBe("halted");
    const events = r.store.getEvents("btermocc1");
    expect(
      events.some((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "completed"),
    ).toBe(false);
    expect(events.some((e) => e.type === "fact.fanout_joined")).toBe(false);
    const halted = events.find(
      (e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored",
    );
    expect((halted?.payload as { detail?: string }).detail).toBe("fanout_branch_terminal:bad");
    expect(seen["synth"]).toBeUndefined();
    r.store.close();
  });

  test("a rejected branch arm aborts and drains the in-flight sibling before unwinding", async () => {
    const r = rig({ yaml: HUNG_YAML });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `hung` plays the rejection vector: dispatcher.get throws for it (the same
    // class as an unguarded store-write failure inside a pool arm).
    const origGet = r.dispatcher.get.bind(r.dispatcher);
    r.dispatcher.get = (sha, node) => {
      if (node === "hung") throw new Error("boom: no handler for hung");
      return origGet(sha, node);
    };
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
    enqueue(r, "rej1b", "begin");

    await expect(drive(r, "rej1b", { leakGraceMs: 50 })).rejects.toThrow("boom");
    // runOne's outer net terminalised the run...
    expect(r.store.getState("rej1b")!.status).toBe("halted");
    // ...and the healthy in-flight sibling was signalled, not stranded burning
    // cost until the per-branch backstop.
    expect(okSawAbort).toBe(true);
    r.store.close();
  });

  test("a status-stop bail never starts a semaphore-queued branch (no unabortable orphan)", async () => {
    const r = rig({
      yaml: `name: qbail
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [pauser, slow, q1, q2], concurrency: 2, next: synth }
  pauser: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  slow: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  q1: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  q2: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `pauser` simulates an operator pause landing mid-pool: it parks the run
    // itself, so pauser's own success commit becomes a status-stop bail.
    r.dispatcher.register(r.workflowSha, "pauser", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        const st = r.store.getState("qb1")!;
        r.store.appendFact(
          "qb1",
          [{ type: "fact.run_paused", payload: { reason: "operator", nodeId: "fan" } }],
          st.version,
        );
        return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
      },
    });
    let slowSawAbort = false;
    r.dispatcher.register(r.workflowSha, "slow", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 5000,
      handler: async (ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) {
            slowSawAbort = true;
            return resolve();
          }
          ctx.signal.addEventListener(
            "abort",
            () => {
              slowSawAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        throw ctx.signal.reason ?? new Error("aborted");
      },
    });
    // The waiter queue is FIFO: q1 takes PAUSER's slot, freed at settle, before
    // the loop has processed the failed commit — legitimate bounded overshoot
    // (it registers, so the bail signal still reaches it; its commit is fenced
    // by the status-stop). q2 takes SLOW's slot, freed by the abort teardown,
    // i.e. strictly post-bail — pre-fix it started a fresh handler the
    // already-fired bail signal could never reach.
    let q2Ran = 0;
    r.dispatcher.register(r.workflowSha, "q1", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "q2", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        q2Ran++;
        return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
      },
    });
    enqueue(r, "qb1", "begin");

    await drive(r, "qb1", { leakGraceMs: 100 });
    expect(r.store.getState("qb1")!.status).toBe("paused");
    expect(slowSawAbort).toBe(true);
    // The post-bail slot handoff never starts the queued branch.
    expect(q2Ran).toBe(0);
    // And no branch committed a completion against the parked run.
    const branchIds = new Set(["pauser", "slow", "q1", "q2"]);
    expect(
      r.store
        .getEvents("qb1")
        .some(
          (e) => e.type === "fact.node_completed" && branchIds.has((e.payload as { nodeId?: string }).nodeId ?? ""),
        ),
    ).toBe(false);
    r.store.close();
  });

  test("a branch-closure cycle is bounded by the max_loops dispatch ceiling", async () => {
    const r = rig({
      yaml: `name: spinfo
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [spin_a, ok], next: synth }
  spin_a: { type: llm, prompt: x, allowed-tools: [read], next: spin_b }
  spin_b: { type: llm, prompt: x, allowed-tools: [read], next: spin_a }
  ok: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    const seen: Record<string, number> = {};
    const c = counter(seen, "spin_a", "spin_b", "ok", "synth");
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    const llm = (id: string) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => {
          c[id]?.();
          return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 };
        },
      });
    llm("spin_a");
    llm("spin_b");
    llm("ok");
    llm("synth");
    enqueue(r, "spin1", "begin");

    // Pre-fix this spun unboundedly INSIDE one runFanout turn (no budget, no
    // aborts — nothing else fires); the ceiling is the only durable stop.
    await drive(r, "spin1", { maxLoops: 8 });
    const final = r.store.getState("spin1")!;
    expect(final.status).toBe("paused");
    const pause = r.store.getEvents("spin1").find((e) => e.type === "fact.run_paused");
    const p = pause?.payload as { reason?: string; currentLimit?: number };
    expect(p.reason).toBe("max_loops");
    expect(p.currentLimit).toBe(8);
    // Every sub-node dispatch consumed loop budget: the cycle is bounded.
    expect((seen["spin_a"] ?? 0) + (seen["spin_b"] ?? 0)).toBeLessThanOrEqual(8);
    r.store.close();
  });

  test("a run-level stop breach after a captured node pause upgrades the disposition to halted", async () => {
    const r = rig({
      yaml: `name: updisp
defaults: { provider: anthropic, model: m }
budget: 0.07
budget-policy: stop
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], max-cost: 0.015, next: synth }
  a: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // `a` settles first and trips the parallel node's max-cost (pause policy);
    // `b` is already in flight, drains, and its spend crosses the RUN-level
    // stop ceiling — the halt must win over the earlier-captured pause.
    r.dispatcher.register(r.workflowSha, "a", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.02 }),
    });
    r.dispatcher.register(r.workflowSha, "b", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        await new Promise((res) => setTimeout(res, 30));
        return { kind: "transition", outcomeStatus: "success", tokens: 10, costUsd: 0.06 };
      },
    });
    enqueue(r, "up1", "begin");

    await drive(r, "up1");
    const final = r.store.getState("up1")!;
    // Pre-fix: first-breach-wins froze the pause and the run parked resumable
    // despite a hard stop breach. Halt overrides pause, at every capture site.
    expect(final.status).toBe("halted");
    const halted = r.store
      .getEvents("up1")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    expect((halted?.payload as { reason?: string }).reason).toBe("budget");
    expect(r.store.getEvents("up1").some((e) => e.type === "fact.run_paused")).toBe(false);
    r.store.close();
  });

  test("persistent OCC exhaustion on the re-dispatch commit escalates to occ_exhausted (no silent spin)", async () => {
    const r = rig({ yaml: HOL_YAML });
    r.dispatcher.register(r.workflowSha, "begin", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", nextNode: "fan", tokens: 0, costUsd: 0 }),
    });
    // a_scan aborts once (transient) so its re-drive goes through the
    // re-dispatch arm on the next turn.
    let aCalls = 0;
    r.dispatcher.register(r.workflowSha, "a_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => {
        aCalls++;
        const err = new Error("transient");
        err.name = "AbortError";
        throw err;
      },
    });
    r.dispatcher.register(r.workflowSha, "b_scan", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "synth", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 1000,
      handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0 }),
    });
    // Inject a permanent OCC conflict on the re-dispatch commit only.
    const origAppend = r.store.appendFact.bind(r.store);
    r.store.appendFact = (runId, facts, version, appendOpts) => {
      const f0 = facts[0];
      if (f0?.type === "fact.dispatch_started" && (f0.payload as { resumeOf?: string }).resumeOf === "paused") {
        throw new ConcurrencyError(version, version + 1);
      }
      return origAppend(runId, facts, version, appendOpts);
    };
    enqueue(r, "occ1", "begin");

    await drive(r, "occ1", { abortLoopCeiling: 50, maxTurns: 40 });
    const final = r.store.getState("occ1")!;
    // Pre-fix the arm dropped the commit reason and re-entered forever (the
    // run stayed `running` until maxTurns); now the conflict controller parks it.
    expect(final.status).toBe("halted");
    const halted = r.store
      .getEvents("occ1")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { status?: string }).status === "errored");
    const hp = halted?.payload as { reason?: string; detail?: string };
    expect(hp.reason).toBe("occ_exhausted");
    expect(hp.detail).toContain("fact.dispatch_started");
    expect(aCalls).toBeGreaterThanOrEqual(1);
    r.store.close();
  });

  test("an operator budget raise riding a branch's success commit merges with the plan's routing patch (intent not clobbered)", async () => {
    const r = rig({
      yaml: `name: foldfo
defaults: { provider: anthropic, model: m }
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a_scan, b_scan], max-cost: 0.015, next: synth }
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: a_verify }
  a_verify: { type: llm, prompt: x, allowed-tools: [read], retry: a_scan, max-retries: 2, next: synth }
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
    const llm = (id: string, costUsd: number) =>
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async () => ({ kind: "transition", outcomeStatus: "success", tokens: 10, costUsd }),
      });
    // a_scan alone crosses the node cap: its commit bundles a_verify's
    // dispatch_started, then the pause disposition stops the pool — a_verify is
    // active-but-never-started when the run parks (the drain-barrier shape).
    llm("a_scan", 0.02);
    llm("a_verify", 0.001);
    llm("b_scan", 0.001);
    llm("synth", 0);
    enqueue(r, "fold1", "begin");

    await drive(r, "fold1");
    expect(r.store.getState("fold1")!.status).toBe("paused");

    // Raise & Resume: the budget override intent folds into the NEXT turn's
    // decision and rides the first commit — which is a_verify's SUCCESS commit
    // (no aborted branches to re-dispatch), whose goal-gate plan carries its
    // own routingPatch. Pre-fix the plan patch shallow-replaced the fold while
    // advanceAppliedTo still committed: the raise was consumed but never
    // applied, and the run re-paused on the old cap forever.
    r.store.appendIntent("fold1", {
      type: "intent.budget_adjusted",
      payload: { scope: "node", metric: "cost", newLimit: 0.5 },
    });
    r.store.appendIntent("fold1", { type: "intent.resume", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("fold1")!.status).toBe("queued");

    await drive(r, "fold1");
    const final = r.store.getState("fold1")!;
    expect(final.status).toBe("completed");
    // Both patches landed on the same commit: the override AND the goal-gate
    // outcome stamp.
    expect(final.routing["budget_override.node.cost"]).toBe(0.5);
    expect(final.routing["goal_gates.a_verify"]).toBe("success");
    r.store.close();
  });
});

describe("executor — fan-out and operator gate notes (SPEC §3.4)", () => {
  /** `ask(human) → fan[a_scan → a_verify, b_scan] → synth`. The gate answer's
   * note is addressed to the region; the branch closure is where the delivery
   * rule has to hold. */
  const GATED_FANOUT_YAML = `name: gatefan
defaults: { provider: anthropic, model: m }
steps:
  ask:
    type: human
    text: ok?
    routes: {go: fan}
  fan: { type: parallel, branches: [a_scan, b_scan], next: synth }
  a_scan: { type: llm, prompt: x, allowed-tools: [read], next: a_verify }
  a_verify: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  b_scan: { type: llm, prompt: x, allowed-tools: [read], next: synth }
  synth: { type: llm, prompt: done, next: exit }
`;

  test("a gate note reaches every branch ENTRY and no deeper sub-node", async () => {
    const r = rig({ yaml: GATED_FANOUT_YAML });
    r.dispatcher.register(
      r.workflowSha,
      "ask",
      handler.makeHumanHandler({ nodeId: "ask", text: "ok?", routes: ["go"], edges: [{ route: "go", to: "fan" }] }),
    );
    // Stands in for the llm bridge: reads the pending notes off ctx.routing
    // exactly the way makeLlmHandler does before it builds the prompt.
    const seen: Record<string, OperatorNote[]> = {};
    for (const id of ["a_scan", "a_verify", "b_scan", "synth"]) {
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async (ctx) => {
          seen[id] = readOperatorNotes(ctx.routing as Record<string, unknown>);
          return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0.001 };
        },
      });
    }
    enqueue(r, "gf1", "ask");
    await drive(r, "gf1");
    expect(r.store.getState("gf1")!.status).toBe("paused_human");

    r.store.appendIntent("gf1", { type: "intent.human_input", payload: { route: "go", note: "use the v2 schema" } });
    expect(wakePending(r.store).humanWoken).toContain("gf1");
    await drive(r, "gf1");

    const state = r.store.getState("gf1")!;
    expect(state.status).toBe("completed");

    const note = { gateNodeId: "ask", route: "go", note: "use the v2 schema" };
    // Both branch ENTRIES see it — the correction is addressed to the region,
    // and which branch happens to settle first must not decide who hears it.
    expect(seen["a_scan"]).toEqual([note]);
    expect(seen["b_scan"]).toEqual([note]);
    // `a_verify` is branch A's SECOND node. It dispatches inside the same
    // runFanout turn, off a `liveRouting` that never folds the clear a settled
    // sibling committed — so without the strip it re-received the note and
    // re-applied "overriding any conflicting instruction" to a step whose job
    // was to JUDGE a_scan's output, not redo it.
    expect(seen["a_verify"]).toEqual([]);
    // The join, past the region, reads committed routing: already consumed.
    expect(seen["synth"]).toEqual([]);
    expect(state.routing[OPERATOR_NOTES_KEY]).toEqual([]);
    r.store.close();
  });

  test("no pending note — a fan-out region dispatches unchanged", async () => {
    const r = rig({ yaml: GATED_FANOUT_YAML });
    r.dispatcher.register(
      r.workflowSha,
      "ask",
      handler.makeHumanHandler({ nodeId: "ask", text: "ok?", routes: ["go"], edges: [{ route: "go", to: "fan" }] }),
    );
    const seen: Record<string, OperatorNote[]> = {};
    for (const id of ["a_scan", "a_verify", "b_scan", "synth"]) {
      r.dispatcher.register(r.workflowSha, id, {
        kind: "llm",
        sideEffect: "external",
        maxMs: 1000,
        handler: async (ctx) => {
          seen[id] = readOperatorNotes(ctx.routing as Record<string, unknown>);
          return { kind: "transition", outcomeStatus: "success", tokens: 1, costUsd: 0.001 };
        },
      });
    }
    enqueue(r, "gf2", "ask");
    await drive(r, "gf2");
    // A pure route choice: no note staged, nothing to strip.
    r.store.appendIntent("gf2", { type: "intent.human_input", payload: { route: "go" } });
    wakePending(r.store);
    await drive(r, "gf2");

    expect(r.store.getState("gf2")!.status).toBe("completed");
    expect(seen).toEqual({ a_scan: [], b_scan: [], a_verify: [], synth: [] });
    r.store.close();
  });
});
