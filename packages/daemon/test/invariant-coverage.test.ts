// Invariant → owner coverage map. The single checked-in place that answers
// "which invariant is proven where," so it's tracked instead of reconstructed
// by grep. Covers SPEC §4 (I1–I10), the ARCH §10 property matrix (P1–P27), and
// the finer state-machine invariants (executor-pbt-decomposition §5) that the
// driven harness + the shared checkRunInvariants add on top.
//
// The tests assert the map stays well-formed: every I1–I10 and P1–P27 is
// present, every entry is triaged (has an owner or a GAP reason), no id is
// duplicated. Adding/removing an invariant forces updating this map.
//
// The map also verifies what it asserts:
// - every `ownerFiles` path must exist on disk (repo-relative), so deleting
//   an owning test file trips this gate naming the invariant and the path;
// - the critical invariants (SENTINELS below) must be pinned by a sentinel
//   comment co-located with the owning assertion. Sentinel format, one line:
//     // invariant: <ID>[, <ID>...]
//   optionally followed by prose on the same/next lines. The grep is exact —
//   anchored to the `// invariant: ` prefix with a word boundary after the id,
//   so `I3` never matches `I30`.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const STORE_PBT = "packages/store/test/store.property.test.ts";
const STORE_LINT = "packages/store/test/lint.test.ts";
const STORE_ACTIVE_MS = "packages/store/test/active-ms.test.ts";
const CORE_DISCIPLINE = "packages/core/test/handler/discipline.test.ts";
const HANDLER_CONTRACT = "docs/handler-contract.md";
const MATRIX = "packages/daemon/test/matrix.property.test.ts";
const DAEMON_PBT = "packages/daemon/test/daemon.property.test.ts";
const DRIVEN = "packages/daemon/test/driven-executor.property.test.ts";
const FAULTS = "packages/daemon/test/executor-faults.property.test.ts";
const INVOKE = "packages/daemon/test/invoke-handler.test.ts";
const TIMEOUT = "packages/daemon/test/executor.timeout.test.ts";
const INVARIANTS = "packages/daemon/test/invariants.ts";
const TRANSITION = "packages/daemon/test/transition-planner.property.test.ts";
const ABORT_PLANNER = "packages/daemon/test/abort-planner.property.test.ts";
const PAUSE_MAPPING = "packages/daemon/test/pause-mapping.test.ts";
const REAPER = "packages/daemon/test/reaper-event.test.ts";
const SERVER_ROUTES = "packages/server/test/store/routes.test.ts";

type CoverageStatus = "covered" | "partial" | "gap";

interface InvariantCoverage {
  id: string;
  statement: string;
  status: CoverageStatus;
  /** Test file(s) that own it, or `GAP: <reason>` when uncovered. */
  owner: string;
  /** Repo-relative paths backing `owner` — each must exist on disk. */
  ownerFiles: string[];
}

