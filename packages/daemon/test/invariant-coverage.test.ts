// Invariant → owner coverage map. The single checked-in place that answers
// "which invariant is proven where," so it's tracked instead of reconstructed
// by grep. Covers SPEC §4 (I1–I10), the ARCH §10 property matrix (P1–P27), and
// the finer state-machine invariants (executor-pbt-decomposition §5) that the
// driven harness + the shared checkRunInvariants add on top.
//
// The tests assert the map stays well-formed: every I1–I10 and P1–P27 is
// present, every entry is triaged (has an owner or a GAP reason), no id is
// duplicated. Adding/removing an invariant forces updating this map.

import { describe, expect, test } from "bun:test";

type CoverageStatus = "covered" | "partial" | "gap";

interface InvariantCoverage {
  id: string;
  statement: string;
  status: CoverageStatus;
  /** Test file(s) that own it, or `GAP: <reason>` when uncovered. */
  owner: string;
}

const COVERAGE: InvariantCoverage[] = [
  // ── SPEC §4 — structural invariants ──────────────────────────────────────
  {
    id: "I1",
    statement: "every write is one txn; events + projection together",
    status: "covered",
    owner: "store/test/lint.test.ts (no-await-in-txn) + store.property.test.ts (P4)",
  },
  {
    id: "I2",
    statement: "no handler state outside the projection",
    status: "covered",
    owner: "core/test/handler/discipline.test.ts (I/O via ctx)",
  },
  {
    id: "I3",
    statement: "intents always-appendable; facts OCC-checked",
    status: "covered",
    owner: "store.property.test.ts (P2, P3)",
  },
  {
    id: "I4",
    statement: "handlers receive AbortSignal; respecting it is contract",
    status: "covered",
    owner: "invoke-handler.test.ts + executor.timeout.test.ts",
  },
  {
    id: "I5",
    statement: "side effects carry idempotency key; orphan INTENT quarantines on crash",
    status: "covered",
    owner: "matrix.property.test.ts (P6, P25)",
  },
  { id: "I6", statement: "run_state.routing ≤ 8KB", status: "covered", owner: "store.property.test.ts (P13)" },
  { id: "I7", statement: "event payloads ≤ 4KB", status: "covered", owner: "store.property.test.ts (P12)" },
  {
    id: "I8",
    statement: "raw output sha256-addressed; artifacts scoped by (run,node,iter,key)",
    status: "covered",
    owner: "store.property.test.ts (P14, P15) + matrix.property.test.ts (P26)",
  },
  {
    id: "I9",
    statement: "LLM-visible preview distinct from system-recorded raw",
    status: "covered",
    owner: "core/test/handler/discipline.test.ts + handler-contract",
  },
  {
    id: "I10",
    statement: "seq assignment is O(1) per-run counter, never scanned",
    status: "covered",
    owner: "store.property.test.ts (P1)",
  },

  // ── ARCH §10 — property-test matrix ──────────────────────────────────────
  { id: "P1", statement: "seq monotonic & contiguous per run", status: "covered", owner: "store.property.test.ts" },
  {
    id: "P2",
    statement: "OCC correctness — exactly one writer wins the race",
    status: "covered",
    owner: "store.property.test.ts",
  },
  { id: "P3", statement: "intent never lost", status: "covered", owner: "daemon.property.test.ts" },
  {
    id: "P4",
    statement: "projection = fold of facts",
    status: "covered",
    owner: "store.property.test.ts + invariants.ts (checkRunInvariants, every driven slice)",
  },
  {
    id: "P5",
    statement: "crash recovery requeue (running → queued on startup sweep)",
    status: "covered",
    owner: "daemon.property.test.ts + driven-executor.property.test.ts (slice 4, generated graphs)",
  },
  {
    id: "P6",
    statement: "orphan quarantine (kill between intent and done)",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  {
    id: "P7",
    statement: "unquarantine retry reuses idempotencyKey",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  {
    id: "P8",
    statement: "mid-flight abort → replay; external call ≤ 1 per key",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  {
    id: "P9",
    statement: "daemon singleton",
    status: "covered",
    owner: "daemon.property.test.ts + reaper-event.test.ts",
  },
  { id: "P10", statement: "concurrency bound (running ≤ MAX)", status: "covered", owner: "daemon.property.test.ts" },
  {
    id: "P11",
    statement: "HITL durability across crash",
    status: "covered",
    owner: "daemon.property.test.ts + driven-executor.property.test.ts (slice 3, generated graphs)",
  },
  { id: "P12", statement: "event payload bound", status: "covered", owner: "store.property.test.ts" },
  { id: "P13", statement: "routing bound", status: "covered", owner: "store.property.test.ts" },
  { id: "P14", statement: "blob dedup", status: "covered", owner: "store.property.test.ts" },
  { id: "P15", statement: "artifact loop scoping", status: "covered", owner: "store.property.test.ts" },
  {
    id: "P16",
    statement: "blob GC (orphans removed, shared retained)",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  {
    id: "P17",
    statement: "version-mismatch refusal → recoverable engine_incompatible pause",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  { id: "P18", statement: "zombie daemon commit fails OCC", status: "covered", owner: "matrix.property.test.ts" },
  { id: "P19", statement: "SSE replay via Last-Event-ID", status: "covered", owner: "server/test/.../routes.test.ts" },
  {
    id: "P20",
    statement: "abort loop ceiling → recoverable pause",
    status: "covered",
    owner: "matrix.property.test.ts + driven-executor (auto-wake/abort paths exercised generatively)",
  },
  {
    id: "P21",
    statement: "queue fairness on simultaneous HITL wake",
    status: "covered",
    owner: "daemon.property.test.ts",
  },
  {
    id: "P22",
    statement: "cascade delete removes per-run children; blobs unchanged",
    status: "covered",
    owner: "store.property.test.ts",
  },
  { id: "P23", statement: "STRICT enforcement", status: "covered", owner: "store.property.test.ts" },
  { id: "P24", statement: "claim atomicity", status: "covered", owner: "store.property.test.ts" },
  {
    id: "P25",
    statement: "pre-commit recorder durability across hard crash",
    status: "covered",
    owner: "matrix.property.test.ts",
  },
  { id: "P26", statement: "handler artifact replay safety", status: "covered", owner: "matrix.property.test.ts" },
  {
    id: "P27",
    statement: "intent-fold truth table across random batches",
    status: "covered",
    owner: "matrix.property.test.ts",
  },

  // ── executor-pbt-decomposition §5 — finer state-machine invariants ───────
  {
    id: "S5-terminal",
    statement: "terminal absorbing: exactly one terminal fact, none after",
    status: "covered",
    owner: "invariants.ts (checkRunInvariants) + transition-planner.property.test.ts (B)",
  },
  {
    id: "S5-causal",
    statement: "causal node order: node_completed precedes next node_started",
    status: "covered",
    owner: "invariants.ts (checkRunInvariants, every driven slice)",
  },
  {
    id: "S5-spend",
    statement: "spend conservation: rewrites preserve node_completed accounting",
    status: "covered",
    owner: "transition-planner.property.test.ts (D, H)",
  },
  {
    id: "S5-pause-map",
    statement: "pause reason ↔ status is 1:1 (auto reasons → paused_auto)",
    status: "covered",
    owner:
      "pause-mapping.test.ts (exhaustive over every PauseReason) + invariants.ts (resting-run check on driven runs)",
  },
  {
    id: "S5-activems",
    statement: "activeMs ≥ 0 & bounded by non-paused elapsed across pause/crash",
    status: "covered",
    owner:
      "driven-executor.property.test.ts (advancing injected clock → activeMs ≤ clockSpan − jumps) + invariants.ts (floor) + store/test/active-ms.test.ts",
  },
];

describe("invariant coverage map", () => {
  test("well-formed: unique ids, every entry triaged with an owner", () => {
    const ids = new Set<string>();
    for (const inv of COVERAGE) {
      expect(ids.has(inv.id)).toBe(false);
      ids.add(inv.id);
      expect(inv.owner.trim().length).toBeGreaterThan(0);
      expect(inv.statement.trim().length).toBeGreaterThan(0);
    }
  });

  test("every SPEC §4 (I1–I10) and ARCH §10 (P1–P27) invariant is present", () => {
    const ids = new Set(COVERAGE.map((c) => c.id));
    for (let i = 1; i <= 10; i++) expect(ids.has(`I${i}`)).toBe(true);
    for (let i = 1; i <= 27; i++) expect(ids.has(`P${i}`)).toBe(true);
  });

  test("no untracked gaps: any `gap` carries a GAP: reason", () => {
    for (const inv of COVERAGE.filter((c) => c.status === "gap")) {
      expect(inv.owner).toMatch(/^GAP:/);
    }
  });
});
