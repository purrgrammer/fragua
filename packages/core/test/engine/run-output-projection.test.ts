// Pure `projectRunOutput` tests — the run-BOUNDARY path walk that distinguishes
// absent (key omitted) from present-null. Proposal §11.1.

import { describe, expect, test } from "bun:test";
import { projectRunOutput } from "../../src/engine/outputs-substitution.ts";
import type { OutputStructValue } from "../../src/types/outputs.ts";

const struct: OutputStructValue = {
  verdict: "PASS",
  count: 0,
  note: null,
  scores: { total: 7 },
  findings: ["a", "b"],
};

describe("projectRunOutput", () => {
  test("present scalar leaf is projected", () => {
    expect(projectRunOutput(struct, ["verdict"])).toEqual({ present: true, value: "PASS" });
  });

  test("a falsy-but-present scalar (0) is present, not absent", () => {
    expect(projectRunOutput(struct, ["count"])).toEqual({ present: true, value: 0 });
  });

  test("present-null leaf is present with null (distinct from absent)", () => {
    expect(projectRunOutput(struct, ["note"])).toEqual({ present: true, value: null });
  });

  test("absent field (omitted) is not present", () => {
    expect(projectRunOutput(struct, ["missing"])).toEqual({ present: false });
  });

  test("empty path returns the whole struct", () => {
    expect(projectRunOutput(struct, [])).toEqual({ present: true, value: struct });
  });

  test("dotted path into a sub-record resolves the leaf", () => {
    expect(projectRunOutput(struct, ["scores", "total"])).toEqual({ present: true, value: 7 });
  });

  test("path through an omitted intermediate field is absent", () => {
    expect(projectRunOutput(struct, ["scores", "gone"])).toEqual({ present: false });
  });

  test("dotting into a scalar/array is absent (not present)", () => {
    expect(projectRunOutput(struct, ["verdict", "x"])).toEqual({ present: false });
    expect(projectRunOutput(struct, ["findings", "x"])).toEqual({ present: false });
  });
});
