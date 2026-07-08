// Typed-routing accessor tests — docs/proposals/typed-routing-struct.md §6.
//
// The accessors are the typed form of the ad-hoc inline casts they replaced;
// they validate-and-degrade the SAME flat dotted bytes live runs carry. These
// tests pin the degrade posture (§6.3) and the `getInputs` guard parity
// (ruling 2) against a verbatim copy of the legacy `readInputMap`.

import { describe, expect, test } from "bun:test";
import {
  ACTIVE_NODES_KEY,
  AUTO_RESUME_AT_KEY,
  budgetOverrideKey,
  capOperatorNotes,
  GOAL_GATE_RETRIES_KEY,
  GRAPH_GOAL_KEY,
  GRAPH_RUN_ID_KEY,
  getBudget,
  getContext,
  getFrontier,
  getGoalGate,
  getInputs,
  getLimits,
  getRetry,
  getTimer,
  goalGateOutcomeKey,
  INPUTS_KEY,
  MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY,
  MAX_LOOPS_OVERRIDE_KEY,
  maxRetriesOverrideKey,
  OPERATOR_NOTE_MAX_BYTES,
  OPERATOR_NOTES_KEY,
  OPERATOR_NOTES_MAX_BYTES,
  PROVIDER_RETRY_ATTEMPT_KEY,
  PROVIDER_RETRY_CUMULATIVE_MS_KEY,
  readOperatorNotes,
  retryCountKey,
  timeoutRetriesKey,
  truncateOperatorNote,
} from "../src/routing.ts";

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Verbatim copy of the pre-wrapper `executor-helpers.readInputMap` — the
 * golden reference the relocated `getInputs` guards must match exactly. */
function legacyReadInputMap(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "__proto__") continue;
    if (val !== null && typeof val === "object" && Object.hasOwn(val as Record<string, unknown>, "$fragua_blob")) {
      continue;
    }
    out[k] = val;
  }
  return out;
}

