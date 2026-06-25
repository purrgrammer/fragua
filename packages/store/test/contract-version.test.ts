// Event-contract version discipline — docs/proposals/archive/event-contract-version.md §3.3/§3.4.
//
// The fold contract is precisely the events `foldFacts` reads and how it folds
// them: the `FactEvent`/`IntentEvent` variant set + each variant's shape, and
// every status/reason literal set the reducer's decision logic switches on.
// This test snapshots a hash of that surface and fails the build when it moves
// unless `EVENT_CONTRACT_VERSION` and the snapshot move in the same diff. It
// does not DECIDE the bump — it converts "silently forgot" into "build red
// until you consciously choose bump vs. re-snapshot-only".
//
// Scope is deliberate (§3.3): the variant SHAPES are in (a field whose type
// changes under an already-reading reducer trips this even without touching
// reducer text); observability events, daemon events, envelopes, and
// projection columns are OUT (off the fold path). The residue this hash cannot
// see — a reducer that starts reading a previously-ignored field with an
// unchanged surface — is covered by the separate `reducers.ts` touch-gate
// (scripts/check-contract-bump.sh).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sourceHashGate } from "@fragua/test-utils";
import { EVENT_CONTRACT_VERSION, MIN_COMPATIBLE_CONTRACT_VERSION } from "../src/pragmas.ts";

/** Declarations that ARE the fold contract. NOT `EventType`/`ALL_EVENT_TYPES`
 * (observability is off the fold path), nor `DaemonEvent`/envelopes/projection
 * shapes. `TERMINAL_STATUSES` + `AUTO_WAKE_PAUSE_REASONS` are in because the
 * reducer projects status through them. */
const SURFACE_DECLS = [
  // contract: no-bump — RunStatus/HaltReason reshaped into derived types over
  // the RUN_STATUSES/HALT_REASONS tuples (enum-consumer mechanization); the
  // literal sets are unchanged and now hashed via the tuple declarations.
  "RUN_STATUSES",
  "RunStatus",
  "TERMINAL_STATUSES",
  "PauseReason",
  "AUTO_WAKE_PAUSE_REASONS",
  "HALT_REASONS",
  "HaltReason",
  "QuarantineReason",
  "RunEnqueuedPayload",
  "IntentEvent",
  // contract: no-bump — re-added the LEGACY (≤v3) terminal/pause fact types
  // (run_completed / run_halted / run_cancelled / run_paused_human) as
  // read-only union members so the reducer/read-plane fold pre-v4 runs. This is
  // a READ-surface restoration, not an emission change: v4 still emits only
  // run_terminated / run_paused, so EVENT_CONTRACT_VERSION stays 4 and
  // MIN_COMPATIBLE stays 1 (write-new, read-all).
  "FactEvent",
] as const;

/** Mechanics (slice / normalize / hash / snapshot read-write) live in the
 * shared `sourceHashGate` helper. */
describe("event-contract version discipline", () => {
  test("contract surface matches the snapshot (§3.3)", () => {
    sourceHashGate({
      srcPath: join(__dirname, "..", "..", "types", "src", "events.ts"),
      declNames: SURFACE_DECLS,
      snapshotPath: join(__dirname, "contract-surface.snapshot.json"),
      envVar: "UPDATE_CONTRACT_SNAPSHOT",
      version: EVENT_CONTRACT_VERSION,
      errorPrefix: "contract-surface",
      bumpHint: [
        "Event-contract surface changed (a FactEvent/IntentEvent shape or a status/reason literal).",
        "",
        "If this is a real fold-contract change: bump EVENT_CONTRACT_VERSION in",
        "packages/store/src/pragmas.ts, then re-snapshot:",
        "  UPDATE_CONTRACT_SNAPSHOT=1 bun test packages/store/test/contract-version.test.ts",
        "",
        "If it is fold-invariant (a field nothing folds, a reorder): re-snapshot the",
        "same way and add a '// contract: no-bump — <reason>' marker beside the snapshot.",
      ].join("\n"),
    });
  });

  test("MIN_COMPATIBLE_CONTRACT_VERSION is pinned — a ratchet strands runs (§3.4)", () => {
    // Advancing the floor permanently strands every run pinned below it, so it
    // must be a conscious, reviewed diff — never a refactor side effect. Moving
    // the constant forces this test to move too. THE RULE: write the newest
    // version, READ ALL versions. An emission cut (e.g. the v4 fact-taxonomy
    // collapse) does NOT move this floor — the retired fact types stay
    // legacy/read-only in the union+fold, so v1–v3 runs keep folding. The floor
    // rises only when a format is genuinely un-foldable.
    expect(MIN_COMPATIBLE_CONTRACT_VERSION).toBe(1);
  });
});
