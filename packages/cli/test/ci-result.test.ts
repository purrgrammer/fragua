// `buildCiResult` — the terminal result envelope builder. Unit-level: a stub
// read plane stands in for the store read, so the mapping (run-status →
// converged wire status), the terminal-only gate, and the outputs/usage
// passthrough are exercised without booting a run.

import { describe, expect, test } from "bun:test";
import type { ReadPlane, RunDetail } from "@fragua/core/read-plane";
import type { RunStatus } from "@fragua/types";
import { buildCiResult } from "../src/ci-result.ts";

function stubReadPlane(detail: Partial<RunDetail> | null): ReadPlane {
  return {
    runDetail: () => detail as RunDetail | null,
  } as unknown as ReadPlane;
}

const USAGE = { inputTokens: 12, outputTokens: 34, costUsd: 0.56 };

describe("buildCiResult", () => {
  test("maps completed/halted/cancelled run-status to completed/errored/aborted", () => {
    const cases: Array<[RunStatus, string]> = [
      ["completed", "completed"],
      ["halted", "errored"],
      ["cancelled", "aborted"],
    ];
    for (const [runStatus, wire] of cases) {
      const rp = stubReadPlane({ ...USAGE });
      const result = buildCiResult(rp, "run-1", runStatus);
      expect(result).toBeDefined();
      expect(result?.kind).toBe("fragua.run_result");
      expect(result?.runId).toBe("run-1");
      expect(result?.status).toBe(wire as never);
    }
  });

  test("returns undefined for every non-terminal status", () => {
    const nonTerminal: RunStatus[] = ["queued", "running", "paused", "paused_human", "paused_auto", "quarantined"];
    for (const status of nonTerminal) {
      expect(buildCiResult(stubReadPlane({ ...USAGE }), "run-1", status)).toBeUndefined();
    }
  });

  test("usage carries the run-total token + cost rollup off RunDetail", () => {
    const result = buildCiResult(stubReadPlane({ ...USAGE }), "run-1", "completed");
    expect(result?.usage).toEqual(USAGE);
  });

  test("outputs present when RunDetail.outputs is populated", () => {
    const result = buildCiResult(stubReadPlane({ ...USAGE, outputs: { verdict: "approve" } }), "run-1", "completed");
    expect(result?.outputs).toEqual({ verdict: "approve" });
  });

  test("outputs omitted (key absent) when RunDetail declares none", () => {
    const result = buildCiResult(stubReadPlane({ ...USAGE }), "run-1", "completed");
    expect(result).toBeDefined();
    expect("outputs" in (result as object)).toBe(false);
  });

  test("returns undefined when the run is absent", () => {
    expect(buildCiResult(stubReadPlane(null), "run-1", "completed")).toBeUndefined();
  });
});
