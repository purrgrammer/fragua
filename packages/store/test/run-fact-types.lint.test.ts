// Run-fact-type consumer lint (CLAUDE.md ground rule 1 + 11) — Set/array sites.
//
// The run-state / terminal fact-type literals — including the four LEGACY
// (≤v3) types `fact.run_completed`, `fact.run_halted`, `fact.run_cancelled`,
// `fact.run_paused_human` that ground rule 11 keeps folding forever — have a
// single owner: `RUN_STATE_FACT_TYPES` / `TERMINAL_RUN_FACT_TYPES` in
// packages/types/src/events.ts (re-exported through @fragua/store), which the
// reducer switch and every read-plane consumer import instead of re-listing
// the literals.
//
// This test pins that: no file under packages/{core,server,cli}/src may
// declare a Set/array literal that re-lists `"fact.run_terminated"` or a
// LEGACY run fact literal. Individual comparisons (`ev.type === "…"`) and
// `switch` case labels are fine — they're per-type branching, not a set that
// can silently drift; only a fresh Set/array literal reintroduces the triple-
// maintenance this consolidation removed.
//
// `normalizeSource` (@fragua/test-utils) strips comments first, so a literal
// mentioned in prose can't trip the scan. Conservative regex, same spirit as
// enum-consumers.lint.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeSource } from "@fragua/test-utils";
import { RUN_STATE_FACT_TYPES, TERMINAL_RUN_FACT_TYPES } from "@fragua/types";

const REPO_ROOT = join(__dirname, "..", "..", "..");
// The daemon is deliberately excluded: as the primary run-fact *writer* it
// names these literals when constructing the fact events it emits (array
// literals of event objects), which is emission, not the consumer re-listing
// this consolidation removed.
const SCAN_ROOTS = ["core", "server", "cli"].map((pkg) => join(REPO_ROOT, "packages", pkg, "src"));

/** The literals owned by RUN_STATE_FACT_TYPES / TERMINAL_RUN_FACT_TYPES that
 * must not be re-listed in a Set/array literal outside the owning module.
 * Derived from the two exported sets so a newly-added run fact keeps lint
 * coverage without a third hand-maintained copy. */
const OWNED_LITERALS = [...new Set([...RUN_STATE_FACT_TYPES, ...TERMINAL_RUN_FACT_TYPES])];

function collectSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Every innermost `[ … ]` array literal (multi-line tolerated; nested
 * brackets excluded by `[^[\]]`). `new Set([…])` bodies are array literals and
 * are covered. */
function arrayLiteralSpans(normalized: string): string[] {
  return [...normalized.matchAll(/\[[^[\]]*\]/g)].map((m) => m[0]);
}

describe("run-fact-type consumers (Set/array literals)", () => {
  const sources = SCAN_ROOTS.flatMap(collectSources);

  test("no core/server/cli source re-lists an owned run fact literal in a Set/array literal", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      // Comments stripped so a literal named in prose doesn't count.
      const normalized = normalizeSource(readFileSync(file, "utf8"));
      for (const span of arrayLiteralSpans(normalized)) {
        for (const lit of OWNED_LITERALS) {
          if (span.includes(`"${lit}"`) || span.includes(`'${lit}'`)) {
            offenders.push(
              `${relative(REPO_ROOT, file)} — array/Set literal re-lists '${lit}'; import ` +
                "RUN_STATE_FACT_TYPES / TERMINAL_RUN_FACT_TYPES from @fragua/store instead",
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the reducer folds every RUN_STATE_FACT_TYPES member in a `case` arm", () => {
    // The medium defect this consolidation fixed was a run-state fact that
    // passed the set guard but had no switch arm. Pin the lockstep: every
    // owned run-state literal must appear as a `case "…"` label in the reducer.
    const reducerSrc = readFileSync(join(REPO_ROOT, "packages", "store", "src", "reducers.ts"), "utf8");
    const missing = [...RUN_STATE_FACT_TYPES].filter((lit) => !reducerSrc.includes(`case "${lit}"`));
    expect(missing).toEqual([]);
  });
});