const COVERAGE: InvariantCoverage[] = [
  // ── SPEC §4 — structural invariants ──────────────────────────────────────
  {
    id: "I1",
    statement: "every write is one txn; events + projection together",
    status: "covered",
    owner: "store/test/lint.test.ts (no-await-in-txn) + store.property.test.ts (P4)",
    ownerFiles: [STORE_LINT, STORE_PBT],
  },
  {
    id: "I2",
    statement: "no handler state outside the projection",
    status: "covered",
    owner: "core/test/handler/discipline.test.ts (I/O via ctx)",
    ownerFiles: [CORE_DISCIPLINE],
  },
  {
    id: "I3",
    statement: "intents always-appendable; facts OCC-checked",
    status: "covered",
    owner: "store.property.test.ts (P2, P3)",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "I4",
    statement: "handlers receive AbortSignal; respecting it is contract",
    status: "covered",
    owner:
      "invoke-handler.test.ts + executor.timeout.test.ts + executor-faults.property.test.ts (a hung handler is leaked, never wedges)",
    ownerFiles: [INVOKE, TIMEOUT, FAULTS],
  },
  {
    id: "I5",
    statement: "side effects carry idempotency key; orphan INTENT quarantines on crash",
    status: "covered",
    owner: "matrix.property.test.ts (P6, P25)",
    ownerFiles: [MATRIX],
  },
  {
    id: "I6",
    statement: "run_state.routing ≤ 8KB",
    status: "covered",
    owner: "store.property.test.ts (P13)",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "I7",
    statement: "event payloads ≤ 4KB",
    status: "covered",
    owner: "store.property.test.ts (P12)",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "I8",
    statement: "raw output sha256-addressed; artifacts scoped by (run,node,iter,key)",
    status: "covered",
    owner: "store.property.test.ts (P14, P15) + matrix.property.test.ts (P26)",
    ownerFiles: [STORE_PBT, MATRIX],
  },
  {
    id: "I9",
    statement: "LLM-visible preview distinct from system-recorded raw",
    status: "covered",
    owner: "core/test/handler/discipline.test.ts + handler-contract",
    ownerFiles: [CORE_DISCIPLINE, HANDLER_CONTRACT],
  },
  {
    id: "I10",
    statement: "seq assignment is O(1) per-run counter, never scanned",
    status: "covered",
    owner: "store.property.test.ts (P1)",
    ownerFiles: [STORE_PBT],
  },

  // ── ARCH §10 — property-test matrix ──────────────────────────────────────
  {
    id: "P1",
    statement: "seq monotonic & contiguous per run",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P2",
    statement: "OCC correctness — exactly one writer wins the race",
    status: "covered",
    owner:
      "store.property.test.ts + executor-faults.property.test.ts (OCC conflict swept across commits, generated graphs)",
    ownerFiles: [STORE_PBT, FAULTS],
  },
  {
    id: "P3",
    statement: "intent never lost",
    status: "covered",
    owner: "daemon.property.test.ts",
    ownerFiles: [DAEMON_PBT],
  },
  {
    id: "P4",
    statement: "projection = fold of facts",
    status: "covered",
    owner: "store.property.test.ts + invariants.ts (checkRunInvariants, every driven slice)",
    ownerFiles: [STORE_PBT, INVARIANTS],
  },
  {
    id: "P5",
    statement: "crash recovery requeue (running → queued on startup sweep)",
    status: "covered",
    owner:
      "daemon.property.test.ts + driven-executor.property.test.ts (slice 4) + executor-faults.property.test.ts (store-commit failure → bounded halt, never wedges)",
    ownerFiles: [DAEMON_PBT, DRIVEN, FAULTS],
  },
  {
    id: "P6",
    statement: "orphan quarantine (kill between intent and done)",
    status: "covered",
    owner:
      "matrix.property.test.ts + executor-faults.property.test.ts (orphan sweep over generated graphs — this slice found the run_quarantined P4 fix, c4a9ff69)",
    ownerFiles: [MATRIX, FAULTS],
  },
  {
    id: "P7",
    statement: "unquarantine retry reuses idempotencyKey",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P8",
    statement: "mid-flight abort → replay; external call ≤ 1 per key",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P9",
    statement: "daemon singleton",
    status: "covered",
    owner: "daemon.property.test.ts + reaper-event.test.ts",
    ownerFiles: [DAEMON_PBT, REAPER],
  },
  {
    id: "P10",
    statement: "concurrency bound (running ≤ MAX)",
    status: "covered",
    owner: "daemon.property.test.ts",
    ownerFiles: [DAEMON_PBT],
  },
  {
    id: "P11",
    statement: "HITL durability across crash",
    status: "covered",
    owner: "daemon.property.test.ts + driven-executor.property.test.ts (slice 3, generated graphs)",
    ownerFiles: [DAEMON_PBT, DRIVEN],
  },
  {
    id: "P12",
    statement: "event payload bound",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P13",
    statement: "routing bound",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P14",
    statement: "blob dedup",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P15",
    statement: "artifact loop scoping",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P16",
    statement: "blob GC (orphans removed, shared retained)",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P17",
    statement: "version-mismatch refusal → recoverable engine_incompatible pause",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P18",
    statement: "zombie daemon commit fails OCC",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P19",
    statement: "SSE replay via Last-Event-ID",
    status: "covered",
    owner: "server/test/.../routes.test.ts",
    ownerFiles: [SERVER_ROUTES],
  },
  {
    id: "P20",
    statement: "abort loop ceiling → recoverable pause",
    status: "covered",
    owner: "matrix.property.test.ts + driven-executor (auto-wake/abort paths exercised generatively)",
    ownerFiles: [MATRIX, DRIVEN],
  },
  {
    id: "P21",
    statement: "queue fairness on simultaneous HITL wake",
    status: "covered",
    owner: "daemon.property.test.ts",
    ownerFiles: [DAEMON_PBT],
  },
  {
    id: "P22",
    statement: "cascade delete removes per-run children; blobs unchanged",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P23",
    statement: "STRICT enforcement",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P24",
    statement: "claim atomicity",
    status: "covered",
    owner: "store.property.test.ts",
    ownerFiles: [STORE_PBT],
  },
  {
    id: "P25",
    statement: "pre-commit recorder durability across hard crash",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P26",
    statement: "handler artifact replay safety",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },
  {
    id: "P27",
    statement: "intent-fold truth table across random batches",
    status: "covered",
    owner: "matrix.property.test.ts",
    ownerFiles: [MATRIX],
  },

  // ── executor-pbt-decomposition §5 — finer state-machine invariants ───────
  {
    id: "S5-terminal",
    statement: "terminal absorbing: exactly one terminal fact, none after",
    status: "covered",
    owner: "invariants.ts (checkRunInvariants) + transition-planner.property.test.ts (B)",
    ownerFiles: [INVARIANTS, TRANSITION],
  },
  {
    id: "S5-causal",
    statement: "causal node order: node_completed precedes next node_started",
    status: "covered",
    owner: "invariants.ts (checkRunInvariants, every driven slice)",
    ownerFiles: [INVARIANTS],
  },
  {
    id: "S5-spend",
    statement: "spend conservation: rewrites preserve node_completed accounting",
    status: "covered",
    owner: "transition-planner.property.test.ts (D, H) + abort-planner.property.test.ts (node_aborted partial spend)",
    ownerFiles: [TRANSITION, ABORT_PLANNER],
  },
  {
    id: "S5-pause-map",
    statement: "pause reason ↔ status is 1:1 (auto reasons → paused_auto)",
    status: "covered",
    owner:
      "pause-mapping.test.ts (exhaustive over every PauseReason) + invariants.ts (resting-run check on driven runs)",
    ownerFiles: [PAUSE_MAPPING, INVARIANTS],
  },
  {
    id: "S5-activems",
    statement: "activeMs ≥ 0 & bounded by non-paused elapsed across pause/crash",
    status: "covered",
    owner:
      "driven-executor.property.test.ts (advancing injected clock → activeMs ≤ clockSpan − jumps) + invariants.ts (floor) + store/test/active-ms.test.ts",
    ownerFiles: [DRIVEN, INVARIANTS, STORE_ACTIVE_MS],
  },
];

