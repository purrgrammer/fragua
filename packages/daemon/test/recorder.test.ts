// CommittingRecorder's OCC retry: a stale version token is benign when a
// fan-out sibling moved it (retry the append, never the side effect), but the
// throw is the FENCE when the run left `running` — a zombie handler that
// ignored its abort must not land side-effect facts after a terminal.

import { describe, expect, test } from "bun:test";
import { ConcurrencyError } from "@fragua/store";
import { CommittingRecorder } from "../src/recorder.ts";
import { enqueue, rig } from "./helpers.ts";
import { dispositionType } from "./invariants.ts";

function startedRun(r: ReturnType<typeof rig>, runId: string): number {
  enqueue(r, runId, "start");
  const s0 = r.store.getState(runId)!;
  r.store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "start" },
      },
    ],
    s0.version,
  );
  return r.store.getState(runId)!.version;
}

describe("CommittingRecorder OCC retry", () => {
  test("a sibling-moved version on a RUNNING run retries the append and lands", () => {
    const r = rig();
    const v = startedRun(r, "rec1");
    const recorder = new CommittingRecorder({
      store: r.store,
      runId: "rec1",
      nodeId: "start",
      iteration: 0,
      initialVersion: v,
    });
    // A concurrent sibling commit moves the version under the recorder.
    r.store.appendFact(
      "rec1",
      [{ type: "fact.dispatch_started", payload: { nodeId: "start", iteration: 0, resumeOf: "fresh" } }],
      v,
    );

    recorder.recordIntent({ toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey: "ik-1" });
    expect(r.store.getEvents("rec1").map((e) => e.type)).toContain("fact.side_effect_intent");
    r.store.close();
  });

  test("a run that left `running` fences the retry — no side-effect fact lands after the terminal", () => {
    const r = rig();
    const v = startedRun(r, "rec2");
    const recorder = new CommittingRecorder({
      store: r.store,
      runId: "rec2",
      nodeId: "start",
      iteration: 0,
      initialVersion: v,
    });
    // The run halts while the (zombie) handler is still executing.
    r.store.appendFact(
      "rec2",
      [{ type: "fact.run_terminated", payload: { status: "errored", reason: "error", detail: "leak" } }],
      v,
    );

    expect(() =>
      recorder.recordIntent({ toolName: "charge", argsHash: "h", attempt: 1, idempotencyKey: "ik-2" }),
    ).toThrow(ConcurrencyError);
    // The event log gains nothing after the terminal fact.
    const types = r.store.getEvents("rec2").map(dispositionType);
    expect(types).not.toContain("fact.side_effect_intent");
    expect(types.at(-1)).toBe("fact.run_halted");
    r.store.close();
  });
});
