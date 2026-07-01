// `fragua mcp ls|check|login|logout` — the config-driven branches (absent /
// malformed mcp.json, ready vs missing-credential servers, empty list, the
// OAuth-state column, logout round-trip, and login's pre-listener error
// paths). The live-connect path (browser + bound port) is not unit-tested; the
// connector tests in @fragua/workspace cover the transport itself.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { mcpCheckCommand, mcpLoginCommand, mcpLogoutCommand, mcpLsCommand } from "../src/commands/mcp.ts";

function project(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-"));
  writeFileSync(join(cwd, ".mcp.json"), typeof config === "string" ? config : JSON.stringify(config));
  return cwd;
}

/** A fresh migrated store on disk so `withStoreClient` (existsSync gate) opens
 * it; returns its path and closes the handle so the command reopens it. */
function tempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-store-"));
  const path = join(dir, "t.db");
  const store = new SqliteStore({ path });
  store.close();
  return path;
}

function seedStore(dbPath: string, url: string, payload: string): void {
  const store = new SqliteStore({ path: dbPath, migrate: false });
  store.upsertMcpOAuth(url, payload);
  store.close();
}

let logs: string[];
const realLog = console.log;
const realError = console.error;
beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

const out = () => logs.join("\n");

describe("mcp ls", () => {
  test("absent mcp.json → exit 0, says none found", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-cli-mcp-none-"));
    expect(await mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("no mcp.json");
  });

  test("empty server map → says none defined", async () => {
    const cwd = project({ mcpServers: {} });
    expect(await mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("no servers defined");
  });

  test("ready vs missing-credential servers are distinguished", async () => {
    const dbPath = tempStore();
    const cwd = project({
      mcpServers: {
        ready: { command: "true" },
        needs: { command: "true", env: { TOK: "${FRAGUA_TEST_ABSENT_VAR}" } },
      },
    });
    expect(await mcpLsCommand({ cwd, dbPath })).toBe(0);
    expect(out()).toContain("ready");
    expect(out()).toContain("missing env");
    expect(out()).toContain("FRAGUA_TEST_ABSENT_VAR");
  });

  test("malformed mcp.json → exit 1 with error", async () => {
    const cwd = project("{ broken");
    expect(await mcpLsCommand({ cwd })).toBe(1);
  });

  test("http oauth state: ready / logged in / login required", async () => {
    const dbPath = tempStore();
    seedStore(dbPath, "https://loggedin.example.com/mcp", JSON.stringify({ tokens: { access_token: "x" } }));
    const cwd = project({
      mcpServers: {
        stat: { type: "http", url: "https://static.example.com/mcp", headers: { Authorization: "Bearer t" } },
        loggedin: { type: "http", url: "https://loggedin.example.com/mcp" },
        needlogin: { type: "http", url: "https://fresh.example.com/mcp" },
      },
    });
    expect(await mcpLsCommand({ cwd, dbPath })).toBe(0);
    expect(out()).toContain("ready");
    expect(out()).toContain("logged in");
    expect(out()).toContain("login required");
  });
});

describe("mcp logout", () => {
  test("deletes stored OAuth state for the server url", async () => {
    const dbPath = tempStore();
    const url = "https://remote.example.com/mcp";
    seedStore(dbPath, url, JSON.stringify({ tokens: { access_token: "abc" } }));
    const cwd = project({ mcpServers: { remote: { type: "http", url } } });

    expect(await mcpLogoutCommand("remote", { cwd, dbPath })).toBe(0);
    expect(out()).toContain("Logged out of remote");

    const store = new SqliteStore({ path: dbPath, migrate: false });
    expect(store.getMcpOAuth(url)).toBeUndefined();
    store.close();
  });

  test("nothing stored → exit 0 with a notice", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { remote: { type: "http", url: "https://remote.example.com/mcp" } } });
    expect(await mcpLogoutCommand("remote", { cwd, dbPath })).toBe(0);
    expect(out()).toContain("nothing to do");
  });
});

describe("mcp login error paths (no listener / browser)", () => {
  test("unknown server → exit 1, not found", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: {} });
    expect(await mcpLoginCommand("nope", {}, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("not found");
  });

  test("stdio server → exit 1, http-only message", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { local: { command: "true" } } });
    expect(await mcpLoginCommand("local", {}, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("OAuth applies to http servers only");
  });

  test("http server with a static Authorization header → exit 1, no login needed", async () => {
    const dbPath = tempStore();
    const cwd = project({
      mcpServers: {
        remote: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer t" } },
      },
    });
    expect(await mcpLoginCommand("remote", {}, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("no login needed");
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