// Critical invariants pinned one level deeper: the owning file must carry a
// `// invariant: <ID>` sentinel next to the asserting test, so a file that
// survives while the assertion is deleted or renamed away still trips the gate.
const SENTINELS: Record<string, string[]> = {
  I3: [STORE_PBT],
  I5: [MATRIX],
  P5: [DAEMON_PBT, DRIVEN, FAULTS],
  P6: [MATRIX, FAULTS],
};

function sentinelPattern(id: string): RegExp {
  return new RegExp(`// invariant: (?:[A-Za-z0-9-]+, )*${id}\\b`);
}

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

  test("every cited owner file exists on disk", () => {
    const missing: string[] = [];
    for (const inv of COVERAGE) {
      if (inv.status === "gap") continue;
      expect(inv.ownerFiles.length).toBeGreaterThan(0);
      for (const file of inv.ownerFiles) {
        if (!existsSync(join(REPO_ROOT, file))) {
          missing.push(`${inv.id}: ${file}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("critical invariants are pinned by sentinel comments in their owning tests", () => {
    const unpinned: string[] = [];
    for (const [id, files] of Object.entries(SENTINELS)) {
      const pattern = sentinelPattern(id);
      for (const file of files) {
        const path = join(REPO_ROOT, file);
        if (!existsSync(path)) {
          unpinned.push(`${id}: ${file} (file missing)`);
          continue;
        }
        if (!pattern.test(readFileSync(path, "utf8"))) {
          unpinned.push(`${id}: ${file} (no \`// invariant: ${id}\` sentinel)`);
        }
      }
    }
    expect(unpinned).toEqual([]);
  });

  test("sentinel registry is consistent with the map", () => {
    const byId = new Map(COVERAGE.map((c) => [c.id, c]));
    for (const id of ["I3", "I5", "P5", "P6"]) {
      expect(Object.keys(SENTINELS)).toContain(id);
    }
    for (const [id, files] of Object.entries(SENTINELS)) {
      const entry = byId.get(id);
      expect(entry).toBeDefined();
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(entry!.ownerFiles).toContain(file);
      }
    }
  });
});
