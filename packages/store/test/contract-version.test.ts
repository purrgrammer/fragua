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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceHashGate } from "@fragua/test-utils";
import { EVENT_CONTRACT_VERSION, MIN_COMPATIBLE_CONTRACT_VERSION } from "../src/pragmas.ts";

/** Declarations that ARE the fold contract. NOT `EventType`/`ALL_EVENT_TYPES`
 * (observability is off the fold path), nor `DaemonEvent`/envelopes/projection
 * shapes. `TERMINAL_STATUSES` + `AUTO_WAKE_PAUSE_REASONS` are in because the
 * reducer projects status through them. */
const SURFACE_DECLS = [
  // contract: no-bump — RunStatus/HaltReason/PauseReason reshaped into derived
  // types over the RUN_STATUSES/HALT_REASONS/PAUSE_REASONS tuples (enum-consumer
  // mechanization); the literal sets are unchanged and now hashed via the tuple
  // declarations.
  "RUN_STATUSES",
  "RunStatus",
  "TERMINAL_STATUSES",
  "PAUSE_REASONS",
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

/** Event-module declarations `reducers.ts` references that are deliberately
 * OFF the fold-contract hash — they're consumed by the reducer but their SHAPE
 * is not part of what `foldFacts` reads, so a field change can't move fold
 * semantics. Each entry is a conscious, named exemption: adding one is the
 * place a reviewer pauses. Empty today — every event type the reducer touches
 * (`FactEvent`, `RunEnqueuedPayload`, `AUTO_WAKE_PAUSE_REASONS`) IS the fold
 * contract and lives in `SURFACE_DECLS`. */
const OFF_PATH_EVENT_DECLS = new Set<string>([]);

/** Top-level declaration names in an `@fragua/types/events`-shaped module —
 * `(export) type|interface|const|let|var|function|class|enum Name`. The
 * candidate surface the reducer is allowed to reference. */
function moduleDeclNames(src: string): Set<string> {
  const names = new Set<string>();
  const re =
    /^(?:export\s+)?(?:declare\s+)?(?:type|interface|const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) names.add(m[1] as string);
  return names;
}

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

  // Third scan: the hand-curated `SURFACE_DECLS` only hashes the declarations a
  // human remembered to name. A standalone payload type referenced by a
  // `FactEvent` variant whose field is later renamed changes what the reducer
  // FOLDS while leaving `FactEvent`'s own text byte-identical — invisible to
  // both the surface hash and the reducers.ts touch-gate. This closes that hole
  // statically: every `@fragua/types/events` declaration the reducer references
  // must be in `SURFACE_DECLS` (so its body is hashed) OR on the explicit,
  // named off-path allowlist. A new folded payload type that isn't registered
  // fails here — AGENTS.md rule 11 (fold the full range forever).
  test("every events-module type the reducer references is hashed or allowlisted off-path", () => {
    const eventsSrc = readFileSync(join(__dirname, "..", "..", "types", "src", "events.ts"), "utf8");
    const reducersSrc = readFileSync(join(__dirname, "..", "src", "reducers.ts"), "utf8");
    const eventDecls = moduleDeclNames(eventsSrc);
    const surface = new Set<string>(SURFACE_DECLS);

    const referenced = [...eventDecls].filter((name) => new RegExp(`\\b${name}\\b`).test(reducersSrc)).sort();

    // Sanity: the scan must actually find the types we know the reducer folds,
    // else a regex/path regression would make this gate vacuously green.
    expect(referenced).toContain("FactEvent");
    expect(referenced).toContain("RunEnqueuedPayload");

    const unregistered = referenced.filter((name) => !surface.has(name) && !OFF_PATH_EVENT_DECLS.has(name));
    expect(
      unregistered,
      [
        `reducers.ts references @fragua/types/events type(s) not in the fold-contract surface: ${unregistered.join(", ")}.`,
        "",
        "The reducer folds these, so a field rename on them changes fold semantics.",
        "Register each EITHER in SURFACE_DECLS (so its body is hashed by the contract",
        "gate) — the default — OR, if it is genuinely off the fold path (consumed but",
        "its shape is not read), add it to OFF_PATH_EVENT_DECLS with a reason.",
      ].join("\n"),
    ).toEqual([]);
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
