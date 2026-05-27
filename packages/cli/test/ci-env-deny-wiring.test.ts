// Integration assertion: `fragua ci` wires envDenyNames from the same
// allowlist as the scrub needles — the "one list, two consumers" contract
// (proposal §15). This test proves a *_TOKEN env var appears in BOTH the
// deny set and the captured needle set without touching the ci command itself.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureCiEnvSecrets, ciEnvDenyNames } from "../src/env-creds.ts";

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
});
