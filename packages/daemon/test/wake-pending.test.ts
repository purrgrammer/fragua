// wakePending — drives operator intents to a terminal/queued state on
// non-dispatching runs (paused_hitl + quarantined). Closes top.md #23.

import { describe, expect, test } from "bun:test";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

function startRun(r: ReturnType<typeof rig>, runId: string): void {
  enqueue(r, runId, "start");
  const s0 = r.store.getState(runId)!;
  r.store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: s0.workflowSha, schemaVersion: s0.schemaVersion, startNode: "start" },
      },
    ],
    s0.version,
  );
}

function pause(r: ReturnType<typeof rig>, runId: string): void {
  const s = r.store.getState(runId)!;
  r.store.appendFact(
    runId,
    [{ type: "fact.run_paused_hitl", payload: { nodeId: "start", label: "wait", options: [] } }],
    s.version,
  );
}

function quarantine(r: ReturnType<typeof rig>, runId: string, idempotencyKey: string): void {
  const s = r.store.getState(runId)!;
  r.store.appendFact(
    runId,
    [
      {
        type: "fact.side_effect_intent",
        payload: { nodeId: "start", iteration: 0, toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey },
      },
    ],
    s.version,
  );
  r.store.startupSweep();
}

describe("wakePending — cancel on non-dispatching runs", () => {
  test("intent.cancel_requested on a paused_hitl run → fact.run_cancelled, status=cancelled", async () => {
    const r = rig();
    startRun(r, "rwc1");
    pause(r, "rwc1");
    expect(r.store.getState("rwc1")!.status).toBe("paused_hitl");

    r.store.appendIntent("rwc1", { type: "intent.cancel_requested", payload: { reason: "operator stop" } });
    const result = wakePending(r.store);
    expect(result.cancelled).toContain("rwc1");
    expect(r.store.getState("rwc1")!.status).toBe("cancelled");
    const types = r.store.getEvents("rwc1").map((e) => e.type);
    expect(types).toContain("fact.run_cancelled");
    r.store.close();
  });

  test("intent.cancel_requested on a quarantined run → fact.run_cancelled", async () => {
    const r = rig();
    startRun(r, "rwc2");
    quarantine(r, "rwc2", "ik-x");
    expect(r.store.getState("rwc2")!.status).toBe("quarantined");

    r.store.appendIntent("rwc2", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("rwc2")!.status).toBe("cancelled");
    r.store.close();
  });

  test("cancel filed while running survives a crash-induced quarantine sweep", async () => {
    // SPEC §3.5 + intent-fold R1: cancel beats every other intent. The
    // path: operator cancels a running run, daemon crashes mid-handler
    // before the executor's fold runs, a fresh daemon's startup sweep
    // sees an orphan side-effect-intent and quarantines the run, then
    // wakePending runs. The cancel must terminate the run — not stay
    // buried under a watermark advance.
    const r = rig();
    startRun(r, "rwcq");
    const s = r.store.getState("rwcq")!;
    r.store.appendFact(
      "rwcq",
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "start",
            iteration: 0,
            toolName: "charge",
            argsHash: "h",
            attempt: 1,
            idempotencyKey: "ik-q1",
          },
        },
      ],
      s.version,
    );
    // Operator cancels BEFORE the sweep runs.
    r.store.appendIntent("rwcq", { type: "intent.cancel_requested", payload: {} });
    r.store.startupSweep();
    expect(r.store.getState("rwcq")!.status).toBe("quarantined");

    const result = wakePending(r.store);
    expect(result.cancelled).toContain("rwcq");
    expect(r.store.getState("rwcq")!.status).toBe("cancelled");
    r.store.close();
  });

  test("idempotent across multiple calls", async () => {
    const r = rig();
    startRun(r, "rwc3");
    pause(r, "rwc3");
    r.store.appendIntent("rwc3", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    const first = wakePending(r.store);
    expect(first.cancelled).toEqual([]);
    expect(r.store.getState("rwc3")!.status).toBe("cancelled");
    r.store.close();
  });
});

