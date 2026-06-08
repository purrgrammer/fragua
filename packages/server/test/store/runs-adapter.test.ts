// Unit tests for the Store → RunSummary adapter's title + input picking.
// The rest of the summary (status, metrics, timing) is exercised through
// the route tests; these cases focus on the fields that were missing
// until auto-title support landed.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, StoredEvent } from "@fragua/store";
import {
  deriveNodeStates,
  deriveSelectedEdges,
  runStateToDetail,
  runStateToSummary,
} from "../../src/store/runs-adapter.ts";

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    runId: "r1",
    version: 1,
    status: "running",
    currentNode: "n1",
    workflowSha: "wf",
    contractVersion: 1,
    routing: {},
    metrics: {
      billedTokens: 0,
      totalCostUsd: 0,
      totalInputCostUsd: 0,
      totalOutputCostUsd: 0,
      totalCacheReadCostUsd: 0,
      totalCacheWriteCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      loopCounts: {},
      models: {},
      nodeCosts: {},
      activeMs: 0,
    },
    nextSeq: 10,
    lastAppliedSeq: 1,
    priority: 0,
    enqueuedAt: 1_000_000,
    readyAt: 1_000_000,
    nodeStartedAt: null,
    dispatchStartedAt: null,
    updatedAt: 1_000_000,
    title: null,
    baseGitSha: null,
    baseGitRef: null,
    finalGitSha: null,
    finalHeadRef: null,
    diffBaseSha: null,
    changeStat: null,
    inboxStatus: null,
    acceptedSha: null,
    cwd: null,
    projectId: "proj-1",
    projectName: "proj",
    workflowName: null,
    workflowScope: null,
    workflowPath: null,
    scheduleId: null,
    ...overrides,
  };
}

function ev(type: string, payload: Record<string, unknown>, ts = 1_000_100): StoredEvent {
  return { runId: "r1", seq: 0, type, writer: "daemon", payload, ts };
}

describe("runStateToSummary — title + input", () => {
  test("picks up title from run.title_generated event", () => {
    const s = makeState();
    const events: StoredEvent[] = [
      ev("fact.run_started", { startNode: "n1" }),
      ev("run.title_generated", { title: "Rename foo to bar" }),
    ];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBe("Rename foo to bar");
  });

  test("no title event → summary.title undefined", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("fact.run_started", { startNode: "n1" })];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBeUndefined();
  });

  test("multiple title events → last one wins", () => {
    const s = makeState();
    const events: StoredEvent[] = [
      ev("run.title_generated", { title: "first guess" }, 1_000_100),
      ev("run.title_generated", { title: "refined" }, 1_000_200),
    ];
    const summary = runStateToSummary(s, events, undefined);
    expect(summary.title).toBe("refined");
  });

  test("empty-string title is ignored (falls back to undefined)", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("run.title_generated", { title: "" })];
    expect(runStateToSummary(s, events, undefined).title).toBeUndefined();
  });

  test("non-string title payload is ignored", () => {
    const s = makeState();
    const events: StoredEvent[] = [ev("run.title_generated", { title: 42 })];
    expect(runStateToSummary(s, events, undefined).title).toBeUndefined();
  });

  test("routing.input in routing is not surfaced on summary (field removed)", () => {
    const s = makeState({ routing: { input: "rename foo() to bar()" } });
    const summary = runStateToSummary(s, [], undefined);
    expect((summary as Record<string, unknown>)["input"]).toBeUndefined();
  });
});

