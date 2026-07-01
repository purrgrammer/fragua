import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../../src/local-env.ts";
import { createMcpConnector, mcpToolName } from "../../src/mcp/connector.ts";

const ECHO_SERVER = join(import.meta.dir, "echo-server.ts");
const BAD_LIST_SERVER = join(import.meta.dir, "bad-list-server.ts");

function projectWith(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-conn-"));
  mkdirSync(join(cwd, ".fragua"), { recursive: true });
  writeFileSync(join(cwd, ".fragua", "mcp.json"), JSON.stringify(config));
  return cwd;
}

describe("mcpToolName", () => {
  test("mcp__<server>__<tool> with slugified segments", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("My-Server", "Do.Thing")).toBe("mcp__my_server__do_thing");
  });

  test("caps at 128 chars", () => {
    const long = mcpToolName("s".repeat(200), "t".repeat(200));
    expect(long.length).toBeLessThanOrEqual(128);
  });
});

describe("createMcpConnector.materialize — error paths", () => {
  test("no mcp.json → every requested server reported, no tools", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-empty-"));
    const set = await createMcpConnector().materialize(["github"], { cwd });
    expect(set.tools).toEqual([]);
    expect(set.errors).toHaveLength(1);
    expect(set.errors[0]?.server).toBe("github");
    await set.dispose();
  });

  test("undefined server → not-defined error", async () => {
    const cwd = projectWith({ mcpServers: { other: { command: "true" } } });
    const set = await createMcpConnector().materialize(["github"], { cwd });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toContain("not defined");
    await set.dispose();
  });

  test("missing credential → skipped with missing-env error, never connects", async () => {
    const cwd = projectWith({ mcpServers: { gh: { command: "true", env: { TOKEN: "${ABSENT_VAR}" } } } });
    const set = await createMcpConnector().materialize(["gh"], { cwd, env: {} });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toContain("ABSENT_VAR");
    await set.dispose();
  });

  test("malformed mcp.json → requested servers skipped with error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-bad-"));
    mkdirSync(join(cwd, ".fragua"), { recursive: true });
    writeFileSync(join(cwd, ".fragua", "mcp.json"), "{ broken");
    const set = await createMcpConnector().materialize(["gh"], { cwd });
    expect(set.errors[0]?.server).toBe("gh");
    await set.dispose();
  });
});

describe("createMcpConnector.materialize — live stdio server", () => {
  test("connects, materialises tools, routes callTool, tears down", async () => {
    const cwd = projectWith({ mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER] } } });
    const set = await createMcpConnector().materialize(["echo"], { cwd });
    try {
      expect(set.errors).toEqual([]);
      expect(set.tools.map((t) => t.name)).toEqual(["mcp__echo__echo"]);

      const tool = set.tools[0];
      if (!tool) throw new Error("no tool materialised");
      expect(tool.idempotent).toBe(false);
      // Raw JSON-Schema inputSchema flows through as `parameters`.
      expect((tool.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty("text");

      const ok = await tool.execute({ text: "hi" }, new LocalEnvironment());
      expect(ok.text).toBe("echo: hi");
      expect(ok.is_error).toBeUndefined();

      const err = await tool.execute({ text: "__error__" }, new LocalEnvironment());
      expect(err.is_error).toBe(true);
    } finally {
      await set.dispose();
    }
  }, 30_000);

  test("server that connects but fails listTools → error recorded, no tools, never throws", async () => {
    const cwd = projectWith({ mcpServers: { bad: { command: process.execPath, args: [BAD_LIST_SERVER] } } });
    // Must resolve (not reject): a post-connect listTools failure is caught,
    // the client closed (no orphaned child), and the server reported in errors.
    const set = await createMcpConnector().materialize(["bad"], { cwd });
    try {
      expect(set.tools).toEqual([]);
      expect(set.errors).toHaveLength(1);
      expect(set.errors[0]?.server).toBe("bad");
      expect(set.errors[0]?.message).toContain("failed to connect");
    } finally {
      await set.dispose();
    }
  }, 30_000);
});
