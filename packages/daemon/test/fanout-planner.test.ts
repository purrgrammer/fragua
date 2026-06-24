// Unit tests for the PURE fan-out frontier decision (`planFanoutStep`). No
// store, clock, or randomness — every case is the plain-data classification
// `runFanout` reads, calls, then applies.

import { describe, expect, test } from "bun:test";
import { type FanoutFrontier, planFanoutStep } from "../src/fanout-planner.ts";

const frontier = (over: Partial<FanoutFrontier>): FanoutFrontier => ({
  active: null,
  redispatch: [],
  branches: ["a", "b"],
  join: "synth",
  ...over,
});

describe("planFanoutStep", () => {
  describe("malformed", () => {
    test("missing join → malformed (before any seed/join/dispatch)", () => {
      expect(planFanoutStep(frontier({ join: undefined }))).toEqual({ kind: "malformed" });
    });

    test("no branches → malformed even when a join is declared", () => {
      expect(planFanoutStep(frontier({ branches: [], join: "synth" }))).toEqual({ kind: "malformed" });
    });

    test("malformed wins over a not-yet-seeded frontier", () => {
      expect(planFanoutStep(frontier({ active: null, branches: [] }))).toEqual({ kind: "malformed" });
    });
  });

  describe("seed (fresh frontier — active is null)", () => {
    test("single-branch → seed that one branch", () => {
      expect(planFanoutStep(frontier({ active: null, branches: ["only"] }))).toEqual({
        kind: "seed",
        branches: ["only"],
      });
    });

    test("multi-branch → seed all declared branches in order", () => {
      expect(planFanoutStep(frontier({ active: null, branches: ["a", "b", "c"] }))).toEqual({
        kind: "seed",
        branches: ["a", "b", "c"],
      });
    });
  });

  describe("join (frontier drained — active is empty)", () => {
    test("single-branch drained → advance to the join, one branch completed", () => {
      expect(planFanoutStep(frontier({ active: [], branches: ["only"], join: "j" }))).toEqual({
        kind: "join",
        nextNode: "j",
        branchesCompleted: 1,
      });
    });

    test("multi-branch drained → branchesCompleted counts the declared branches", () => {
      expect(planFanoutStep(frontier({ active: [], branches: ["a", "b", "c"], join: "synth" }))).toEqual({
        kind: "join",
        nextNode: "synth",
        branchesCompleted: 3,
      });
    });
  });

  describe("dispatch — park-and-run a live frontier", () => {
    test("single live branch, none aborted → dispatch with empty redispatch", () => {
      expect(planFanoutStep(frontier({ active: ["a"], redispatch: [] }))).toEqual({
        kind: "dispatch",
        active: ["a"],
        redispatch: [],
      });
    });

    test("multi live branches, none aborted → dispatch the whole active set", () => {
      expect(planFanoutStep(frontier({ active: ["a", "b"], redispatch: [] }))).toEqual({
        kind: "dispatch",
        active: ["a", "b"],
        redispatch: [],
      });
    });
  });

  describe("redispatch — live frontier with aborted branches to re-mark", () => {
    test("single aborted branch → dispatch carries it in redispatch", () => {
      expect(planFanoutStep(frontier({ active: ["a"], redispatch: ["a"] }))).toEqual({
        kind: "dispatch",
        active: ["a"],
        redispatch: ["a"],
      });
    });

    test("subset of a multi-branch frontier aborted → only that subset re-marked", () => {
      expect(planFanoutStep(frontier({ active: ["a", "b", "c"], redispatch: ["b"] }))).toEqual({
        kind: "dispatch",
        active: ["a", "b", "c"],
        redispatch: ["b"],
      });
    });
  });

  test("pure: identical frontier in ⇒ identical plan out, no mutation of inputs", () => {
    const input = frontier({ active: ["a", "b"], redispatch: ["a"] });
    const snapshot = structuredClone(input);
    const first = planFanoutStep(input);
    const second = planFanoutStep(input);
    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);
  });
});
