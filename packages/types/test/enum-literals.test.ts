// The RUN_STATUSES / HALT_REASONS tuples are the single runtime source of
// truth for the RunStatus / HaltReason unions (the types derive from them).
// Downstream enum-consumer lint tests compare against these exports, so the
// only property to pin here is that the tuples themselves are well-formed.

import { describe, expect, test } from "bun:test";
import { HALT_REASONS, RUN_STATUSES } from "../src/index.ts";

describe("enum literal tuples", () => {
  test("RUN_STATUSES and HALT_REASONS are duplicate-free", () => {
    expect(new Set(RUN_STATUSES).size).toBe(RUN_STATUSES.length);
    expect(new Set(HALT_REASONS).size).toBe(HALT_REASONS.length);
  });
});
