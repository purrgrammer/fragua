// Deterministic end-to-end topology harness — one test per distinct workflow
// shape, driven through the REAL engine (parser → state machine → fact log)
// against an EPHEMERAL store with a scripted, network-free executor.
//
// Where `packages/cli/test/single-step-llm.e2e.test.ts` boots the full executor
// against an HTTP-stubbed provider (proving the backend → handler bridge), and
// `driven-executor.property.test.ts` drives GENERATED `Graph` objects, this
// closes the remaining gap: each multi-step topology is authored as YAML, run
// through `parseWorkflow` (so a parser regression on `next:`/`routes:`/`on:`
// coexistence, fan-out, loops, or HITL gates fails CI here, not in production),
// and driven to a terminal by scripted `HandlerSpec`s that return canned turn
// results — no live LLM, no network, no clock nondeterminism. Re-running any of
// these produces an identical `fact.*` sequence.
//
// Each test asserts the folded `run_state` (terminal status) AND the `fact.*`
// spine (which nodes ran, in what order, which pauses/resumes fired) — never
// just "it didn't throw."

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, type Graph, type Node, parseWorkflow, serializeGraph } from "@fragua/core";
import * as handler from "@fragua/core/handler";
import { type RunState, SqliteStore, type StoredEvent } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";

const TERMINAL_STATUS = new Set(["completed", "halted", "cancelled"]);

/** A scripted turn result for one dispatch of a node: the outcome the handler
 * returns and, for routing nodes, which declared route the agent "chose". */
interface Turn {
  outcome: "success" | "fail" | "retry";
  route?: string;
}

/** Per-node script: the ordered turns to return across successive dispatches
 * (the run re-enters a node on each loop/retry, so the sequence is consumed in
 * order; the last entry repeats if the node is dispatched more times). */
type Script = Record<string, Turn[]>;

interface DriveResult {
  events: StoredEvent[];
  facts: StoredEvent[];
  state: RunState;
  status: string;
}

const nodeIdOf = (e: StoredEvent): string | undefined => (e.payload as { nodeId?: string }).nodeId;

/** Index of the first fact of `type` (optionally for `node`), asserting it
 * exists — the primitive for "A happened before B" ordering assertions. */
