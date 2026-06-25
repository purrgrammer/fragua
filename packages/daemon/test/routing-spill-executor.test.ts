// Tests for spilled routing.inputs resolution in executor paths:
//   (b-daemon) materializeRouting round-trips via the store
//   (c)        ${{ inputs.x }} substitution resolves the full spilled value
//   (extra)    buildSubstitutionArgs drops un-materialized BlobRef (contract note)
import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import {
  isBlobRef,
  makeBlobRef,
  materializeRouting,
  newRunId,
  PER_VALUE_SPILL_BYTES,
  SqliteStore,
} from "@fragua/store";
import { buildSubstitutionArgs, readInputMap } from "../src/executor-helpers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function freshDaemonStore(): SqliteStore {
  const store = new SqliteStore({ path: ":memory:" });
  const src = "name: t\nsteps:\n  start: {type: llm, prompt: hi}\n";
  const ir = serializeGraph(parseWorkflow(src));
  store.saveWorkflow("wf", "t", src, ir, CURRENT_IR_VERSION);
  return store;
}

function enqueueRun(store: SqliteStore, runId: string, initialRouting: Record<string, unknown>): void {
  store.enqueueRun({ runId, workflowSha: "wf", initialRouting });
}

function makeGetBlob(store: SqliteStore) {
  return (sha: string): Uint8Array => {
    const bytes = store.readBlob(sha);
    if (bytes == null) throw new Error(`routing blob missing: ${sha}`);
    return bytes;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// (c) Substitution: spilled input resolves so ${{ inputs.x }} gets full value
// ─────────────────────────────────────────────────────────────────────────────

describe("spilled routing.inputs — executor substitution", () => {
  test("(c) materializeRouting → buildSubstitutionArgs yields full original value", () => {
    const store = freshDaemonStore();
    const runId = newRunId();
    const bigValue = `BIGVAL:${"x".repeat(PER_VALUE_SPILL_BYTES + 100)}`;

    enqueueRun(store, runId, { inputs: { brief: bigValue } });

    const state = store.getState(runId)!;

    // routing.inputs.brief must be a BlobRef at this point
    const rawInputs = state.routing["inputs"] as Record<string, unknown>;
    expect(isBlobRef(rawInputs["brief"])).toBe(true);

    // Materialize — simulates what the executor does before buildSubstitutionArgs
    const materialized = materializeRouting(state.routing, makeGetBlob(store));
    const args = buildSubstitutionArgs(materialized, [{ name: "brief", type: "string", required: true }]);

    // The full original value must be in args
    expect(args.inputs).toBeDefined();
    expect(args.inputs!["brief"]).toBe(bigValue);

    store.close();
  });

  test("(c) multiple spilled inputs all resolve correctly", () => {
    const store = freshDaemonStore();
    const runId = newRunId();
    const val1 = `first:${"a".repeat(PER_VALUE_SPILL_BYTES + 50)}`;
    const val2 = `second:${"b".repeat(PER_VALUE_SPILL_BYTES + 50)}`;

    enqueueRun(store, runId, { inputs: { alpha: val1, beta: val2 } });

    const state = store.getState(runId)!;
    const materialized = materializeRouting(state.routing, makeGetBlob(store));
    const args = buildSubstitutionArgs(materialized, [
      { name: "alpha", type: "string", required: true },
      { name: "beta", type: "string", required: true },
    ]);

    expect(args.inputs!["alpha"]).toBe(val1);
    expect(args.inputs!["beta"]).toBe(val2);

    store.close();
  });

  test("(c) small (non-spilled) inputs pass through unchanged", () => {
    const store = freshDaemonStore();
    const runId = newRunId();

    enqueueRun(store, runId, { inputs: { task: "short value" } });

    const state = store.getState(runId)!;
    const materialized = materializeRouting(state.routing, makeGetBlob(store));
    const args = buildSubstitutionArgs(materialized, [
      { name: "task", type: "string", required: false, default: "default" },
    ]);

    expect(args.inputs!["task"]).toBe("short value");

    store.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contract note: buildSubstitutionArgs without prior materialization
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSubstitutionArgs — un-materialized BlobRef is not a string", () => {
  test("readInputMap drops un-materialized $fragua_blob refs (documents why caller must materialize)", () => {
    const sha = "a".repeat(64);
    const ref = makeBlobRef(sha, 42);
    // A still-spilled value is a `$fragua_blob` ref object — readInputMap must
    // drop it rather than feed a ref into substitution. A sibling plain string
    // survives, proving only the unrehydrated ref is lost.
    expect(readInputMap({ task: ref, env: "prod" })).toEqual({ env: "prod" });
    // This proves that without materializeRouting, the spilled value is lost
    // and callers MUST materialize before building substitution args.
  });

  test("buildSubstitutionArgs with un-materialized routing yields fallback for the spilled key", () => {
    const sha = "a".repeat(64);
    const ref = makeBlobRef(sha, 100);
    const routing = { inputs: { task: ref } };
    const args = buildSubstitutionArgs(routing as unknown as Record<string, unknown>, [
      { name: "task", type: "string" as const, required: false, default: "fallback" },
    ]);
    // Without materialization: task falls back to the declared default
    expect(args.inputs!["task"]).toBe("fallback");
  });
});
