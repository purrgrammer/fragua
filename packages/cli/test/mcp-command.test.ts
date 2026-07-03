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

  test("OAuth server on a fresh checkout (no store) → login required, exit 0, no db error", async () => {
    const cwd = project({ mcpServers: { remote: { type: "http", url: "https://x.example.com/mcp" } } });
    const absentDb = join(mkdtempSync(join(tmpdir(), "fragua-cli-mcp-nostore-")), "absent.db");
    expect(await mcpLsCommand({ cwd, dbPath: absentDb })).toBe(0);
    expect(out()).toContain("login required");
    expect(out()).not.toContain("no fragua store");
  });

  test("a ${VAR} supplied only via .env.local resolves as ready (mirrors the connector's env view)", async () => {
    const cwd = project({
      mcpServers: { gh: { command: "true", env: { TOK: "${FRAGUA_DOTENV_ONLY_VAR}" } } },
    });
    // Not exported to process.env — only the project's .env.local carries it. The
    // CLI must resolve it like the daemon does, not report "missing env".
    writeFileSync(join(cwd, ".env.local"), "FRAGUA_DOTENV_ONLY_VAR=present\n");
    expect(await mcpLsCommand({ cwd })).toBe(0);
    expect(out()).toContain("ready");
    expect(out()).not.toContain("missing env");
  });

  test("stdio-only project lists without touching the store (works before any store exists)", async () => {
    const cwd = project({
      mcpServers: {
        fs: { command: "true" },
        gh: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${T}" } },
      },
    });
    // Bogus db path: an OAuth-column lookup would open it and fail — none needed here.
    expect(await mcpLsCommand({ cwd, dbPath: "/nonexistent/never.db" })).toBe(0);
    expect(out()).toContain("fs");
    expect(out()).toContain("gh");
  });

  test("http server with a missing static-auth env var shows missing-env, not a false OAuth ready", async () => {
    const cwd = project({
      mcpServers: {
        gh: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${FRAGUA_TEST_ABSENT_VAR}" } },
      },
    });
    expect(await mcpLsCommand({ cwd, dbPath: "/nonexistent/never.db" })).toBe(0);
    expect(out()).toContain("missing env: FRAGUA_TEST_ABSENT_VAR");
    // The OAuth column must NOT render a green "ready" for a row that didn't resolve.
    expect(out()).not.toContain("ready  ready");
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

  test("a token-less row (login interrupted after client registration) reads as login required", async () => {
    const dbPath = tempStore();
    // `runLoginFlow` writes the client-registration row before the browser
    // redirect; a Ctrl-C before the callback leaves this token-less row.
    seedStore(dbPath, "https://reg.example.com/mcp", JSON.stringify({ clientInformation: { client_id: "abc" } }));
    const cwd = project({ mcpServers: { regonly: { type: "http", url: "https://reg.example.com/mcp" } } });
    expect(await mcpLsCommand({ cwd, dbPath })).toBe(0);
    expect(out()).toContain("login required");
    expect(out()).not.toContain("logged in");
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

  test("a client secret with no client id → exit 1 (won't silently fall back to DCR)", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { remote: { type: "http", url: "https://x.example.com/mcp" } } });
    expect(await mcpLoginCommand("remote", { clientSecret: "shh" }, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("without a client id");
  });

  test("OAuth login over plaintext http to a non-loopback host → refused (exit 1)", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { remote: { type: "http", url: "http://remote.example.com/mcp" } } });
    expect(await mcpLoginCommand("remote", {}, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("plaintext http");
  });

  test("SSE (unsupported) server → exit 1, unsupported-transport message (not 'not found')", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { legacy: { type: "sse", url: "https://x.example.com/sse" } } });
    expect(await mcpLoginCommand("legacy", {}, { cwd, dbPath })).toBe(1);
    expect(out()).toContain("unsupported transport");
  });

  test("a FAILED login does not persist the (unvalidated) client credentials", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { remote: { type: "http", url: "https://x.example.com/mcp" } } });
    const code = await mcpLoginCommand(
      "remote",
      { clientId: "1.2", clientSecret: "shh" },
      { cwd, dbPath },
      {
        transportFactory: () => ({
          connect: async () => {
            throw new Error("boom — server unreachable");
          },
          finishAuth: async () => {},
          close: async () => {},
        }),
      },
    );
    expect(code).toBe(1);
    // The bad client_id/secret must NOT reach the store — else the daemon inherits
    // it and every run fails silently against the wrong credentials.
    const store = new SqliteStore({ path: dbPath, migrate: false });
    expect(store.getMcpOAuth("https://x.example.com/mcp")).toBeUndefined();
    store.close();
  });

  test("valid stored token → fast-path connect resolves → exit 0, transport closed", async () => {
    const dbPath = tempStore();
    const cwd = project({ mcpServers: { remote: { type: "http", url: "https://x.example.com/mcp" } } });
    let closed = false;
    const code = await mcpLoginCommand(
      "remote",
      {},
      { cwd, dbPath },
      {
        transportFactory: () => ({
          connect: async () => {},
          finishAuth: async () => {},
          close: async () => {
            closed = true;
          },
        }),
      },
    );
    expect(code).toBe(0);
    expect(closed).toBe(true);
    expect(out()).toContain("Logged in to remote");
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