function factIndex(facts: StoredEvent[], type: string, node?: string): number {
  const i = facts.findIndex((e) => e.type === type && (node === undefined || nodeIdOf(e) === node));
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

/** Ids of the AUTHORED nodes that completed, in log order — the synthetic
 * `start`/`exit` sinks (which also emit `fact.node_completed`) are dropped so
 * assertions read against the workflow the author wrote. */
const completedNodes = (facts: StoredEvent[]): string[] =>
  facts
    .filter((e) => e.type === "fact.node_completed")
    .map((e) => nodeIdOf(e) ?? "")
    .filter((id) => id !== "start" && id !== "exit");

/** Parse YAML → Graph, save it to an ephemeral store, register a scripted
 * handler per non-terminal node, and drive `runOne` to a terminal. Human nodes
 * keep the auto-dispatcher's real HITL handler (yield → route on resume); their
 * pause is answered with the script's route for that node. `paused_auto`
 * (goal-gate retry) is woken by advancing the injected clock past the backoff,
 * exactly as the daemon loop does. Fully deterministic: injected clock + fixed
 * RNG, no network. */
async function drive(source: string, script: Script, opts: { maxSteps?: number } = {}): Promise<DriveResult> {
  const maxSteps = opts.maxSteps ?? 100;
  const graph: Graph = parseWorkflow(source);

  let nowMs = 1_700_000_000_000;
  const clock = (): number => {
    nowMs += 1;
    return nowMs;
  };

  const dir = mkdtempSync(join(tmpdir(), "fragua-topology-"));
  const store = new SqliteStore({ path: join(dir, "fragua.db"), now: clock });
  try {
    const sha = "topology";
    store.saveWorkflow(sha, graph.id, source, serializeGraph(graph), CURRENT_IR_VERSION);

    const dispatcher = new Dispatcher();
    dispatcher.setResolver(autoDispatcherResolver({ store }));
    for (const node of Object.values(graph.nodes)) {
      if (node.type === "start" || node.type === "exit" || node.type === "human") continue;
      dispatcher.register(sha, node.id, scriptedSpec(node, script[node.id] ?? [{ outcome: "success" }]));
    }

    const runId = "topology-run";
    store.enqueueRun({ runId, workflowSha: sha, priority: 0, initialRouting: { start_node: "start" } });

    const runOpts = {
      store,
      dispatcher,
      registry: new AbortRegistry(),
      tools: new handler.InMemoryToolRegistry(),
      llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
      maxConcurrentRuns: 1,
      maxTurnsForTesting: 200,
      shutdownSignal: new AbortController().signal,
      clock,
      random: () => 0.5,
    };

    for (let step = 0; step < maxSteps; step++) {
      store.claimNextRun(1);
      await runOne(runId, runOpts);
      const st = store.getState(runId);
      if (st === null || TERMINAL_STATUS.has(st.status)) break;
      if (st.status === "paused_auto") {
        nowMs += 3_600_000; // jump past the retry backoff so wake-pending fires
        wakePending(store, clock);
        continue;
      }
      if (st.status === "paused_human") {
        const pause = [...store.getEvents(runId)]
          .reverse()
          .find((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "human");
        const node = nodeIdOf(pause as StoredEvent);
        const route = script[node ?? ""]?.[0]?.route;
        const routes = (pause?.payload as { routes?: string[] } | undefined)?.routes ?? [];
        const chosen = route ?? routes[0];
        if (chosen === undefined) break;
        store.appendIntent(runId, { type: "intent.human_input", payload: { route: chosen } });
        wakePending(store, clock);
        continue;
      }
      break; // an operator resting pause — not expected in these scripts
    }

    const state = store.getState(runId);
    if (state === null) throw new Error("run vanished from the store");
    const events = store.getEvents(runId);
    return { events, facts: events.filter((e) => e.type.startsWith("fact.")), state, status: state.status };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scripted handler for one node. The per-node call counter persists across
 * re-dispatches (loops/retries re-enter the same node), so the turn sequence is
 * consumed in order; the final turn repeats once the sequence is exhausted. */
function scriptedSpec(node: Node, turns: Turn[]): handler.HandlerSpec {
  let call = 0;
  return {
    kind: node.type === "tool" ? "tool" : "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      const turn = turns[Math.min(call, turns.length - 1)] ?? { outcome: "success" };
      call++;
      const result: handler.HandlerResult = {
        kind: "transition",
        outcomeStatus: turn.outcome,
        tokens: 0,
        costUsd: 0,
      };
      if (turn.route !== undefined) result.route = turn.route;
      return result;
    },
  };
}

describe("e2e: deterministic workflow topologies over an ephemeral store", () => {
  test("linear next: chain runs every step in order and completes", async () => {
    const source = [
      "name: e2e-linear",
      "steps:",
      "  a: {type: llm, prompt: A, next: b}",
      "  b: {type: llm, prompt: B, next: c}",
      "  c: {type: llm, prompt: C, next: exit}",
    ].join("\n");

    const { status, facts } = await drive(source, {});

    expect(status).toBe("completed");
    expect(completedNodes(facts)).toEqual(["a", "b", "c"]);
    expect(facts[0]?.type).toBe("fact.run_started");
    expect(facts.at(-1)?.type).toBe("fact.run_terminated");
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
    expect(facts.filter((e) => e.type === "fact.run_terminated").length).toBe(1);
    expect(facts.some((e) => e.type === "fact.run_paused")).toBe(false);
    // strict ordering across the chain
    expect(factIndex(facts, "fact.node_completed", "a")).toBeLessThan(factIndex(facts, "fact.node_completed", "b"));
    expect(factIndex(facts, "fact.node_completed", "b")).toBeLessThan(factIndex(facts, "fact.node_completed", "c"));
  });

  test("routes: branching takes only the chosen branch", async () => {
    const source = [
      "name: e2e-routes",
      "steps:",
      "  classify:",
      "    type: llm",
      "    prompt: classify",
      "    routes:",
      "      left:  {to: left_step,  label: Left}",
      "      right: {to: right_step, label: Right}",
      "  left_step:  {type: llm, prompt: L, next: exit}",
      "  right_step: {type: llm, prompt: R, next: exit}",
    ].join("\n");

    const { status, facts } = await drive(source, { classify: [{ outcome: "success", route: "left" }] });

    expect(status).toBe("completed");
    const ran = completedNodes(facts);
    expect(ran).toContain("classify");
    expect(ran).toContain("left_step");
    expect(ran).not.toContain("right_step");
    // the persisted route lands on the classify completion
    const classify = facts.find((e) => e.type === "fact.node_completed" && nodeIdOf(e) === "classify");
    expect((classify?.payload as { route?: string }).route).toBe("left");
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
  });

  test("read-only fan-out runs both branches and converges on the join", async () => {
    const source = [
      "name: e2e-fanout",
      "steps:",
      "  seed: {type: llm, prompt: seed, next: fan}",
      "  fan:",
      "    type: parallel",
      "    branches: [b1, b2]",
      "    next: join",
      "  b1: {type: llm, prompt: B1, next: join}",
      "  b2: {type: llm, prompt: B2, next: join}",
      "  join: {type: llm, prompt: join, next: exit}",
    ].join("\n");

    const { status, facts } = await drive(source, {});

    expect(status).toBe("completed");
    const ran = completedNodes(facts);
    expect(ran).toContain("b1");
    expect(ran).toContain("b2");
    // the join runs exactly once, after both branches
    expect(ran.filter((n) => n === "join").length).toBe(1);
    expect(factIndex(facts, "fact.node_completed", "b1")).toBeLessThan(factIndex(facts, "fact.node_completed", "join"));
    expect(factIndex(facts, "fact.node_completed", "b2")).toBeLessThan(factIndex(facts, "fact.node_completed", "join"));
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
  });

  test("edge-cycle loop retries the back-edge, then exits on success", async () => {
    // build fails once → repair → build again → success → exit. A genuine
    // graph cycle (build → repair → build), not a goal-gate retarget.
    const source = [
      "name: e2e-edge-loop",
      "steps:",
      "  build:",
      "    type: tool",
      "    run: make",
      "    on: {success: exit, fail: repair}",
      "  repair: {type: llm, prompt: repair, next: build}",
    ].join("\n");

    const { status, facts } = await drive(source, {
      build: [{ outcome: "fail" }, { outcome: "success" }],
    });

    expect(status).toBe("completed");
    const ran = completedNodes(facts);
    // build dispatched twice (fail, then success), repair once
    expect(ran.filter((n) => n === "build").length).toBe(2);
    expect(ran.filter((n) => n === "repair").length).toBe(1);
    // repair (the back-edge) runs between build's fail and its retry
    const buildCompletions = facts
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "fact.node_completed" && nodeIdOf(e) === "build")
      .map(({ i }) => i);
    expect(buildCompletions.length).toBe(2);
    expect(factIndex(facts, "fact.node_completed", "repair")).toBeGreaterThan(buildCompletions[0]!);
    expect(factIndex(facts, "fact.node_completed", "repair")).toBeLessThan(buildCompletions[1]!);
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
  });

  test("goal-gate loop retargets on retry, then completes", async () => {
    // check is a goal gate (retry: work). First check retargets to work
    // (handler_retry auto-wake); the second passes → exit.
    const source = [
      "name: e2e-goal-gate",
      "steps:",
      "  work: {type: llm, prompt: work, next: check}",
      "  check:",
      "    type: llm",
      "    prompt: check",
      "    retry: work",
      "    max-retries: 3",
      "    next: exit",
    ].join("\n");

    const { status, facts, events } = await drive(source, {
      check: [{ outcome: "fail" }, { outcome: "success" }],
    });

    expect(status).toBe("completed");
    const ran = completedNodes(facts);
    // check fails once → the §3.4 goal-gate retarget re-runs retry_target (work)
    // synchronously, then check passes → exit. So both run twice.
    expect(ran.filter((n) => n === "work").length).toBe(2);
    expect(ran.filter((n) => n === "check").length).toBe(2);
    // the retarget is a synchronous re-run, not an auto-wake pause
    expect(facts.some((e) => e.type === "fact.run_paused")).toBe(false);
    expect(events.some((e) => e.type === "goal_gate.retarget")).toBe(true);
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
  });

  test("human HITL gate pauses, is answered, and resumes to completion", async () => {
    const source = [
      "name: e2e-hitl",
      "steps:",
      "  ask:",
      "    type: human",
      "    text: choose",
      "    routes:",
      "      go: {to: after, label: Go}",
      "  after: {type: llm, prompt: after, next: exit}",
    ].join("\n");

    const { status, facts } = await drive(source, { ask: [{ outcome: "success", route: "go" }] });

    expect(status).toBe("completed");
    const humanPauses = facts.filter(
      (e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "human",
    );
    expect(humanPauses.length).toBe(1);
    expect(nodeIdOf(humanPauses[0] as StoredEvent)).toBe("ask");
    expect(facts.filter((e) => e.type === "fact.run_resumed").length).toBeGreaterThanOrEqual(1);
    // the gate pauses before `after` runs, and `after` completes after the resume
    expect(completedNodes(facts)).toContain("after");
    expect(factIndex(facts, "fact.run_paused")).toBeLessThan(factIndex(facts, "fact.node_completed", "after"));
    expect((facts.at(-1)?.payload as { status?: string }).status).toBe("completed");
  });
});
