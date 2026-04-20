// Fidelity-resume degradation rule. `degradeOnResume` is already unit-
// tested in fidelity.test.ts for `full → summary:high`, but SPEC §3.6 is
// stronger:
//
//   > if a node used `fidelity=full` and we're resuming after a crash,
//   > the first resumed node degrades to `summary:high` (in-memory LLM
//   > sessions can't always be serialized perfectly).
//
// Two invariants:
//   1. Every non-full mode stays unchanged (no surprise when a new mode
//      is added).
//   2. The function is exported from the package root so a resume
//      implementation can reach it without digging into engine internals.
//
// End-to-end "resume a real run" is out of scope — the checkpoint
// loader isn't wired. This suite guards the pure-function building
// block so the integration, when it arrives, can't silently regress.

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