describe("wakePending — unquarantine resolutions", () => {
  test("resolution=cancel → fact.run_cancelled", async () => {
    const r = rig();
    startRun(r, "ruq1");
    quarantine(r, "ruq1", "ik-1");
    r.store.appendIntent("ruq1", {
      type: "intent.unquarantine",
      payload: { resolution: "cancel", note: "abort" },
    });
    const result = wakePending(r.store);
    expect(result.unquarantined).toContain("ruq1");
    expect(r.store.getState("ruq1")!.status).toBe("cancelled");
    r.store.close();
  });

  test("resolution=retry → fact.run_resumed, status=queued", async () => {
    const r = rig();
    startRun(r, "ruq2");
    quarantine(r, "ruq2", "ik-2");
    r.store.appendIntent("ruq2", {
      type: "intent.unquarantine",
      payload: { resolution: "retry", note: "try again" },
    });
    const result = wakePending(r.store);
    expect(result.unquarantined).toContain("ruq2");
    expect(r.store.getState("ruq2")!.status).toBe("queued");
    const types = r.store.getEvents("ruq2").map((e) => e.type);
    expect(types).toContain("fact.run_resumed");
    expect(types).not.toContain("fact.side_effect_done"); // no synthesis on retry
    r.store.close();
  });

  test("resolution=treat_as_done synthesises fact.side_effect_done for each orphan", async () => {
    const r = rig();
    startRun(r, "ruq3");
    // Two orphan intents — operator says both already happened.
    quarantine(r, "ruq3", "ik-A");
    // Append a second orphan after the run is already quarantined. Direct
    // appendFact bypasses status guards which is fine for this fixture.
    const s = r.store.getState("ruq3")!;
    r.store.appendFact(
      "ruq3",
      [
        {
          type: "fact.side_effect_intent",
          payload: {
            nodeId: "start",
            iteration: 0,
            toolName: "ship",
            argsHash: "h2",
            attempt: 1,
            idempotencyKey: "ik-B",
          },
        },
      ],
      s.version,
    );
    r.store.appendIntent("ruq3", {
      type: "intent.unquarantine",
      payload: { resolution: "treat_as_done", note: "verified by hand" },
    });
    wakePending(r.store);
    expect(r.store.getState("ruq3")!.status).toBe("queued");

    const events = r.store.getEvents("ruq3");
    const dones = events.filter((e) => e.type === "fact.side_effect_done");
    const doneKeys = new Set(dones.map((e) => (e.payload as { idempotencyKey: string }).idempotencyKey));
    expect(doneKeys.has("ik-A")).toBe(true);
    expect(doneKeys.has("ik-B")).toBe(true);

    // The original orphans + their synthesised dones now match by key,
    // so a follow-up startup sweep finds no orphans.
    const sweep = r.store.startupSweep();
    expect(sweep.quarantined).not.toContain("ruq3");
    r.store.close();
  });

  test("malformed resolution is skipped (no fact emitted, run stays quarantined)", async () => {
    const r = rig();
    startRun(r, "ruq4");
    quarantine(r, "ruq4", "ik-4");
    r.store.appendIntent("ruq4", {
      type: "intent.unquarantine",
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
      payload: { resolution: "yolo" as any, note: "" },
    });
    const result = wakePending(r.store);
    expect(result.unquarantined).toEqual([]);
    expect(r.store.getState("ruq4")!.status).toBe("quarantined");
    r.store.close();
  });
});

describe("wakePending — precedence", () => {
  test("cancel runs before unquarantine: a quarantined run with both ends cancelled", async () => {
    const r = rig();
    startRun(r, "rp1");
    quarantine(r, "rp1", "ik-9");
    r.store.appendIntent("rp1", {
      type: "intent.unquarantine",
      payload: { resolution: "retry", note: "" },
    });
    r.store.appendIntent("rp1", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("rp1")!.status).toBe("cancelled");
    r.store.close();
  });

  test("cancel runs before hitl: a paused_hitl run with both ends cancelled (not resumed)", async () => {
    const r = rig();
    startRun(r, "rp2");
    pause(r, "rp2");
    r.store.appendIntent("rp2", { type: "intent.hitl_input", payload: { selected: "A" } });
    r.store.appendIntent("rp2", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("rp2")!.status).toBe("cancelled");
    r.store.close();
  });
});

