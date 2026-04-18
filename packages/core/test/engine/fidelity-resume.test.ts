// Wave 3 — fidelity-resume degradation rule. `degradeOnResume` is
// already unit-tested in fidelity.test.ts for `full → summary:high`,
// but the SPEC §3.6 rule is stronger:
//
//   > if a node used `fidelity=full` and we're resuming after a crash,
//   > the first resumed node degrades to `summary:high` (in-memory LLM
//   > sessions can't always be serialized perfectly).
//
// Two things to nail down in Wave 3:
//   1. *Every* non-full mode stays unchanged (no accidental surprise
//      when a future patch adds a new mode).
//   2. The function is exported from the package root so a future
//      resume implementation (and external callers) can reach it
//      without digging into `engine/fidelity.ts`.
//
// The integration "resume a real run" test is intentionally out of
// scope — resume is not yet wired end-to-end (no checkpoint loader).
// That lands with Wave 4+. This suite guards the building block so the
// integration, when it arrives, doesn't silently regress.

import { describe, expect, test } from "bun:test";
import { degradeOnResume, type FidelityMode } from "../../src/index.ts";

const ALL_MODES: FidelityMode[] = ["full", "truncate", "compact", "summary:low", "summary:medium", "summary:high"];

describe("degradeOnResume — SPEC §3.6 rule", () => {
  test("exported from the package root so resume callers can import without reaching into engine/", () => {
    expect(typeof degradeOnResume).toBe("function");
  });

  test("every non-full mode is a fixed point", () => {
    for (const mode of ALL_MODES) {
      if (mode === "full") continue;
      expect(degradeOnResume(mode)).toBe(mode);
    }
  });

  test("full → summary:high (never to summary:low or summary:medium)", () => {
    expect(degradeOnResume("full")).toBe("summary:high");
  });

  test("idempotent: applying twice gives the same answer as once", () => {
    for (const mode of ALL_MODES) {
      const once = degradeOnResume(mode);
      const twice = degradeOnResume(once);
      expect(twice).toBe(once);
    }
  });
});
