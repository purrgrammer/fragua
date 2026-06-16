// Read-plane projection of the run-level `outputs:` block (proposal §11.3),
// exercised end-to-end through a real SqliteStore: the typed-partial envelope,
// spill rehydration, latest-iteration resolution, and parallel-branch refs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { newRunId, SqliteStore } from "@fragua/store";
import { CURRENT_IR_VERSION, serializeGraph } from "../../src/ir.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

const WF_SOURCE = [
  "name: rl-outputs",
  "outputs:",
  "  verdict: { from: review.verdict }",
  "  findings: { from: review.findings }",
  "  total: { from: review.scores.total }",
  "  scan: { from: scan.status }",
  "steps:",
  "  review:",
  "    type: llm",
  "    prompt: Review.",
  "    outputs:",
  "      verdict: { type: string }",
  "      findings: { type: array, items: { type: string } }",
  "      scores: { type: object, fields: { total: { type: number } } }",
  "    next: exit",
].join("\n");

const WF_SHA = "rl-wf-sha";

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(WF_SHA, "rl-outputs", WF_SOURCE, serializeGraph(parseWorkflow(WF_SOURCE)), CURRENT_IR_VERSION);
});

afterEach(() => {
  store.close();
});

/** Enqueue + start a run; return its id. */
function startRun(runId: string): void {
  store.enqueueRun({ runId, workflowSha: WF_SHA, cwd: "/tmp/repo" });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: WF_SHA, contractVersion: s0.contractVersion, startNode: "review" },
      },
    ],
    s0.version,
  );
}

function nodeCompleted(runId: string, nodeId: string, iteration: number, outputs: Record<string, unknown>): void {
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.node_completed", payload: { nodeId, iteration, tokens: 0, costUsd: 0, nextNode: "exit", outputs } }],
    s.version,
  );
}

function complete(runId: string): void {
  const s = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "review" } }], s.version);
}

describe("RunDetail.outputs projection", () => {
  test("present: a completed run projects the declared fields from the producer's struct", () => {
    const runId = "r-present";
    startRun(runId);
    nodeCompleted(runId, "review", 0, { verdict: "PASS", findings: ["a", "b"], scores: { total: 7 } });
    complete(runId);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    expect(detail.outputs).toEqual({ verdict: "PASS", findings: ["a", "b"], total: 7 });
    // `scan` (from a node that never ran) is absent — its key is omitted.
    expect(detail.outputs).not.toHaveProperty("scan");
  });

  test("absent: a declared output whose producer never ran is omitted", () => {
    const runId = "r-absent";
    startRun(runId);
    // review never completes; the run still reaches a completing terminal.
    complete(runId);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    // Completed run → envelope present, but every producer absent → empty.
    expect(detail.outputs).toEqual({});
  });

  test("only completed runs carry an envelope; a halted run has no outputs", () => {
    const runId = "r-halted";
    startRun(runId);
    nodeCompleted(runId, "review", 0, { verdict: "PASS", findings: [], scores: { total: 1 } });
    const s = store.getState(runId)!;
    store.appendFact(runId, [{ type: "fact.run_halted", payload: { reason: "aborted_exit" } }], s.version);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    expect(detail.outputs).toBeUndefined();
  });

  test("spilled: a >3KB producer struct rehydrates from the blob CAS and projects", () => {
    const runId = "r-spilled";
    startRun(runId);
    const big = Array.from({ length: 400 }, (_, i) => `finding-${i}-${"x".repeat(8)}`);
    nodeCompleted(runId, "review", 0, { verdict: "PASS", findings: big, scores: { total: 3 } });
    complete(runId);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    expect(detail.outputs?.["findings"]).toEqual(big);
    expect(detail.outputs?.["verdict"]).toBe("PASS");
  });

  test("looped-latest: a producer that emitted twice resolves to its latest iteration", () => {
    const runId = "r-looped";
    startRun(runId);
    nodeCompleted(runId, "review", 0, { verdict: "FAIL", findings: ["old"], scores: { total: 1 } });
    nodeCompleted(runId, "review", 1, { verdict: "PASS", findings: ["new"], scores: { total: 9 } });
    complete(runId);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    expect(detail.outputs).toEqual({ verdict: "PASS", findings: ["new"], total: 9 });
  });

  test("parallel branch terminal is referenced directly by nodeId", () => {
    const branchSource = [
      "name: rl-branches",
      "outputs:",
      "  a: { from: scan_a.findings }",
      "  b: { from: scan_b.findings }",
      "steps:",
      "  fan:",
      "    type: parallel",
      "    branches: [scan_a, scan_b]",
      "    next: join",
      "  scan_a:",
      "    type: llm",
      "    prompt: A.",
      "    allowed-tools: [read]",
      "    outputs: { findings: { type: array, items: { type: string } } }",
      "    next: join",
      "  scan_b:",
      "    type: llm",
      "    prompt: B.",
      "    allowed-tools: [read]",
      "    outputs: { findings: { type: array, items: { type: string } } }",
      "    next: join",
      "  join:",
      "    type: llm",
      "    prompt: Join.",
      "    next: exit",
    ].join("\n");
    const sha = "rl-branch-sha";
    store.saveWorkflow(
      sha,
      "rl-branches",
      branchSource,
      serializeGraph(parseWorkflow(branchSource)),
      CURRENT_IR_VERSION,
    );

    const runId = "r-parallel";
    store.enqueueRun({ runId, workflowSha: sha, cwd: "/tmp/repo" });
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: sha, contractVersion: s0.contractVersion, startNode: "fan" },
        },
      ],
      s0.version,
    );
    nodeCompleted(runId, "scan_a", 0, { findings: ["a1"] });
    nodeCompleted(runId, "scan_b", 0, { findings: ["b1"] });
    const sc = store.getState(runId)!;
    store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "join" } }], sc.version);

    const detail = makeReadPlane({ store }).runDetail(runId)!;
    expect(detail.outputs).toEqual({ a: ["a1"], b: ["b1"] });
  });

  test("a completed run's run-level outputs re-derive after export → import", () => {
    // Bundle import shape-gates the run id as a ULID and the workflow sha as a
    // sha256, so this run uses both real-shaped ids.
    const sha = "a".repeat(64);
    store.saveWorkflow(sha, "rl-outputs", WF_SOURCE, serializeGraph(parseWorkflow(WF_SOURCE)), CURRENT_IR_VERSION);
    const runId = newRunId();
    store.enqueueRun({ runId, workflowSha: sha, cwd: "/tmp/repo" });
    const s0 = store.getState(runId)!;
    store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: sha, contractVersion: s0.contractVersion, startNode: "review" },
        },
      ],
      s0.version,
    );
    nodeCompleted(runId, "review", 0, { verdict: "PASS", findings: ["x"], scores: { total: 5 } });
    complete(runId);

    const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });

    // Import into a fresh store: the bundle carries the workflow IR (with the
    // run-level `outputs:` block) and rebuilds the outputs index from the
    // node_completed facts, so the read-plane projection re-derives for free.
    const target = new SqliteStore({ path: ":memory:" });
    try {
      target.importRunBundle(bytes);
      const detail = makeReadPlane({ store: target }).runDetail(runId)!;
      expect(detail.outputs).toEqual({ verdict: "PASS", findings: ["x"], total: 5 });
    } finally {
      target.close();
    }
  });
});
