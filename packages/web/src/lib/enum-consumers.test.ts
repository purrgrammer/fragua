// Enum-literal consumer lint (ground rule 1) — web label maps + chart keys.
//
// The `satisfies` clauses on HALT_LABELS / STATUS_TO_CATEGORY / RUN_STATUS_KEYS
// already make stale keys and missing statuses a compile error. What tsc
// can't express is COVERAGE of a tuple (`satisfies readonly RunStatus[]`
// checks membership, not completeness) — these runtime assertions close
// that gap against the real exported values from @fragua/types.

import { HALT_REASONS, RUN_STATUSES } from "@fragua/types";
import { describe, expect, test } from "vitest";
import { RUN_STATUS_KEYS } from "../types/analytics.ts";
import { HALT_LABELS } from "./humanize.ts";

describe("enum-literal consumers (web)", () => {
  test("RUN_STATUS_KEYS covers exactly the RunStatus union", () => {
    const keys = new Set<string>(RUN_STATUS_KEYS);
    const missing = RUN_STATUSES.filter((s) => !keys.has(s));
    const stale = RUN_STATUS_KEYS.filter((k) => !(RUN_STATUSES as readonly string[]).includes(k));
    expect(
      { stale, missing },
      "web/src/types/analytics.ts RUN_STATUS_KEYS drifted from RUN_STATUSES (@fragua/types)",
    ).toEqual({ stale: [], missing: [] });
  });

  test("HALT_LABELS keys are exactly RunStatus ∪ a HaltReason subset, with all statuses covered", () => {
    const known = new Set<string>([...RUN_STATUSES, ...HALT_REASONS]);
    const keys = Object.keys(HALT_LABELS);
    const stale = keys.filter((k) => !known.has(k));
    const missing = RUN_STATUSES.filter((s) => !keys.includes(s));
    expect(
      { stale, missing },
      "web/src/lib/humanize.ts HALT_LABELS drifted from RUN_STATUSES/HALT_REASONS (@fragua/types)",
    ).toEqual({ stale: [], missing: [] });
  });
});
