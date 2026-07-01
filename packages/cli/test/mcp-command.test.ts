// `fragua mcp ls|check` — the config-driven branches (absent / malformed
// mcp.json, ready vs missing-credential servers, empty list). The live-connect
// path is covered in @fragua/workspace's connector tests; here we avoid
// spawning a subprocess and just pin the CLI's rendering + exit codes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCheckCommand, mcpLsCommand } from "../src/commands/mcp.ts";

function project(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-"));
  writeFileSync(join(cwd, ".mcp.json"), typeof config === "string" ? config : JSON.stringify(config));
  return cwd;
}

let logs: string[];
const realLog = console.log;
beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = realLog;
});

const out = () => logs.join("\n");

describe("mcp ls", () => {
  test("absent mcp.json → exit 0, says none found", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-none-"));
    expect(mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("no mcp.json");
  });

  test("empty server map → says none defined", () => {
    const cwd = project({ mcpServers: {} });
    expect(mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("no servers defined");
  });

  test("ready vs missing-credential servers are distinguished", () => {
    const cwd = project({
      mcpServers: {
        ready: { command: "true" },
        needs: { command: "true", env: { TOK: "${FRAGUA_TEST_ABSENT_VAR}" } },
      },
    });
    expect(mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("ready");
    expect(out()).toContain("missing env");
    expect(out()).toContain("FRAGUA_TEST_ABSENT_VAR");
  });

  test("malformed mcp.json → exit 1 with error", () => {
    const cwd = project("{ broken");
    expect(mcpLsCommand({ cwd })).toBe(1);
  });
});

describe("mcp check", () => {
  test("no mcp.json → exit 1", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-check-none-"));
    expect(await mcpCheckCommand(undefined, { cwd })).toBe(1);
  });

  test("missing-credential server → reported, exit 1, never connects", async () => {
    const cwd = project({ mcpServers: { needs: { command: "true", env: { TOK: "${FRAGUA_TEST_ABSENT_VAR}" } } } });
    expect(await mcpCheckCommand("needs", { cwd })).toBe(1);
    expect(out()).toContain("FRAGUA_TEST_ABSENT_VAR");
  });

  test("empty server map → exit 0", async () => {
    const cwd = project({ mcpServers: {} });
    expect(await mcpCheckCommand(undefined, { cwd })).toBe(0);
  });
});
