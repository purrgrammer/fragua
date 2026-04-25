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
    [{ type: "fact.run_paused_hitl", payload: { nodeId: "start", prompt: "wait" } }],
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
    r.store.appendIntent("rp2", { type: "intent.hitl_input", payload: { input: "answer" } });
    r.store.appendIntent("rp2", { type: "intent.cancel_requested", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("rp2")!.status).toBe("cancelled");
    r.store.close();
  });
});