describe("deriveNodeStates — outcomeStatus awareness", () => {
  test("node_completed with outcomeStatus=fail → state: failed", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "lint", iteration: 0 }), seq: 1 },
      {
        ...ev("fact.node_completed", { nodeId: "lint", iteration: 0, outcomeStatus: "fail", nextNode: "done" }),
        seq: 2,
      },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes).toEqual([{ nodeId: "lint", iteration: 0, state: "failed", lastEventSeq: 2 }]);
  });

  test("node_completed without outcomeStatus → state: completed (back-compat)", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_completed", { nodeId: "plan", iteration: 0, nextNode: "implement" }), seq: 5 },
    ];
    expect(deriveNodeStates(events)).toEqual([{ nodeId: "plan", iteration: 0, state: "completed", lastEventSeq: 5 }]);
  });

  test("node_completed with outcomeStatus=success → state: completed", () => {
    const events: StoredEvent[] = [
      {
        ...ev("fact.node_completed", { nodeId: "verify", iteration: 0, outcomeStatus: "success", nextNode: "done" }),
        seq: 7,
      },
    ];
    expect(deriveNodeStates(events)[0]?.state).toBe("completed");
  });

  test("node_aborted → failed regardless of prior completed", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "x", iteration: 0, cause: "timeout" }), seq: 2 },
    ];
    expect(deriveNodeStates(events)[0]?.state).toBe("failed");
  });

  test("fan-out branches mid-flight project as running (dispatch_started, no completion yet)", () => {
    // The executor emits fact.dispatch_started per branch when a `parallel`
    // node fans out (no per-branch node_started/node_completed yet). The
    // read-plane must show each branch "running" so the UI glows them
    // concurrently — not pending/absent until they complete.
    const events: StoredEvent[] = [
      { ...ev("fact.dispatch_started", { nodeId: "review", iteration: 0, resumeOf: "fresh" }), seq: 1 },
      { ...ev("fact.fanout_started", { nodeId: "review", iteration: 0, branches: ["security", "quality"] }), seq: 2 },
      { ...ev("fact.dispatch_started", { nodeId: "security", iteration: 0, resumeOf: "fresh" }), seq: 3 },
      { ...ev("fact.dispatch_started", { nodeId: "quality", iteration: 0, resumeOf: "fresh" }), seq: 4 },
      // security finished; quality still in flight.
      { ...ev("fact.node_completed", { nodeId: "security", iteration: 0, nextNode: "synth" }), seq: 5 },
    ];
    const byId = new Map(deriveNodeStates(events).map((n) => [n.nodeId, n.state]));
    expect(byId.get("security")).toBe("completed");
    expect(byId.get("quality")).toBe("running"); // still in flight → glows
    expect(byId.get("review")).toBe("running"); // the parallel node is pinned-active
  });

  test("loop iterations produce one entry per (nodeId, iteration)", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "verify", iteration: 0 }), seq: 1 },
      {
        ...ev("fact.node_completed", { nodeId: "verify", iteration: 0, outcomeStatus: "fail", nextNode: "fix" }),
        seq: 2,
      },
      { ...ev("fact.node_started", { nodeId: "verify", iteration: 1 }), seq: 3 },
      {
        ...ev("fact.node_completed", { nodeId: "verify", iteration: 1, outcomeStatus: "success", nextNode: "done" }),
        seq: 4,
      },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes).toEqual([
      { nodeId: "verify", iteration: 0, state: "failed", lastEventSeq: 2 },
      { nodeId: "verify", iteration: 1, state: "completed", lastEventSeq: 4 },
    ]);
  });
});

