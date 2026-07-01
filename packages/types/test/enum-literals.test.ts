// The RUN_STATUSES / HALT_REASONS tuples are the single runtime source of
// truth for the RunStatus / HaltReason unions (the types derive from them).
// Downstream enum-consumer lint tests compare against these exports, so the
// only property to pin here is that the tuples themselves are well-formed.

import { describe, expect, test } from "bun:test";
import {
  HALT_REASONS,
  isSettled,
  isTerminal,
  mapStatus,
  RUN_STATUSES,
  type RunStatus,
  SETTLED_STATUS_TERMINAL_FACT,
  SETTLED_STATUSES,
  TERMINAL_FACT_TYPES,
} from "../src/index.ts";

describe("enum literal tuples", () => {
  test("RUN_STATUSES and HALT_REASONS are duplicate-free", () => {
    expect(new Set(RUN_STATUSES).size).toBe(RUN_STATUSES.length);
    expect(new Set(HALT_REASONS).size).toBe(HALT_REASONS.length);
  });

  test("SETTLED_STATUSES = terminal ∪ {quarantined}, all valid RunStatuses, duplicate-free", () => {
    expect(new Set(SETTLED_STATUSES).size).toBe(SETTLED_STATUSES.length);
    expect(new Set(SETTLED_STATUSES)).toEqual(new Set(["completed", "cancelled", "halted", "quarantined"]));
    for (const s of SETTLED_STATUSES) {
      expect(RUN_STATUSES).toContain(s);
    }
  });

  test("SETTLED_STATUS_TERMINAL_FACT names a terminal fact for every settled status", () => {
    // Record<SettledStatus, …> makes a missing key a compile error; this belt
    // asserts both-direction coverage against the real tuple at runtime.
    expect(new Set(Object.keys(SETTLED_STATUS_TERMINAL_FACT))).toEqual(new Set(SETTLED_STATUSES));
  });

  test("TERMINAL_FACT_TYPES is exactly the distinct terminal facts, both directions", () => {
    // The set the CLI follow/tail loop watches to stop. Pinned so adding a
    // terminal fact (a new settled status → fact mapping) fails here until
    // TERMINAL_FACT_TYPES — and thus `run follow` / `runs tail` — covers it.
    const expected = new Set(["fact.run_terminated", "fact.run_quarantined"]);
    expect(TERMINAL_FACT_TYPES).toEqual(expected);
    expect(new Set(Object.values(SETTLED_STATUS_TERMINAL_FACT))).toEqual(TERMINAL_FACT_TYPES);
  });

  test("isSettled is isTerminal plus quarantined, and quarantined is NOT terminal", () => {
    expect(isTerminal("quarantined")).toBe(false);
    expect(isSettled("quarantined")).toBe(true);
    for (const s of RUN_STATUSES as readonly RunStatus[]) {
      expect(isSettled(s)).toBe(isTerminal(s) || s === "quarantined");
    }
  });

  test("mapStatus is total over RUN_STATUSES and maps cancelled→canceled", () => {
    for (const s of RUN_STATUSES) {
      expect(mapStatus(s)).toBeDefined();
    }
    // Intentional spelling split: raw double-l cancelled → UI single-l canceled.
    expect(mapStatus("cancelled")).toBe("canceled");
    expect(new Set(SETTLED_STATUSES.map(mapStatus))).toEqual(new Set(["success", "fail", "canceled"]));
  });
});
