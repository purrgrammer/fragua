// useGlobalEventStream — __invalidateKinds membership tests.
//
// Verifies that every event kind that should trigger a runs-list/detail
// cache invalidation is present in the exported set.  Pure membership
// check: no DOM, no React, no fetch mocks required.

import { describe, expect, test } from "bun:test";
import { __invalidateKinds } from "../../src/lib/useGlobalEventStream.ts";

describe("useGlobalEventStream — RUN_INVALIDATE_KINDS membership", () => {
  // Core lifecycle kinds (already present before this PR)
  test("includes core run lifecycle facts", () => {
    expect(__invalidateKinds.has("fact.run_started")).toBe(true);
    expect(__invalidateKinds.has("fact.run_completed")).toBe(true);
    expect(__invalidateKinds.has("fact.run_paused_human")).toBe(true);
    expect(__invalidateKinds.has("fact.run_paused")).toBe(true);
    expect(__invalidateKinds.has("fact.run_resumed")).toBe(true);
    expect(__invalidateKinds.has("fact.run_cancelled")).toBe(true);
    expect(__invalidateKinds.has("fact.run_halted")).toBe(true);
    expect(__invalidateKinds.has("fact.run_quarantined")).toBe(true);
    expect(__invalidateKinds.has("fact.run_requeued_after_crash")).toBe(true);
    expect(__invalidateKinds.has("intent.run_enqueued")).toBe(true);
  });

  // Operator-action facts — inbox rows must clear in all tabs
  test("includes the post-terminal operator-action facts (inbox rows clear)", () => {
    expect(__invalidateKinds.has("fact.run_accepted")).toBe(true);
    expect(__invalidateKinds.has("fact.run_discarded")).toBe(true);
  });

  // Terminal snapshot: written AFTER fact.run_completed in the dispose path;
  // sets inbox_status=pending, so the inbox=pending list must refetch on this fact.
  test("includes fact.snapshot_recorded so inbox=pending list refetches after the snapshot writes inbox_status", () => {
    expect(__invalidateKinds.has("fact.snapshot_recorded")).toBe(true);
  });

  // Auto-titler: run card title updates live after enqueue
  test("includes run.title_generated so titles appear live in run cards", () => {
    expect(__invalidateKinds.has("run.title_generated")).toBe(true);
  });
});
