// Unit tests for the Store → RunSummary adapter's title + input picking.
// The rest of the summary (status, metrics, timing) is exercised through
// the route tests; these cases focus on the fields that were missing
// until auto-title support landed.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, StoredEvent } from "@swarm/store";
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
    schemaVersion: 1,
    routing: {},
    metrics: {
      billedTokens: 0,
      totalCostUsd: 0,
      totalInputCostUsd: 0,
      totalOutputCostUsd: 0,
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
    branch: null,
    cwd: null,
    workflowName: null,
    workflowScope: null,
    workflowPath: null,
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

  test("input comes from routing.input when set", () => {
    const s = makeState({ routing: { input: "rename foo() to bar()" } });
    const summary = runStateToSummary(s, [], undefined);
    expect(summary.input).toBe("rename foo() to bar()");
  });

  test("missing / empty / non-string routing.input → summary.input undefined", () => {
    expect(runStateToSummary(makeState({ routing: {} }), [], undefined).input).toBeUndefined();
    expect(runStateToSummary(makeState({ routing: { input: "" } }), [], undefined).input).toBeUndefined();
    expect(runStateToSummary(makeState({ routing: { input: 42 } }), [], undefined).input).toBeUndefined();
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
    expect(nodes).toEqual([{ nodeId: "lint", state: "failed", lastEventSeq: 2 }]);
  });

  test("node_completed without outcomeStatus → state: completed (back-compat)", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_completed", { nodeId: "plan", iteration: 0, nextNode: "implement" }), seq: 5 },
    ];
    expect(deriveNodeStates(events)).toEqual([{ nodeId: "plan", state: "completed", lastEventSeq: 5 }]);
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
});

describe("deriveSelectedEdges — edge.selected projection", () => {
  test("extracts (from, to) pairs in event order", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "start", to: "lint", rule: "weight" }), seq: 1 },
      {
        ...ev("edge.selected", { from: "lint", to: "done", rule: "condition", matched_condition: "outcome=fail" }),
        seq: 2,
      },
    ];
    expect(deriveSelectedEdges(events)).toEqual([
      { from: "start", to: "lint" },
      { from: "lint", to: "done" },
    ]);
  });

  test("non-edge.selected events are ignored", () => {
    const events: StoredEvent[] = [
      { ...ev("fact.node_started", { nodeId: "x", iteration: 0 }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: "y" }), seq: 2 },
      { ...ev("fact.run_halted", { reason: "error" }), seq: 3 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([{ from: "x", to: "y" }]);
  });

  test("drops edge.selected with non-string from/to", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: 42, to: "y" }), seq: 1 },
      { ...ev("edge.selected", { from: "x", to: null }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toEqual([]);
  });

  test("duplicates are preserved — back-edge iterations matter", () => {
    const events: StoredEvent[] = [
      { ...ev("edge.selected", { from: "verify", to: "fix" }), seq: 1 },
      { ...ev("edge.selected", { from: "verify", to: "fix" }), seq: 2 },
    ];
    expect(deriveSelectedEdges(events)).toHaveLength(2);
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

describe("runStateToDetail — HITL projection", () => {
  function evWithSeq(seq: number, type: string, payload: Record<string, unknown>): StoredEvent {
    return { runId: "r1", seq, type, writer: "daemon", payload, ts: 1_000_000 + seq };
  }

  test("paused_hitl projects nodeId/label/options from the latest fact.run_paused_hitl", () => {
    const state = makeState({ status: "paused_hitl", currentNode: "review" });
    const options = [
      { key: "A", label: "[A] Approve", to: "publish" },
      { key: "R", label: "[R] Revise", to: "draft" },
    ];
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_started", { startNode: "start" }),
      evWithSeq(2, "fact.node_started", { nodeId: "review" }),
      evWithSeq(3, "fact.run_paused_hitl", {
        nodeId: "review",
        label: "Review the draft",
        options,
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.runStatus).toBe("paused_hitl");
    expect(detail.hitlNodeId).toBe("review");
    expect(detail.hitlLabel).toBe("Review the draft");
    expect(detail.hitlOptions).toEqual(options);
  });

  test("paused_hitl with multiple paused events picks the latest one (re-yield after revise)", () => {
    const state = makeState({ status: "paused_hitl", currentNode: "review" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_hitl", { nodeId: "review", label: "first", options: [] }),
      evWithSeq(2, "fact.run_resumed", { fromStatus: "paused_hitl" }),
      evWithSeq(3, "fact.run_paused_hitl", {
        nodeId: "review",
        label: "second iteration",
        options: [{ key: "X", label: "X", to: "n" }],
      }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlLabel).toBe("second iteration");
    expect(detail.hitlOptions?.[0]?.key).toBe("X");
  });

  test("non-paused statuses leave HITL fields undefined", () => {
    const state = makeState({ status: "running" });
    const events: StoredEvent[] = [
      // A stale paused_hitl from earlier in the run shouldn't leak through
      // when the run has since resumed and is now running again.
      evWithSeq(1, "fact.run_paused_hitl", { nodeId: "review", label: "stale", options: [] }),
      evWithSeq(2, "fact.run_resumed", { fromStatus: "paused_hitl" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.runStatus).toBe("running");
    expect(detail.hitlNodeId).toBeUndefined();
    expect(detail.hitlLabel).toBeUndefined();
    expect(detail.hitlOptions).toBeUndefined();
  });

  test("paused_hitl tolerates malformed payload (missing fields stay undefined)", () => {
    const state = makeState({ status: "paused_hitl" });
    const events: StoredEvent[] = [
      evWithSeq(1, "fact.run_paused_hitl", { nodeId: 42, label: null, options: "not an array" }),
    ];
    const detail = runStateToDetail(state, events, undefined, undefined);
    expect(detail.hitlNodeId).toBeUndefined();
    expect(detail.hitlLabel).toBeUndefined();
    expect(detail.hitlOptions).toBeUndefined();
  });
});

describe("runStateToDetail \u2014 worktreePath", () => {
  test("populates worktreePath when worktree directory exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "swarm-runs-adapter-wt-"));
    try {
      const runId = "r-wt-1";
      const wt = join(cwd, ".swarm", "worktrees", runId);
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
