// Shared run-invariant checker — the state-machine invariants (SPEC §4 /
// executor-pbt-decomposition §5) that are derivable from a single run's event
// log + projection, defined once. Every driven-harness slice calls this, so a
// new fault generator automatically checks them all, and a new invariant
// automatically applies everywhere. The invariant→owner map (incl. the store-
// level P1–P27 matrix this complements) lives in invariant-coverage.test.ts.

import { expect } from "bun:test";
import {
  AUTO_WAKE_PAUSE_REASONS,
  emptyMetrics,
  type FactEvent,
  foldFacts,
  type RunState,
  type StoredEvent,
} from "@fragua/store";

const TERMINAL_FACTS = new Set(["fact.run_terminated", "fact.run_quarantined"]);

/** Translate the collapsed `fact.run_terminated` (fact-taxonomy.md §3.1) back
 *  to its pre-collapse disposition string for tests that assert over a list of
 *  bare `event.type` strings (where the `status` discriminant is otherwise
 *  lost). Non-terminal types pass through unchanged. Keeps disposition-
 *  distinguishing assertions (completed vs errored vs aborted) faithful. */
export function dispositionType(e: { type: string; payload: unknown }): string {
  if (e.type !== "fact.run_terminated") return e.type;
  const status = (e.payload as { status?: string }).status;
  if (status === "completed") return "fact.run_completed";
  if (status === "aborted") return "fact.run_cancelled";
  return "fact.run_halted";
}

const autoWake: ReadonlySet<string> = AUTO_WAKE_PAUSE_REASONS as ReadonlySet<string>;

export function checkRunInvariants(events: StoredEvent[], state: RunState): void {
  // invariant: P4 — projection = fold. Re-folding the fact log from a reset
  // initial reconstructs the projection's status / currentNode / metrics: the
  // whole reducer, validated against this run's stream. (Precedent + field
  // choice: store/test/store.property.test.ts.) Load-bearing sentinel for
  // invariant-coverage.test.ts.
  const facts = events
    .filter((e) => e.type.startsWith("fact."))
    .map((e) => ({ type: e.type, payload: e.payload }) as FactEvent);
  const from0: RunState = {
    ...state,
    routing: { ...state.routing }, // own copy — the fold must not touch live state
    metrics: emptyMetrics(),
    status: "queued",
    currentNode: null,
    dispatchStartedAt: null,
  };
  const folded = foldFacts(from0, facts, state.updatedAt);
  expect(folded.status).toBe(state.status);
  expect(folded.currentNode).toBe(state.currentNode);
  expect(folded.metrics.billedTokens).toBe(state.metrics.billedTokens);
  expect(folded.metrics.totalCostUsd).toBeCloseTo(state.metrics.totalCostUsd, 6);

  // Terminal absorbing — at most one terminal fact, and it is the last event
  // (these runs are worktree-free, so no post-terminal snapshot fact lands).
  const terminalCount = events.filter((e) => TERMINAL_FACTS.has(e.type)).length;
  expect(terminalCount).toBeLessThanOrEqual(1);
  const terminalIdx = events.findIndex((e) => TERMINAL_FACTS.has(e.type));
  if (terminalIdx !== -1) expect(terminalIdx).toBe(events.length - 1);

  // Seq strictly increasing (total per-run order; P1 contiguity is store-owned).
  for (let i = 1; i < events.length; i++) {
    expect(events[i]!.seq).toBeGreaterThan(events[i - 1]!.seq);
  }

  // Causal node order — one node at a time: never two fact.node_started without
  // an intervening fact.node_completed.
  let nodeRunning = false;
  for (const e of events) {
    if (e.type === "fact.node_started") {
      expect(nodeRunning).toBe(false);
      nodeRunning = true;
    } else if (e.type === "fact.node_completed") {
      nodeRunning = false;
    }
  }

  // Pause mapping (1:1) — a run resting at a pause carries the status its last
  // run_paused reason dictates: AUTO_WAKE reasons → paused_auto, else paused.
  if (state.status === "paused" || state.status === "paused_auto") {
    const lastPaused = [...events].reverse().find((e) => e.type === "fact.run_paused");
    if (lastPaused !== undefined) {
      const reason = (lastPaused.payload as { reason: string }).reason;
      expect(state.status).toBe(autoWake.has(reason) ? "paused_auto" : "paused");
    }
  }

  // activeMs — never negative, always finite (anti-underflow across pause/crash
  // cycles; a tighter wall-clock bound needs a virtual advancing clock).
  expect(state.metrics.activeMs).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(state.metrics.activeMs)).toBe(true);
}