describe("deriveSelectedEdges — edge.selected projection", () => {
  test("extracts (from, to, iteration) triples in event order", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "start", to: "lint", iteration: 0, rule: "outcome" }), seq: 1 },
      {
        ...ev("edge.selected", {
          from: "lint",
          to: "done",
          iteration: 0,
          rule: "outcome",
        }),
        seq: 2,
      },
    ];
    expect(deriveSelectedEdges(events)).toEqual([
      { from: "start", to: "lint", iteration: 0 },
      { from: "lint", to: "done", iteration: 0 },
    ]);
  });

  test("non-edge.selected events are ignored", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: "y", iteration: 0 }), seq: 2 },
      { ...ev("fact.run_halted", { reason: "error" }), seq: 3 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([{ from: "x", to: "y", iteration: 0 }]);
  });

  test("drops edge.selected with non-string from/to", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: 42, to: "y" }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: null }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([]);
  });

  test("back-edge re-traversals carry distinct iterations", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "verify", to: "fix", iteration: 0 }), seq: 1 },
      { ...ev("edge.selected", { from: "verify", to: "fix", iteration: 1 }), seq: 2 },
    ];
    const edges = deriveSelectedEdges(events);
    expect(edges).toHaveLength(2);
    expect(edges[0]?.iteration).toBe(0);
    expect(edges[1]?.iteration).toBe(1);
  });

  test("missing iteration on payload defaults to 0 (back-compat for older event logs)", () => {
    const events: StoredEvent[] = [{ ...ev("edge.selected", { from: "a", to: "b" }), seq: 1 }];
    expect(deriveSelectedEdges(events)).toEqual([{ from: "a", to: "b", iteration: 0 }]);
  });

  // The bug: the executor used to record edge.selected at edge-pick time,
  // before the §3.4 goal-gate check could override result.nextNode with
  // the gate's retry_target. Newer daemon suppresses these emissions at
  // source, but historical runs still carry the misleading event;
  // reconcile here by rewriting the selectedEdge to point at the actual
  // retarget destination. Rewrite (vs. drop) because GraphView counts
  // gate-outgoing selectedEdges to derive retarget firings — dropping
  // would silently undercount and dim the synthetic retarget edge.
  test("rewrites edge.selected to the retarget target when goal_gate.retarget overrides", () => {
    const events: StoredEvent[] = [
      // Failing gate "selected" the configured fail-edge to done...
      {
        ...ev("edge.selected", { from: "review", to: "done", iteration: 0, rule: "outcome" }),
        seq: 100,
      },
      // ...but goal-gate retargeted to audit instead — the edge above was never traversed.
      { ...ev("goal_gate.retarget", { failedGate: "review", target: "audit", retries: 1 }), seq: 101 },
      { ...ev("fact.node_completed", { nodeId: "review", iteration: 0 }), seq: 102 },
      // Second-attempt success does fire and IS retained verbatim.
      { ...ev("edge.selected", { from: "review", to: "propose_patch", iteration: 0, rule: "outcome" }), seq: 200 },
      { ...ev("fact.node_completed", { nodeId: "review", iteration: 0 }), seq: 201 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([
      // First entry rewritten: from review -> done to review -> audit
      // (the actual traversal). One entry per gate visit is preserved
      // so the synthetic retarget edge can count visits.
      { from: "review", to: "audit", iteration: 0 },
      { from: "review", to: "propose_patch", iteration: 0 },
    ]);
  });

  test("keeps edge.selected verbatim when goal_gate.retarget targets a different source node", () => {
    // A retarget on a different gate must not silently rewrite an
    // unrelated node's edge selection.
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "diff", to: "review", iteration: 0 }), seq: 1 },
      { ...ev("goal_gate.retarget", { failedGate: "review", target: "audit", retries: 1 }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([{ from: "diff", to: "review", iteration: 0 }]);
  });
});

describe("deriveNodeStates — run-halt terminal patching", () => {
  test("a node left in 'running' state when a fact.run_halted follows is marked 'failed'", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "implement", iteration: 0 }), seq: 1 },
      { ...ev("fact.run_halted", { reason: "error" }), seq: 2 },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.nodeId).toBe("implement");
    expect(nodes[0]?.state).toBe("failed");
    expect(nodes[0]?.lastEventSeq).toBe(2);
  });

  test("a node left in 'running' state when fact.run_cancelled follows is marked 'failed'", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "verify", iteration: 0 }), seq: 3 },
      { ...ev("fact.run_cancelled", { intentSeq: 7 }), seq: 4 },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes[0]?.state).toBe("failed");
    expect(nodes[0]?.lastEventSeq).toBe(4);
  });

  test("a node left in 'running' state when fact.run_quarantined follows is marked 'failed'", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "plan", iteration: 0 }), seq: 5 },
      { ...ev("fact.run_quarantined", { reason: "orphan_side_effect" }), seq: 6 },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes[0]?.state).toBe("failed");
    expect(nodes[0]?.lastEventSeq).toBe(6);
  });

  test("a node that already reached 'completed' before run-halt is not downgraded", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "lint", iteration: 0 }), seq: 1 },
      {
        ...ev("fact.node_completed", { nodeId: "lint", iteration: 0, outcomeStatus: "success", nextNode: "done" }),
        seq: 2,
      },
      { ...ev("fact.run_halted", { reason: "error" }), seq: 3 },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes[0]?.nodeId).toBe("lint");
    expect(nodes[0]?.state).toBe("completed");
    // lastEventSeq should still be the node_completed seq, not the halt seq
    expect(nodes[0]?.lastEventSeq).toBe(2);
  });

  test("a node that already reached 'failed' before run-halt is not changed", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "x", iteration: 0, cause: "timeout" }), seq: 2 },
      { ...ev("fact.run_halted", { reason: "aborted_exit" }), seq: 3 },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes[0]?.state).toBe("failed");
    // lastEventSeq should be the node_aborted seq, not the halt seq
    expect(nodes[0]?.lastEventSeq).toBe(2);
  });
});

