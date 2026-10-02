// $FRAGUA_HOME must redirect every CLI store + workflow-directory resolver
// together: the harness bind (`resolveHarnessDbPath`), the store-client default
// (`resolveStorePath`), and the global workflow lookup (`globalWorkflowsDir`).
// Before the fix the harness bound `~/.fragua/fragua.db` while run/providers/db
// resolved `$FRAGUA_HOME/fragua.db`, so enqueued runs went to an unwatched store.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveHarnessDbPath } from "../src/commands/harness.ts";
import { resolveStorePath } from "../src/store-client.ts";
import { globalWorkflowsDir } from "../src/workflow-path.ts";

describe("$FRAGUA_HOME store/workflow resolution", () => {
  const saved = process.env["FRAGUA_HOME"];
  const tmpHome = resolve(tmpdir(), "fragua-home-resolver");

  beforeEach(() => {
    process.env["FRAGUA_HOME"] = tmpHome;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = saved;
  });

  test("harness dbPath resolves under $FRAGUA_HOME", () => {
    expect(resolveHarnessDbPath()).toBe(resolve(tmpHome, "fragua.db"));
  });

  test("resolveStorePath resolves under $FRAGUA_HOME", () => {
    expect(resolveStorePath({})).toBe(resolve(tmpHome, "fragua.db"));
  });

  test("globalWorkflowsDir resolves under $FRAGUA_HOME", () => {
    expect(globalWorkflowsDir()).toBe(resolve(tmpHome, "workflows"));
  });

  test("unset $FRAGUA_HOME falls back to ~/.fragua for all three", () => {
    delete process.env["FRAGUA_HOME"];
    expect(resolveHarnessDbPath()).toBe(resolve(homedir(), ".fragua", "fragua.db"));
    expect(resolveStorePath({})).toBe(resolve(homedir(), ".fragua", "fragua.db"));
    expect(globalWorkflowsDir()).toBe(resolve(homedir(), ".fragua", "workflows"));
  });

  test("explicit --db/dbPath overrides $FRAGUA_HOME", () => {
    const dbPath = resolve(tmpdir(), "fragua-explicit", "t.db");
    expect(resolveHarnessDbPath(dbPath)).toBe(dbPath);
    expect(resolveStorePath({ dbPath })).toBe(dbPath);
  });
});
