// Every workflow fragua itself SHIPS must pass `fragua validate` — the parser +
// lint path, no execution. A schema change that breaks a shipped workflow fails
// CI here, not in a user's quickstart. The suite enumerates every
// `.fragua/workflows/*.yaml` in the repo and drives the real `validateCommand`
// (the same code `fragua validate` runs) against each, asserting exit 0.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCommand } from "../src/commands/validate.ts";

const workflowsDir = join(import.meta.dir, "../../../.fragua/workflows");
const files = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

describe("shipped workflows validate", () => {
  let home: string;
  let prevHome: string | undefined;
  let logs: string[];

  beforeEach(() => {
    // FRAGUA_HOME → a temp dir so the store-free validate can never resolve or
    // touch the operator's live ~/.fragua.
    home = mkdtempSync(join(tmpdir(), "fragua-home-"));
    prevHome = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = home;
    logs = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("there is at least one shipped workflow to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} passes fragua validate`, async () => {
      const code = await validateCommand(join(workflowsDir, file));
      if (code !== 0) throw new Error(`validate ${file} exited ${code}:\n${logs.join("\n")}`);
      expect(code).toBe(0);
    });
  }
});
