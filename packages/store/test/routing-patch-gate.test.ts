// The routing-patch write gate: `appendFact` validates `opts.routingPatch`
// against the known routing-key vocabulary BEFORE the write transaction opens.
// An unknown key family or a wrong-typed value is rejected with a thrown
// `RoutingPatchError`, never spread into `run_state.routing` where a later typed
// read would silently degrade to a conservative default (wrong retry budget /
// loop cap) with no error and no audit signal.

import { describe, expect, test } from "bun:test";
import { RoutingPatchError } from "@fragua/core";
import type { FactEvent } from "../src/index.ts";
import { freshStore, seedRun } from "./helpers.ts";

async function startedRun(): Promise<{ store: ReturnType<typeof freshStore>; runId: string; version: number }> {
  const store = freshStore();
  const runId = await seedRun(store);
  const started: FactEvent = {
    type: "fact.run_started",
    payload: { workflowSha: "wf_sha_1", contractVersion: 1, startNode: "work", baseGitSha: "base", baseGitRef: "main" },
  };
  const version = store.appendFact(runId, [started], store.getState(runId)!.version).newVersion;
  return { store, runId, version };
}

const noop: FactEvent = {
  type: "fact.dispatch_started",
  payload: { nodeId: "work", iteration: 0, resumeOf: "fresh" },
};

describe("appendFact routing-patch gate", () => {
  test("accepts a well-formed patch across multiple key families", async () => {
    const { store, runId, version } = await startedRun();
    const patch = {
      "internal.retry_count.work": 2,
      "internal.auto_resume_at": 1_700_000_500_000,
      "budget_override.run.cost": 12.5,
      __budget_warned: ["run:cost"],
      max_loops_override: 7,
    };

    const res = store.appendFact(runId, [noop], version, { routingPatch: patch });

    const routing = store.getState(runId)!.routing;
    expect(routing["internal.retry_count.work"]).toBe(2);
    expect(routing["budget_override.run.cost"]).toBe(12.5);
    expect(routing["max_loops_override"]).toBe(7);
    expect(res.newVersion).toBe(version + 1);
  });

  test("rejects an unknown key family before any write", async () => {
    const { store, runId, version } = await startedRun();

    let thrown: unknown;
    try {
      store.appendFact(runId, [noop], version, { routingPatch: { "budget_override.run.bananas": 5 } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoutingPatchError);
    expect((thrown as RoutingPatchError).violation).toBe("unknown-family");

    // The write never landed: version unchanged, key absent from the projection.
    const state = store.getState(runId)!;
    expect(state.version).toBe(version);
    expect("budget_override.run.bananas" in state.routing).toBe(false);
  });

  test("rejects a wrong-typed value before any write", async () => {
    const { store, runId, version } = await startedRun();

    let thrown: unknown;
    try {
      store.appendFact(runId, [noop], version, { routingPatch: { "internal.retry_count.work": "lots" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoutingPatchError);
    expect((thrown as RoutingPatchError).violation).toBe("wrong-type");

    const state = store.getState(runId)!;
    expect(state.version).toBe(version);
    expect("internal.retry_count.work" in state.routing).toBe(false);
  });

  test("accepts an operator-notes patch (well-formed entries + the clear write)", async () => {
    const { store, runId, version } = await startedRun();
    const notes = [{ gateNodeId: "plan_gate", route: "revise", note: "use the v2 schema" }];

    const res = store.appendFact(runId, [noop], version, {
      routingPatch: { "internal.operator_notes": notes },
    });
    expect(store.getState(runId)!.routing["internal.operator_notes"]).toEqual(notes);

    // The consumption write is an empty list, not a delete — must also pass.
    store.appendFact(runId, [noop], res.newVersion, {
      routingPatch: { "internal.operator_notes": [] },
    });
    expect(store.getState(runId)!.routing["internal.operator_notes"]).toEqual([]);
  });

  test("rejects a malformed operator-notes entry", async () => {
    const { store, runId, version } = await startedRun();

    let thrown: unknown;
    try {
      store.appendFact(runId, [noop], version, {
        routingPatch: { "internal.operator_notes": [{ gateNodeId: "g", route: "r" }] },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RoutingPatchError);
    expect((thrown as RoutingPatchError).violation).toBe("wrong-type");
  });
});