describe("deriveNodeStates — active-pause patching", () => {
  test("a node aborted for a budget pause shows 'running' (suspended), not 'failed'", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "implement", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "implement", iteration: 0, cause: "budget_pause" }), seq: 2 },
      {
        ...ev("fact.run_paused", { reason: "budget", nodeId: "implement", scope: "run", metric: "cost" }),
        seq: 3,
      },
    ];
    const nodes = deriveNodeStates(events);
    expect(nodes[0]?.nodeId).toBe("implement");
    expect(nodes[0]?.state).toBe("running");
    expect(nodes[0]?.lastEventSeq).toBe(3);
  });

  test("a node resumed after the pause (later dispatch) is not forced back to running by the patch", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "implement", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "implement", iteration: 0, cause: "budget_pause" }), seq: 2 },
      { ...ev("fact.run_paused", { reason: "budget", nodeId: "implement" }), seq: 3 },
      { ...ev("fact.run_resumed", {}), seq: 4 },
      {
        ...ev("fact.node_completed", { nodeId: "implement", iteration: 0, outcomeStatus: "success", nextNode: "done" }),
        seq: 5,
      },
    ];
    // The pause is no longer the latest run-state fact, so the patch is inert;
    // the node's real terminal state (completed) stands.
    expect(deriveNodeStates(events)[0]?.state).toBe("completed");
  });

  test("a genuinely failed node is untouched when a later pause targets a different node", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "lint", iteration: 0 }), seq: 1 },
      { ...ev("fact.node_aborted", { nodeId: "lint", iteration: 0, cause: "timeout" }), seq: 2 },
      { ...ev("fact.node_started", { nodeId: "implement", iteration: 0 }), seq: 3 },
      { ...ev("fact.node_aborted", { nodeId: "implement", iteration: 0, cause: "budget_pause" }), seq: 4 },
      { ...ev("fact.run_paused", { reason: "budget", nodeId: "implement" }), seq: 5 },
    ];
    const byId = Object.fromEntries(deriveNodeStates(events).map((n) => [n.nodeId, n.state]));
    expect(byId["lint"]).toBe("failed");
    expect(byId["implement"]).toBe("running");
  });
});