describe("routing accessors", () => {
  test("getInputs drops a __proto__ key identically to the legacy readInputMap", () => {
    const polluted = JSON.parse('{"__proto__":{"x":1},"keep":"y"}') as Record<string, unknown>;
    const viaAccessor = getInputs({ [INPUTS_KEY]: polluted });
    const viaLegacy = legacyReadInputMap(polluted);
    expect(viaAccessor).toEqual(viaLegacy);
    expect(Object.hasOwn(viaAccessor, "__proto__")).toBe(false);
    expect(viaAccessor).toEqual({ keep: "y" });
  });

  test("getInputs drops an un-materialized $fragua_blob ref entry, like the legacy reader", () => {
    const ref = { $fragua_blob: "a".repeat(64), bytes: 4096 };
    const inputs = { task: ref, env: "prod", constructor: "kept" };
    expect(getInputs({ [INPUTS_KEY]: inputs })).toEqual(legacyReadInputMap(inputs));
    expect(getInputs({ [INPUTS_KEY]: inputs })).toEqual({ env: "prod", constructor: "kept" });
  });

  test("getInputs returns {} for a non-object inputs value", () => {
    expect(getInputs({ [INPUTS_KEY]: 42 })).toEqual({});
    expect(getInputs({ [INPUTS_KEY]: null })).toEqual({});
    expect(getInputs({ [INPUTS_KEY]: ["a"] })).toEqual({});
    expect(getInputs({})).toEqual({});
  });

  test("getFrontier element-validates and degrades to null", () => {
    expect(getFrontier({ [ACTIVE_NODES_KEY]: ["a", "b"] })).toEqual(["a", "b"]);
    expect(getFrontier({ [ACTIVE_NODES_KEY]: ["a", 7] })).toBeNull();
    expect(getFrontier({ [ACTIVE_NODES_KEY]: "a" })).toBeNull();
    expect(getFrontier({})).toBeNull();
  });

  test("getBudget degrades non-number overrides and non-array warned", () => {
    const r = {
      [budgetOverrideKey("run", "cost")]: 5,
      [budgetOverrideKey("node", "tokens")]: "nope",
      __budget_warned: ["run:cost", 7, "node:tokens"],
    };
    const b = getBudget(r);
    expect(b.override("run", "cost")).toBe(5);
    expect(b.override("node", "tokens")).toBeUndefined();
    expect(b.override("run", "tokens")).toBeUndefined();
    expect([...b.warned].sort()).toEqual(["node:tokens", "run:cost"]);
    expect(getBudget({ __budget_warned: 9 }).warned.size).toBe(0);
  });

  test("getRetry / getTimer / getLimits / getContext degrade to safe defaults", () => {
    const retry = getRetry({
      [retryCountKey("work")]: 3,
      [timeoutRetriesKey("work")]: Number.NaN,
      [PROVIDER_RETRY_ATTEMPT_KEY]: 2,
      [PROVIDER_RETRY_CUMULATIVE_MS_KEY]: 1500,
    });
    expect(retry.count("work")).toBe(3);
    expect(retry.count("other")).toBe(0);
    expect(retry.timeoutRetries("work")).toBe(0); // NaN → 0
    expect(retry.providerAttempt).toBe(2);
    expect(retry.providerCumulativeMs).toBe(1500);

    expect(getTimer({ [AUTO_RESUME_AT_KEY]: 1234 })).toBe(1234);
    expect(getTimer({ [AUTO_RESUME_AT_KEY]: "soon" })).toBeUndefined();
    expect(getTimer({})).toBeUndefined();

    const limits = getLimits({
      [MAX_LOOPS_OVERRIDE_KEY]: 10,
      [maxRetriesOverrideKey("work")]: 4,
      [MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY]: "x",
    });
    expect(limits.maxLoops).toBe(10);
    expect(limits.maxRetries("work")).toBe(4);
    expect(limits.maxRetries("other")).toBeUndefined();
    expect(limits.maxGoalGateRetries).toBeUndefined();

    const ctx = getContext({ [GRAPH_GOAL_KEY]: "ship it", [GRAPH_RUN_ID_KEY]: 99 });
    expect(ctx.goal).toBe("ship it");
    expect(ctx.runId).toBeUndefined(); // non-string degrades
  });

  test("getGoalGate value-checks outcome against OUTCOME_STATUS", () => {
    const r = {
      [goalGateOutcomeKey("verify")]: "success",
      [goalGateOutcomeKey("review")]: "fail",
      [goalGateOutcomeKey("bad")]: "weird",
      [goalGateOutcomeKey("num")]: 42,
      [GOAL_GATE_RETRIES_KEY]: 2,
    };
    const g = getGoalGate(r);
    expect(g.outcome("verify")).toBe("success");
    expect(g.outcome("review")).toBe("fail");
    expect(g.outcome("bad")).toBeUndefined();
    expect(g.outcome("num")).toBeUndefined();
    expect([...g.outcomes.keys()].sort()).toEqual(["review", "verify"]);
    expect(g.retries).toBe(2);
    expect(getGoalGate({ [GOAL_GATE_RETRIES_KEY]: "two" }).retries).toBe(0);
  });

  test("readOperatorNotes element-validates and drops empty notes", () => {
    const good = { gateNodeId: "plan_gate", route: "revise", note: "use the v2 schema" };
    const r = {
      [OPERATOR_NOTES_KEY]: [
        good,
        { gateNodeId: "g2", route: "approve", note: "" }, // empty note → dropped
        { gateNodeId: "g3", route: "approve" }, // missing note → dropped
        { gateNodeId: 7, route: "x", note: "y" }, // wrong type → dropped
        "junk",
        null,
      ],
    };
    expect(readOperatorNotes(r)).toEqual([good]);
    expect(readOperatorNotes({ [OPERATOR_NOTES_KEY]: "junk" })).toEqual([]);
    expect(readOperatorNotes({})).toEqual([]);
  });

  test("truncateOperatorNote bounds by UTF-8 bytes and marks the cut", () => {
    expect(truncateOperatorNote("fits")).toBe("fits");
    const long = "x".repeat(OPERATOR_NOTE_MAX_BYTES + 50);
    const cut = truncateOperatorNote(long);
    expect(utf8Len(cut)).toBeLessThanOrEqual(OPERATOR_NOTE_MAX_BYTES);
    expect(cut).toEndWith(" [truncated]");
  });

  test("truncateOperatorNote caps multibyte notes by bytes, not char count, on a codepoint boundary", () => {
    // A 2000-char CJK note is ~6KB; a char-only cap would breach the routing column.
    const cjk = "験".repeat(OPERATOR_NOTE_MAX_BYTES); // 3 bytes each
    const cut = truncateOperatorNote(cjk);
    expect(utf8Len(cut)).toBeLessThanOrEqual(OPERATOR_NOTE_MAX_BYTES);
    // No U+FFFD from a split multibyte sequence.
    expect(cut.replace(" [truncated]", "")).not.toContain("�");

    const emoji = "😀".repeat(600); // surrogate pairs, 4 bytes each
    const cutE = truncateOperatorNote(emoji);
    expect(utf8Len(cutE)).toBeLessThanOrEqual(OPERATOR_NOTE_MAX_BYTES);
    expect(cutE.replace(" [truncated]", "")).not.toContain("�");
  });

  test("capOperatorNotes drops oldest until the serialized array fits, keeping the newest", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({
      gateNodeId: `g${i}`,
      route: "approve",
      note: "x".repeat(500),
    }));
    const capped = capOperatorNotes(notes);
    expect(capped.length).toBeLessThan(notes.length);
    expect(utf8Len(JSON.stringify(capped))).toBeLessThanOrEqual(OPERATOR_NOTES_MAX_BYTES);
    // Newest preserved; oldest dropped.
    expect(capped.at(-1)).toEqual(notes.at(-1)!);
    expect(capped[0]).not.toEqual(notes[0]);
    // A single small note is never dropped.
    const one = notes[0]!;
    expect(capOperatorNotes([one])).toEqual([one]);
  });

  test("reads legacy flat-dotted bytes without bricking", () => {
    // A hand-built pre-wrapper routing blob (exactly the flat dotted shape live
    // runs carry). Every accessor reads it; none throws.
    const legacy: Record<string, unknown> = {
      inputs: { task: "do the thing" },
      "internal.active_nodes": ["a", "b"],
      "internal.auto_resume_at": 1700000000000,
      "internal.retry_count.work": 1,
      "internal.provider_retry.attempt": 0,
      "budget_override.run.cost": 12.5,
      __budget_warned: ["run:cost"],
      "goal_gates.verify": "success",
      "goal_gates.__retries": 1,
      max_loops_override: 8,
      "graph.goal": "the goal",
    };
    expect(getInputs(legacy)).toEqual({ task: "do the thing" });
    expect(getFrontier(legacy)).toEqual(["a", "b"]);
    expect(getTimer(legacy)).toBe(1700000000000);
    expect(getRetry(legacy).count("work")).toBe(1);
    expect(getBudget(legacy).override("run", "cost")).toBe(12.5);
    expect([...getBudget(legacy).warned]).toEqual(["run:cost"]);
    expect(getGoalGate(legacy).outcome("verify")).toBe("success");
    expect(getGoalGate(legacy).retries).toBe(1);
    expect(getLimits(legacy).maxLoops).toBe(8);
    expect(getContext(legacy).goal).toBe("the goal");
  });
});
