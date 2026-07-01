import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, mcpConfigPath, resolveMcpServer } from "../../src/mcp/config.ts";

function projectWith(json: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-cfg-"));
  mkdirSync(join(cwd, ".fragua"), { recursive: true });
  writeFileSync(join(cwd, ".fragua", "mcp.json"), json);
  return cwd;
}

describe("loadMcpConfig", () => {
  test("absent file → ok:false, no error, no servers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-none-"));
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(false);
    expect(load.error).toBeUndefined();
    expect(Object.keys(load.servers)).toEqual([]);
    expect(load.path).toBe(mcpConfigPath(cwd));
  });

  test("malformed JSON → ok:false with error", () => {
    const cwd = projectWith("{ not json ");
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(false);
    expect(load.error).toContain("valid JSON");
  });

  test("missing mcpServers key → error", () => {
    const cwd = projectWith(JSON.stringify({ servers: {} }));
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(false);
    expect(load.error).toContain("mcpServers");
  });

  test("server without command → error naming the server", () => {
    const cwd = projectWith(JSON.stringify({ mcpServers: { github: { args: ["x"] } } }));
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(false);
    expect(load.error).toContain("github");
  });

  test("valid config parses into servers", () => {
    const cwd = projectWith(
      JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "srv"], env: { T: "${TOKEN}" } } } }),
    );
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(true);
    expect(load.servers["github"]?.command).toBe("npx");
    expect(load.servers["github"]?.args).toEqual(["-y", "srv"]);
  });
});

describe("resolveMcpServer", () => {
  test("substitutes ${VAR} from env in command / args / env values", () => {
    const r = resolveMcpServer(
      { command: "${BIN}", args: ["--token=${TOKEN}"], env: { AUTH: "${TOKEN}" } },
      { BIN: "npx", TOKEN: "secret" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.server.command).toBe("npx");
    expect(r.server.args).toEqual(["--token=secret"]);
    expect(r.server.env["AUTH"]).toBe("secret");
  });

  test("unset referenced var → ok:false listing the missing names", () => {
    const r = resolveMcpServer({ command: "npx", env: { AUTH: "${TOKEN}", OTHER: "${MISSING}" } }, {});
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.missing).toContain("TOKEN");
    expect(r.missing).toContain("MISSING");
  });

  test("bare $NAME is literal, not a reference", () => {
    const r = resolveMcpServer({ command: "echo", args: ["$HOME/x"] }, {});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.server.args).toEqual(["$HOME/x"]);
  });
});
