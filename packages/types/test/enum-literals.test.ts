// The RUN_STATUSES / HALT_REASONS tuples are the single runtime source of
// truth for the RunStatus / HaltReason unions (the types derive from them).
// Downstream enum-consumer lint tests compare against these exports, so the
// only property to pin here is that the tuples themselves are well-formed.

import { describe, expect, test } from "bun:test";
import { HALT_REASONS, isSettled, isTerminal, RUN_STATUSES, type RunStatus, SETTLED_STATUSES } from "../src/index.ts";

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

  test("isSettled is isTerminal plus quarantined, and quarantined is NOT terminal", () => {
    expect(isTerminal("quarantined")).toBe(false);
    expect(isSettled("quarantined")).toBe(true);
    for (const s of RUN_STATUSES as readonly RunStatus[]) {
      expect(isSettled(s)).toBe(isTerminal(s) || s === "quarantined");
    }
  });
});