describe("wakePending — resume on paused (payment_required)", () => {
  function pauseProvider(r: ReturnType<typeof rig>, runId: string): void {
    const s = r.store.getState(runId)!;
    r.store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "payment_required",
            nodeId: "start",
            provider: "anthropic",
            errorMessage: "Insufficient balance",
          },
        },
      ],
      s.version,
    );
  }

  test("intent.resume → fact.run_resumed, status=queued", async () => {
    const r = rig();
    startRun(r, "rr1");
    pauseProvider(r, "rr1");
    expect(r.store.getState("rr1")!.status).toBe("paused");
    r.store.appendIntent("rr1", { type: "intent.resume", payload: {} });
    const result = wakePending(r.store);
    expect(result.resumed).toContain("rr1");
    expect(r.store.getState("rr1")!.status).toBe("queued");
    const lastFact = r.store
      .getEvents("rr1")
      .filter((e) => e.type === "fact.run_resumed")
      .pop();
    expect(lastFact).toBeDefined();
    const p = lastFact!.payload as { fromStatus: string };
    expect(p.fromStatus).toBe("paused");
    r.store.close();
  });

  test("intent.resume on a paused_hitl run also resumes (generic verb)", async () => {
    const r = rig();
    startRun(r, "rr2");
    pause(r, "rr2");
    r.store.appendIntent("rr2", { type: "intent.resume", payload: { note: "manual unstick" } });
    const result = wakePending(r.store);
    expect(result.resumed).toContain("rr2");
    expect(r.store.getState("rr2")!.status).toBe("queued");
    r.store.close();
  });

  test("intent.cancel_requested on paused → cancelled (cancel beats resume)", async () => {
    const r = rig();
    startRun(r, "rr3");
    pauseProvider(r, "rr3");
    r.store.appendIntent("rr3", { type: "intent.resume", payload: {} });
    r.store.appendIntent("rr3", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("rr3")!.status).toBe("cancelled");
    r.store.close();
  });

  test("idempotent: re-running wakePending without a new intent is a no-op", async () => {
    const r = rig();
    startRun(r, "rr4");
    pauseProvider(r, "rr4");
    r.store.appendIntent("rr4", { type: "intent.resume", payload: {} });
    const first = wakePending(r.store);
    expect(first.resumed).toContain("rr4");
    const second = wakePending(r.store);
    expect(second.resumed).not.toContain("rr4");
    r.store.close();
  });
});

describe("wakePending — paused_auto auto-resume (provider_retry)", () => {
  function pauseProviderAutoRetry(r: ReturnType<typeof rig>, runId: string, resumeAt: number): void {
    const s = r.store.getState(runId)!;
    r.store.appendFact(
      runId,
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "provider_retry",
            nodeId: "start",
            httpStatus: 429,
            provider: "stub",
            errorMessage: "rate limited",
            attempt: 1,
            resumeAt,
          },
        },
      ],
      s.version,
      { routingPatch: { "internal.auto_resume_at": resumeAt } },
    );
  }

  test("auto_resume_at in the past → fact.run_resumed, status=queued, fromStatus=paused_auto", async () => {
    const r = rig();
    startRun(r, "rpa1");
    pauseProviderAutoRetry(r, "rpa1", Date.now() - 1000);
    expect(r.store.getState("rpa1")!.status).toBe("paused_auto");
    const result = wakePending(r.store);
    expect(result.retryResumed).toContain("rpa1");
    expect(r.store.getState("rpa1")!.status).toBe("queued");
    const lastFact = r.store
      .getEvents("rpa1")
      .filter((e) => e.type === "fact.run_resumed")
      .pop();
    expect(lastFact).toBeDefined();
    expect((lastFact!.payload as { fromStatus: string }).fromStatus).toBe("paused_auto");
    r.store.close();
  });

  test("auto_resume_at in the future → no resume yet", async () => {
    const r = rig();
    startRun(r, "rpa2");
    pauseProviderAutoRetry(r, "rpa2", Date.now() + 60_000);
    const result = wakePending(r.store);
    expect(result.retryResumed).not.toContain("rpa2");
    expect(r.store.getState("rpa2")!.status).toBe("paused_auto");
    r.store.close();
  });

  test("intent.resume on paused_auto also wakes (manual escape hatch)", async () => {
    const r = rig();
    startRun(r, "rpa3");
    pauseProviderAutoRetry(r, "rpa3", Date.now() + 60_000);
    r.store.appendIntent("rpa3", { type: "intent.resume", payload: {} });
    const result = wakePending(r.store);
    expect(result.resumed).toContain("rpa3");
    expect(r.store.getState("rpa3")!.status).toBe("queued");
    r.store.close();
  });
});