describe("runStateToDetail — HITL projection", () => {
  function evWithSeq(seq: number, type: string, payload: Record<string, unknown>): StoredEvent {
    return { runId: "r1", seq, type, writer: "daemon", payload, ts: 1_000_000 + seq };
  }

  test("paused_human projects nodeId/text/routes from the latest fact.run_paused_human", () => {
    // Phase 7 of llm-routing.md changed the fact.run_paused_human
    // payload from { label, options } to { text, routes }. The
    // adapter still surfaces hitlLabel + hitlOptions to the web
    // (transitional shim until Phase 10 web cleanup renames the
    // fields) by mapping text -> hitlLabel and synthesising option
    // rows from each route string.
    const state = makeState({ status: "paused_human", currentNode: "review" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_started", { startNode: "start" }),
      evWithSeq(2, "fact.node_started", { nodeId: "review" }),
      evWithSeq(3, "fact.run_paused_human", {
        nodeId: "review",
        text: "Review the draft",
        routes: ["approve", "revise"],
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.runStatus).toBe("paused_human");
    expect(detail.hitlNodeId).toBe("review");
    expect(detail.hitlLabel).toBe("Review the draft");
    expect(detail.hitlOptions).toEqual(["approve", "revise"]);
    // No edge declared a label= override, so the labels map stays absent.
    expect(detail.hitlOptionLabels).toBeUndefined();
  });

  test("paused_human projects edge label= overrides into hitlOptionLabels", () => {
    const state = makeState({ status: "paused_human", currentNode: "review" });
    const events: StoredEvent[] = [
      evWithSeq(3, "fact.run_paused_human", {
        nodeId: "review",
        text: "Review the draft",
        routes: ["approve", "revise"],
        routeLabels: { approve: "Ship it", revise: "Request changes" },
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlOptions).toEqual(["approve", "revise"]);
    expect(detail.hitlOptionLabels).toEqual({ approve: "Ship it", revise: "Request changes" });
  });

  test("paused_human drops non-string label entries and omits an empty labels map", () => {
    const state = makeState({ status: "paused_human", currentNode: "review" });
    const events: StoredEvent[] = [
      evWithSeq(3, "fact.run_paused_human", {
        nodeId: "review",
        text: "Review the draft",
        routes: ["approve", "revise"],
        routeLabels: { approve: 42, revise: null },
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlOptionLabels).toBeUndefined();
  });

  test("paused_human with multiple paused events picks the latest one (re-yield after revise)", () => {
    const state = makeState({ status: "paused_human", currentNode: "review" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_human", { nodeId: "review", text: "first", routes: [] }),
      evWithSeq(2, "fact.run_resumed", { fromStatus: "paused_human" }),
      evWithSeq(3, "fact.run_paused_human", {
        nodeId: "review",
        text: "second iteration",
        routes: ["X"],
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlLabel).toBe("second iteration");
    expect(detail.hitlOptions?.[0]).toBe("X");
  });

  test("non-paused statuses leave HITL fields undefined", () => {
    const state = makeState({ status: "running" });
    const events: StoredEvent[] = [
      // A stale paused_human from earlier in the run shouldn't leak through
      // when the run has since resumed and is now running again.
      evWithSeq(1, "fact.run_paused_human", { nodeId: "review", text: "stale", routes: [] }),
      evWithSeq(2, "fact.run_resumed", { fromStatus: "paused_human" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.runStatus).toBe("running");
    expect(detail.hitlNodeId).toBeUndefined();
    expect(detail.hitlLabel).toBeUndefined();
    expect(detail.hitlOptions).toBeUndefined();
  });

  test("paused_human tolerates malformed payload (missing fields stay undefined)", () => {
    const state = makeState({ status: "paused_human" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_human", { nodeId: 42, text: null, routes: "not an array" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlNodeId).toBeUndefined();
    expect(detail.hitlLabel).toBeUndefined();
    expect(detail.hitlOptions).toBeUndefined();
  });

  test("derives hitlDecisions by pairing intent.human_input with the open gate (incl. note)", () => {
    const state = makeState({ status: "completed" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_human", { nodeId: "review", text: "Approve?", routes: ["approve", "revise"] }),
      evWithSeq(2, "intent.human_input", { route: "approve", note: "ship it" }),
      evWithSeq(3, "fact.run_resumed", { fromStatus: "paused_human" }),
      evWithSeq(4, "fact.run_completed", {}),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlDecisions).toEqual({ review: { route: "approve", note: "ship it" } });
  });

  test("records each answered gate and omits an absent note", () => {
    const state = makeState({ status: "running" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_human", { nodeId: "gateA", text: "?", routes: ["yes", "no"] }),
      evWithSeq(2, "intent.human_input", { route: "yes" }),
      evWithSeq(3, "fact.run_resumed", { fromStatus: "paused_human" }),
      evWithSeq(4, "fact.run_paused_human", { nodeId: "gateB", text: "?", routes: ["a", "b"] }),
      evWithSeq(5, "intent.human_input", { route: "b", note: "because" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlDecisions).toEqual({ gateA: { route: "yes" }, gateB: { route: "b", note: "because" } });
  });

  test("loop revisiting the same gate keeps the latest answer", () => {
    const state = makeState({ status: "completed" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_human", { nodeId: "review", text: "?", routes: ["approve", "revise"] }),
      evWithSeq(2, "intent.human_input", { route: "revise", note: "first pass" }),
      evWithSeq(3, "fact.run_resumed", { fromStatus: "paused_human" }),
      evWithSeq(4, "fact.run_paused_human", { nodeId: "review", text: "?", routes: ["approve", "revise"] }),
      evWithSeq(5, "intent.human_input", { route: "approve" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlDecisions).toEqual({ review: { route: "approve" } });
  });

  test("leaves hitlDecisions undefined when no human gate was answered", () => {
    const state = makeState({ status: "completed" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_started", { startNode: "a" }),
      // A human_input with no preceding open gate is ignored (defensive).
      evWithSeq(2, "intent.human_input", { route: "stray" }),
      evWithSeq(3, "fact.run_completed", {}),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlDecisions).toBeUndefined();
  });
});

describe("runStateToDetail \u2014 lastEventSeq", () => {
  function evWithSeq(seq: number, type: string, payload: Record<string, unknown> = {}): StoredEvent {
    return { runId: "r1", seq, type, writer: "daemon", payload, ts: 1_000_000 + seq };
  }

  // Regression: `lastEventSeq` is the SSE resume watermark + the
  // mergeDetail dedup cursor. Producing `state.lastAppliedSeq` (the
  // intent-fold cursor \u2014 only advanced via `advanceAppliedTo`) caused
  // the run-detail Graph view to show `\u00b7 \u00d7N` badges on edges that
  // fired exactly once, because SSE re-delivered events the snapshot
  // already covered and overlay-side dedup couldn't drop them.
  test("equals the seq of the latest event, not state.lastAppliedSeq", () => {
    const state = makeState({ lastAppliedSeq: 1 });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_started", { startNode: "start" }),
      evWithSeq(3, "edge.selected", { from: "start", to: "collect", iteration: 0 }),
      evWithSeq(69, "edge.selected", { from: "collect", to: "analyze", iteration: 0 }),
      evWithSeq(626, "edge.selected", { from: "analyze", to: "done", iteration: 0 }),
      evWithSeq(628, "fact.run_completed", { finalNode: "done" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.lastEventSeq).toBe(628);
  });

  test("falls back to 0 when the run has no events", () => {
    const state = makeState({ lastAppliedSeq: 7 });
    const detail = runStateToDetail(state, [], undefined, undefined);
    expect(detail.lastEventSeq).toBe(0);
  });
});

describe("runStateToDetail \u2014 worktreePath", () => {
  test("populates worktreePath when worktree directory exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fragua-runs-adapter-wt-"));
    try {
      const runId = "r-wt-1";
      const wt = join(cwd, ".fragua", "worktrees", runId);
      // First call: dir absent → worktreePath should stay undefined.
      const stateNoDir = makeState({ runId, cwd });
      const detailNoDir = runStateToDetail(stateNoDir, [], undefined, undefined);
      expect(detailNoDir.worktreePath).toBeUndefined();

      // Now create the canonical worktree dir and re-derive.
      await mkdir(wt, { recursive: true });
      const stateWithDir = makeState({ runId, cwd });
      const detailWithDir = runStateToDetail(stateWithDir, [], undefined, undefined);
      expect(detailWithDir.worktreePath).toBe(wt);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("omits worktreePath when state.cwd is null", () => {
    const state = makeState({ cwd: null });
    const detail = runStateToDetail(state, [], undefined, undefined);
    expect(detail.worktreePath).toBeUndefined();
  });
});
