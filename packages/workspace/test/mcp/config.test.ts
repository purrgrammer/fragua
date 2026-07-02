import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, loadProjectEnv, mcpConfigPath, resolveMcpServer } from "../../src/mcp/config.ts";

function projectWith(json: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-cfg-"));
  writeFileSync(join(cwd, ".mcp.json"), json);
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
    const g = load.servers["github"];
    expect(g?.transport).toBe("stdio");
    if (g?.transport !== "stdio") throw new Error("expected stdio");
    expect(g.command).toBe("npx");
    expect(g.args).toEqual(["-y", "srv"]);
  });

  test("reads .mcp.json from the project root (not .fragua/)", () => {
    const cwd = projectWith(JSON.stringify({ mcpServers: { fs: { command: "true" } } }));
    expect(mcpConfigPath(cwd)).toBe(join(cwd, ".mcp.json"));
    const s = loadMcpConfig(cwd).servers["fs"];
    expect(s?.transport === "stdio" && s.command).toBe("true");
  });

  test("http entries parse as http servers; sse is tolerated-but-unsupported", () => {
    const cwd = projectWith(
      JSON.stringify({
        mcpServers: {
          local: { command: "true" },
          github: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${T}" } },
          bare: { url: "https://example.com/mcp" },
          legacy: { type: "sse", url: "https://example.com/sse" },
        },
      }),
    );
    const load = loadMcpConfig(cwd);
    expect(load.ok).toBe(true);
    expect(Object.keys(load.servers).sort()).toEqual(["bare", "github", "local"]);
    expect(load.servers["github"]?.transport).toBe("http");
    expect(load.servers["bare"]?.transport).toBe("http");
    expect(load.unsupported["legacy"]).toContain("sse");
  });
});

describe("loadProjectEnv", () => {
  test(".env.local overrides .env; comments / export / quotes handled", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-env-"));
    writeFileSync(join(cwd, ".env"), '# base config\nFOO=base\nexport BAR="quoted"\nBAZ=only-in-env\n');
    writeFileSync(join(cwd, ".env.local"), "FOO=local\nTOK='sek ret'\n");
    const env = loadProjectEnv(cwd);
    expect(env["FOO"]).toBe("local"); // .env.local overrides .env
    expect(env["BAR"]).toBe("quoted"); // export prefix + double quotes stripped
    expect(env["BAZ"]).toBe("only-in-env");
    expect(env["TOK"]).toBe("sek ret"); // single quotes preserve the space
  });

  test("absent files → empty record", () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-env-none-"));
    expect(loadProjectEnv(cwd)).toEqual({});
  });
});

describe("resolveMcpServer", () => {
  test("substitutes ${VAR} from env in command / args / env values", () => {
    const r = resolveMcpServer(
      { transport: "stdio", command: "${BIN}", args: ["--token=${TOKEN}"], env: { AUTH: "${TOKEN}" } },
      { BIN: "npx", TOKEN: "secret" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.server.transport !== "stdio") throw new Error("expected stdio ok");
    expect(r.server.command).toBe("npx");
    expect(r.server.args).toEqual(["--token=secret"]);
    expect(r.server.env["AUTH"]).toBe("secret");
  });

  test("substitutes ${VAR} in http url + header values", () => {
    const r = resolveMcpServer(
      { transport: "http", url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
      { HOST: "api.example.com", TOKEN: "pat123" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok || r.server.transport !== "http") throw new Error("expected http ok");
    expect(r.server.url).toBe("https://api.example.com/mcp");
    expect(r.server.headers["Authorization"]).toBe("Bearer pat123");
  });

  test("http server with an unset header var → skipped (missing listed)", () => {
    const r = resolveMcpServer(
      { transport: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ${ABSENT}" } },
      {},
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.missing).toContain("ABSENT");
  });

  test("unset referenced var → ok:false listing the missing names", () => {
    const r = resolveMcpServer(
      { transport: "stdio", command: "npx", env: { AUTH: "${TOKEN}", OTHER: "${MISSING}" } },
      {},
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected err");
    expect(r.missing).toContain("TOKEN");
    expect(r.missing).toContain("MISSING");
  });

  test("bare $NAME is literal, not a reference", () => {
    const r = resolveMcpServer({ transport: "stdio", command: "echo", args: ["$HOME/x"] }, {});
    expect(r.ok).toBe(true);
    if (!r.ok || r.server.transport !== "stdio") throw new Error("expected stdio ok");
    expect(r.server.args).toEqual(["$HOME/x"]);
  });
});
