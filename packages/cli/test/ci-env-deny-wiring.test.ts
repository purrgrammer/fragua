// Integration assertion: `fragua ci` wires envDenyNames + envDenyPredicate from
// the same allowlist as the scrub needles — the "one list, two consumers" contract
// (proposal §15). This test proves a *_TOKEN env var appears in BOTH the
// deny set and the captured needle set without touching the ci command itself,
// and that the predicate catches vars set after the Set was built.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureCiEnvSecrets, ciEnvDenyNames, ciEnvDenyPredicate } from "../src/env-creds.ts";

describe("ci wires envDenyNames into the provisioner from the same allowlist", () => {
  const FAKE_VAR = "FAKE_CI_TOKEN";
  const FAKE_VAL = "tok-xyz-12345678";
  let savedVal: string | undefined;

  beforeEach(() => {
    savedVal = process.env[FAKE_VAR];
    process.env[FAKE_VAR] = FAKE_VAL;
  });

  afterEach(() => {
    if (savedVal === undefined) delete process.env[FAKE_VAR];
    else process.env[FAKE_VAR] = savedVal;
  });

  test("(d-wire) a *_TOKEN env var is both in the deny set AND a captured needle", () => {
    const denySet = ciEnvDenyNames();
    const captured = captureCiEnvSecrets();
    expect(denySet.has(FAKE_VAR)).toBe(true);
    expect(captured).toContainEqual({ name: FAKE_VAR, value: FAKE_VAL });
  });

  test("(d-wire-predicate) ciEnvDenyPredicate returns true for the same names as ciEnvDenyNames", () => {
    const pred = ciEnvDenyPredicate();
    const denySet = ciEnvDenyNames();
    // Every name in the deny set (captured from current env) must satisfy the predicate.
    for (const name of denySet) {
      expect(pred(name)).toBe(true);
    }
    // Specifically: FAKE_VAR must be caught by the predicate too.
    expect(pred(FAKE_VAR)).toBe(true);
  });

  test("(d-wire-predicate-late) ciEnvDenyPredicate catches a secret-named var set AFTER the Set was built", () => {
    // Build the deny Set now (captures the current env snapshot).
    const denySetAtBuild = ciEnvDenyNames();
    // Build the predicate now (but it's a live rule, not a snapshot).
    const pred = ciEnvDenyPredicate();

    // Add a new secret-named var AFTER both were built.
    const LATE_VAR = "LATE_ADDED_SECRET_TOKEN";
    const savedLate = process.env[LATE_VAR];
    process.env[LATE_VAR] = "late-secret-xyz";
    try {
      // The fixed Set MISSES the late var (expected — that's the known limitation).
      expect(denySetAtBuild.has(LATE_VAR)).toBe(false);
      // The predicate CATCHES it because it applies the rule at call time.
      expect(pred(LATE_VAR)).toBe(true);
    } finally {
      if (savedLate === undefined) delete process.env[LATE_VAR];
      else process.env[LATE_VAR] = savedLate;
    }
  });
});
