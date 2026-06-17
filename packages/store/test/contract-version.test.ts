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
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVENT_CONTRACT_VERSION, MIN_COMPATIBLE_CONTRACT_VERSION } from "../src/pragmas.ts";

const EVENTS_TS = join(__dirname, "..", "..", "types", "src", "events.ts");
const SNAPSHOT = join(__dirname, "contract-surface.snapshot.json");

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
  "FactEvent",
] as const;

/** Slice each target declaration from its start line to the line before the
 * next top-level declaration — brace-agnostic, so deep payload nesting and
 * union members don't need balancing. */
function extractDeclarations(source: string): string {
  const lines = source.split("\n");
  const declRe = /^(?:export\s+)?(?:type|const|function|interface)\s+([A-Za-z0-9_]+)/;
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = declRe.exec(line);
    if (m?.[1]) starts.push({ name: m[1], line: i });
  });

  const out: string[] = [];
  for (const name of SURFACE_DECLS) {
    const start = starts.find((s) => s.name === name)?.line;
    if (start === undefined) {
      throw new Error(`contract-surface: declaration '${name}' not found in events.ts — was it renamed?`);
    }
    // Boundary = the first declaration start strictly after this one (file
    // order, not SURFACE_DECLS order), else EOF.
    const end = starts.reduce((acc, s) => (s.line > start && s.line < acc ? s.line : acc), lines.length);
    out.push(`### ${name}\n${lines.slice(start, end).join("\n")}`);
  }
  return out.join("\n");
}

/** Strip comments and collapse whitespace so the hash tracks structure only —
 * comment/format edits don't trip it; field names, types, and optionality do. */
function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function computeHash(): string {
  const src = readFileSync(EVENTS_TS, "utf8");
  return createHash("sha256")
    .update(normalize(extractDeclarations(src)))
    .digest("hex");
}

describe("event-contract version discipline", () => {
  test("contract surface matches the snapshot (§3.3)", () => {
    const hash = computeHash();

    if (process.env["UPDATE_CONTRACT_SNAPSHOT"] === "1") {
      writeFileSync(SNAPSHOT, `${JSON.stringify({ version: EVENT_CONTRACT_VERSION, hash }, null, 2)}\n`);
      return;
    }

    const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { version: number; hash: string };

    // The snapshot's version moves WITH the code's — re-snapshotting a real
    // change without bumping (when a bump is due) is caught here.
    expect(snap.version).toBe(EVENT_CONTRACT_VERSION);

    if (hash !== snap.hash) {
      throw new Error(
        [
          "Event-contract surface changed (a FactEvent/IntentEvent shape or a status/reason literal).",
          `  snapshot ${snap.hash}`,
          `  current  ${hash}`,
          "",
          "If this is a real fold-contract change: bump EVENT_CONTRACT_VERSION in",
          "packages/store/src/pragmas.ts, then re-snapshot:",
          "  UPDATE_CONTRACT_SNAPSHOT=1 bun test packages/store/test/contract-version.test.ts",
          "",
          "If it is fold-invariant (a field nothing folds, a reorder): re-snapshot the",
          "same way and add a '// contract: no-bump — <reason>' marker beside the snapshot.",
        ].join("\n"),
      );
    }
  });

  test("MIN_COMPATIBLE_CONTRACT_VERSION is pinned — a ratchet strands runs (§3.4)", () => {
    // Advancing the floor permanently strands every run pinned below it, so it
    // must be a conscious, reviewed diff — never a refactor side effect. Moving
    // the constant forces this test to move too. Ratcheted 1 → 4 with the v4
    // fact-taxonomy collapse: v1–v3 runs carry the removed
    // fact.run_{completed,halted,cancelled,paused_human} types whose fold paths
    // the reducer dropped.
    expect(MIN_COMPATIBLE_CONTRACT_VERSION).toBe(4);
  });
});