describe("wakePending — running_children convergence (P2.3)", () => {
  function startFanout(
    r: ReturnType<typeof rig>,
    parentId: string,
    parentNodeId: string,
    childIds: string[],
    fanInNode: string,
  ): void {
    enqueue(r, parentId, "start");
    const s0 = r.store.getState(parentId)!;
    r.store.appendFact(
      parentId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, schemaVersion: s0.schemaVersion, startNode: parentNodeId },
        },
      ],
      s0.version,
    );
    for (let i = 0; i < childIds.length; i++) {
      r.store.enqueueRun({
        runId: childIds[i]!,
        workflowSha: r.workflowSha,
        parentRunId: parentId,
        parentNodeId,
        parallelIndex: i,
        subgraphRootNodeId: `branch_${i}`,
        subgraphTerminalNodeId: fanInNode,
      });
    }
    const s1 = r.store.getState(parentId)!;
    r.store.appendFact(
      parentId,
      [
        {
          type: "fact.fanout_started",
          payload: { parentNodeId, childRunIds: childIds, fanInNode },
        },
      ],
      s1.version,
      {
        routingPatch: {
          [`parallel.${parentNodeId}.sub_run_ids`]: childIds,
          [`parallel.${parentNodeId}.fan_in_node`]: fanInNode,
          [`parallel.${parentNodeId}.join_policy`]: "wait_all",
        },
      },
    );
    expect(r.store.getState(parentId)!.status).toBe("running_children");
  }

  function forceChildTerminal(r: ReturnType<typeof rig>, childId: string, status: string): void {
    const db = (r.store as unknown as { db: { query: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET status = ?, updated_at = updated_at + 1 WHERE run_id = ?").run(status, childId);
  }

  test("parent transitions to queued when every sub-run reaches terminal", () => {
    const r = rig();
    startFanout(r, "p1", "fanout", ["p1_c0", "p1_c1"], "fan_in");
    forceChildTerminal(r, "p1_c0", "completed");
    forceChildTerminal(r, "p1_c1", "completed");

    r.store.addMetricsDelta("p1_c0", { totalCostUsd: 0.5, billedTokens: 100 });
    r.store.addMetricsDelta("p1_c1", { totalCostUsd: 0.25, billedTokens: 50 });

    const result = wakePending(r.store);
    expect(result.fanoutConverged).toContain("p1");
    const parent = r.store.getState("p1")!;
    expect(parent.status).toBe("queued");
    // Cost rolled into the parent's projection via fact.subrun_completed.
    expect(parent.metrics.totalCostUsd).toBeCloseTo(0.75);
    expect(parent.metrics.billedTokens).toBe(150);

    const types = r.store
      .getEvents("p1")
      .map((e) => e.type)
      .filter((t) => t.startsWith("fact.subrun") || t === "fact.fanout_completed");
    expect(types.filter((t) => t === "fact.subrun_completed")).toHaveLength(2);
    expect(types).toContain("fact.fanout_completed");
    r.store.close();
  });

  test("parent stays in running_children while any sub-run is still active", () => {
    const r = rig();
    startFanout(r, "p2", "fanout", ["p2_c0", "p2_c1"], "fan_in");
    // Leave both children queued (non-terminal).
    const result = wakePending(r.store);
    expect(result.fanoutConverged).not.toContain("p2");
    expect(r.store.getState("p2")!.status).toBe("running_children");
    r.store.close();
  });

  test("parent stays in running_children while any sub-run is quarantined", () => {
    const r = rig();
    startFanout(r, "pq", "fanout", ["pq_c0", "pq_c1"], "fan_in");
    forceChildTerminal(r, "pq_c0", "completed");
    forceChildTerminal(r, "pq_c1", "quarantined");

    const result = wakePending(r.store);
    expect(result.fanoutConverged).not.toContain("pq");
    expect(r.store.getState("pq")!.status).toBe("running_children");
    expect(r.store.activeChildRuns("pq")).toContain("pq_c1");
    r.store.close();
  });

  test("cancelled sub-runs converge to fanout_completed with finalStatus=cancelled", () => {
    const r = rig();
    startFanout(r, "p3", "fanout", ["p3_c0", "p3_c1"], "fan_in");
    forceChildTerminal(r, "p3_c0", "completed");
    forceChildTerminal(r, "p3_c1", "cancelled");

    wakePending(r.store);
    const fanoutCompleted = r.store.getEvents("p3").find((e) => e.type === "fact.fanout_completed");
    expect(fanoutCompleted).toBeDefined();
    const outcomes = (fanoutCompleted!.payload as { outcomes: Array<{ finalStatus: string }> }).outcomes;
    expect(outcomes.map((o) => o.finalStatus).sort()).toEqual(["cancelled", "completed"]);
    r.store.close();
  });

  test("mixed-terminal scenario emits subrun_completed in subRunIds order", () => {
    const r = rig();
    startFanout(r, "p4", "fanout", ["p4_c0", "p4_c1", "p4_c2"], "fan_in");
    forceChildTerminal(r, "p4_c0", "halted");
    forceChildTerminal(r, "p4_c1", "completed");
    forceChildTerminal(r, "p4_c2", "completed");

    wakePending(r.store);
    const subrunFacts = r.store.getEvents("p4").filter((e) => e.type === "fact.subrun_completed");
    expect(subrunFacts.map((e) => (e.payload as { parallelIndex: number }).parallelIndex)).toEqual([0, 1, 2]);
    r.store.close();
  });

  test("subrun_completed carries child routing score for fan_in ranking", () => {
    const r = rig();
    startFanout(r, "ps", "fanout", ["ps_c0", "ps_c1"], "fan_in");
    forceChildTerminal(r, "ps_c0", "completed");
    forceChildTerminal(r, "ps_c1", "completed");
    const db = (r.store as unknown as { db: { query: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
    db.query("UPDATE run_state SET routing = json_set(routing, '$.score', ?) WHERE run_id = ?").run(0.87, "ps_c1");

    wakePending(r.store);
    const subrunFacts = r.store.getEvents("ps").filter((e) => e.type === "fact.subrun_completed");
    const scored = subrunFacts.find((e) => (e.payload as { subRunId?: string }).subRunId === "ps_c1");
    expect((scored!.payload as { fanInScore?: number }).fanInScore).toBe(0.87);
    r.store.close();
  });

  test("first_success: one winner triggers intent.cancel_requested on siblings (P4)", () => {
    const r = rig();
    startFanout(r, "p5", "fanout", ["p5_c0", "p5_c1", "p5_c2"], "fan_in");
    // Mark the parent's join policy as first_success.
    const parent = r.store.getState("p5")!;
    r.store.appendFact(
      "p5",
      [
        {
          type: "fact.intents_folded",
          payload: { intentSeq: 0, folded: "0" },
        },
      ],
      parent.version,
      { routingPatch: { "parallel.fanout.join_policy": "first_success" } },
    );
    // c0 wins.
    forceChildTerminal(r, "p5_c0", "completed");
    wakePending(r.store);

    const sibCancel = (id: string) => r.store.getEvents(id).some((e) => e.type === "intent.cancel_requested");
    expect(sibCancel("p5_c1")).toBe(true);
    expect(sibCancel("p5_c2")).toBe(true);
    // Winner is already terminal — no cancel on it.
    expect(sibCancel("p5_c0")).toBe(false);
    r.store.close();
  });

  test("first_success: no winner → no sibling cancels", () => {
    const r = rig();
    startFanout(r, "p6", "fanout", ["p6_c0", "p6_c1"], "fan_in");
    const parent = r.store.getState("p6")!;
    r.store.appendFact(
      "p6",
      [{ type: "fact.intents_folded", payload: { intentSeq: 0, folded: "0" } }],
      parent.version,
      { routingPatch: { "parallel.fanout.join_policy": "first_success" } },
    );
    // Both still active — no winner.
    wakePending(r.store);
    expect(r.store.getEvents("p6_c0").some((e) => e.type === "intent.cancel_requested")).toBe(false);
    expect(r.store.getEvents("p6_c1").some((e) => e.type === "intent.cancel_requested")).toBe(false);
    r.store.close();
  });
});
