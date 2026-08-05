import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { LocalEnvironment } from "../../src/local-env.ts";
import type { ResolvedMcpServer } from "../../src/mcp/config.ts";
import {
  createMcpConnector,
  isMcpToolName,
  mcpToolName,
  mcpToolPrefix,
  needsOAuthProvider,
  normalizeMcpToolRef,
} from "../../src/mcp/connector.ts";
import { type McpOAuthStore, StoredOAuthProvider } from "../../src/mcp/oauth.ts";

const ECHO_SERVER = join(import.meta.dir, "echo-server.ts");
const BAD_LIST_SERVER = join(import.meta.dir, "bad-list-server.ts");
const COLLIDE_SERVER = join(import.meta.dir, "collide-server.ts");
const UNSORTED_SERVER = join(import.meta.dir, "unsorted-server.ts");

function projectWith(config: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-conn-"));
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(config));
  return cwd;
}

describe("mcpToolName", () => {
  test("mcp__<server>__<tool> with slugified segments", () => {
    expect(mcpToolName("github", "create_issue")).toBe("mcp__github__create_issue");
    expect(mcpToolName("My-Server", "Do.Thing")).toBe("mcp__my_server__do_thing");
  });

  test("caps at 128 chars, keeps a non-empty tool suffix, and matches its server prefix", () => {
    const long = mcpToolName("s".repeat(200), "t".repeat(200));
    expect(long.length).toBeLessThanOrEqual(128);
    // Segment-capped, not string-sliced: the `__` separator survives and the
    // name still begins with the server's prefix (so willMaterialise matches).
    expect(long.startsWith(mcpToolPrefix("s".repeat(200)))).toBe(true);
    // A reserved tool-slug budget means an over-long server name can't collapse
    // every tool to the identical `mcp__<slug>__` (which dedup would drop).
    const toolSuffix = long.slice(mcpToolPrefix("s".repeat(200)).length);
    expect(toolSuffix.length).toBeGreaterThan(0);
    expect(mcpToolName("s".repeat(200), "alpha")).not.toBe(mcpToolName("s".repeat(200), "beta"));
  });
});

describe("mcpToolPrefix", () => {
  test("is a prefix of the server's tool names", () => {
    const p = mcpToolPrefix("github");
    expect(p).toBe("mcp__github__");
    expect(mcpToolName("github", "create_issue").startsWith(p)).toBe(true);
  });

  test("preserves the trailing __ separator even for an over-long server slug", () => {
    const p = mcpToolPrefix("s".repeat(200));
    expect(p.length).toBeLessThanOrEqual(128);
    expect(p.endsWith("__")).toBe(true); // capping the slug, not the whole string
  });
});

describe("normalizeMcpToolRef", () => {
  test("folds a case/hyphen variant to the materialised slug form", () => {
    expect(normalizeMcpToolRef("mcp__My-Server__DeleteRepo")).toBe("mcp__my_server__deleterepo");
    expect(normalizeMcpToolRef("mcp__My-Server__DeleteRepo")).toBe(mcpToolName("My-Server", "DeleteRepo"));
  });

  test("passes non-MCP (core) names through untouched", () => {
    expect(normalizeMcpToolRef("read")).toBe("read");
    expect(isMcpToolName("read")).toBe(false);
  });

  test("caps the server slug so a long-named allow entry still matches its tool name", () => {
    const longServer = "s".repeat(200);
    expect(normalizeMcpToolRef(`mcp__${longServer}__echo`)).toBe(mcpToolName(longServer, "echo"));
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

  test("static Authorization header over plaintext http to a non-loopback host → refused, no token leak", async () => {
    const cwd = projectWith({
      mcpServers: {
        proxy: { type: "http", url: "http://insecure.example.com/mcp", headers: { Authorization: "Bearer secret" } },
      },
    });
    const set = await createMcpConnector().materialize(["proxy"], { cwd });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toMatch(/plaintext http/i);
    await set.dispose();
  });

  test("a custom credential header (X-Api-Key) over plaintext http to a non-loopback host → refused", async () => {
    // No Authorization header and no OAuth factory (the `mcp check` path) — the
    // guard must still refuse, since any header over plaintext leaks.
    const cwd = projectWith({
      mcpServers: {
        proxy: { type: "http", url: "http://insecure.example.com/mcp", headers: { "X-Api-Key": "sk-secret" } },
      },
    });
    const set = await createMcpConnector().materialize(["proxy"], { cwd });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toMatch(/plaintext http/i);
    await set.dispose();
  });

  test("OAuth over plaintext http to a non-loopback host → refused before any provider call", async () => {
    const cwd = projectWith({ mcpServers: { remote: { type: "http", url: "http://insecure.example.com/mcp" } } });
    let asked = false;
    const oauthProviderFor = (): OAuthClientProvider | undefined => {
      asked = true;
      return undefined;
    };
    const set = await createMcpConnector({ oauthProviderFor }).materialize(["remote"], { cwd, connectTimeoutMs: 500 });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toMatch(/plaintext http/i);
    expect(asked).toBe(false); // refused before the token would be attached
    await set.dispose();
  });

  test("requesting an sse (deprecated) server → unsupported-transport error, no connect", async () => {
    const cwd = projectWith({ mcpServers: { legacy: { type: "sse", url: "https://example.com/sse" } } });
    const set = await createMcpConnector().materialize(["legacy"], { cwd });
    expect(set.tools).toEqual([]);
    expect(set.errors[0]?.message).toContain("unsupported transport");
    await set.dispose();
  });

  test("malformed mcp.json → requested servers skipped with error", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fragua-mcp-bad-"));
    writeFileSync(join(cwd, ".mcp.json"), "{ broken");
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
      // Output is returned as-is (MCP servers are trusted; no envelope).
      expect(ok.text).toBe("echo: hi");
      expect(ok.is_error).toBeUndefined();

      const err = await tool.execute({ text: "__error__" }, new LocalEnvironment());
      expect(err.is_error).toBe(true);
    } finally {
      await set.dispose();
    }
  }, 30_000);

  test("a callTool timeout/transport error → is_error result, not an uncaught throw", async () => {
    const cwd = projectWith({ mcpServers: { echo: { command: process.execPath, args: [ECHO_SERVER] } } });
    const set = await createMcpConnector().materialize(["echo"], { cwd, callTimeoutMs: 500 });
    try {
      const tool = set.tools[0];
      if (!tool) throw new Error("no tool");
      const out = await tool.execute({ text: "__hang__" }, new LocalEnvironment());
      expect(out.is_error).toBe(true);
      expect(out.text).toContain("failed");
    } finally {
      await set.dispose();
    }
  }, 30_000);

  test("multiple servers connect concurrently; tools appear in request order", async () => {
    const cwd = projectWith({
      mcpServers: {
        alpha: { command: process.execPath, args: [ECHO_SERVER] },
        beta: { command: process.execPath, args: [ECHO_SERVER] },
      },
    });
    const set = await createMcpConnector().materialize(["alpha", "beta"], { cwd });
    try {
      expect(set.errors).toEqual([]);
      expect(set.tools.map((t) => t.name)).toEqual(["mcp__alpha__echo", "mcp__beta__echo"]);
    } finally {
      await set.dispose();
    }
  }, 30_000);

  test("a server's tools/list order does not leak — tools are name-sorted", async () => {
    // Tool definitions are the first segment of the provider's prompt-cache
    // prefix, so an order chosen by the server (and free to change on any
    // version bump) would silently invalidate every downstream segment.
    const cwd = projectWith({ mcpServers: { u: { command: process.execPath, args: [UNSORTED_SERVER] } } });
    const set = await createMcpConnector().materialize(["u"], { cwd });
    try {
      expect(set.errors).toEqual([]);
      // Server advertises zebra, apple, mango, banana — in that order.
      expect(set.tools.map((t) => t.name)).toEqual([
        "mcp__u__apple",
        "mcp__u__banana",
        "mcp__u__mango",
        "mcp__u__zebra",
      ]);
    } finally {
      await set.dispose();
    }
  }, 30_000);

  test("two tools slugging to the same name → first wins, collision reported", async () => {
    const cwd = projectWith({ mcpServers: { collide: { command: process.execPath, args: [COLLIDE_SERVER] } } });
    const set = await createMcpConnector().materialize(["collide"], { cwd });
    try {
      expect(set.tools.map((t) => t.name)).toEqual(["mcp__collide__a_b"]);
      // WHICH descriptor wins is decided by the sort, not by the server's
      // response order. Both slug to `mcp__collide__a_b`, so the slug keys
      // tie and the raw-name tiebreak decides: `a-b` (0x2D) sorts before
      // `a.b` (0x2E), making the second-advertised tool the survivor. Pinned
      // because the winner is otherwise invisible from the tool name alone.
      expect(set.tools[0]?.description).toBe("second (collides)");
      expect(set.errors).toHaveLength(1);
      expect(set.errors[0]?.kind).toBe("collision");
      // The error names BOTH sides — the dropped raw name and the survivor —
      // so "which descriptor am I actually calling?" is answerable from the log.
      expect(set.errors[0]?.message).toContain('"a.b"');
      expect(set.errors[0]?.message).toContain('"a-b"');
      expect(set.errors[0]?.message).toContain("mcp__collide__a_b");
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

const httpServer = (headers: Record<string, string>): ResolvedMcpServer => ({
  transport: "http",
  url: "https://mcp.example.com/mcp",
  headers,
});

describe("needsOAuthProvider", () => {
  const factory = () => undefined;

  test("http server with no Authorization header → wants a provider", () => {
    expect(needsOAuthProvider(httpServer({}), factory)).toBe(true);
  });

  test("Authorization header (any case) suppresses the provider — static auth wins", () => {
    expect(needsOAuthProvider(httpServer({ Authorization: "Bearer x" }), factory)).toBe(false);
    expect(needsOAuthProvider(httpServer({ authorization: "Bearer x" }), factory)).toBe(false);
    expect(needsOAuthProvider(httpServer({ AUTHORIZATION: "Bearer x" }), factory)).toBe(false);
  });

  test("no factory or non-http transport → never wants a provider", () => {
    expect(needsOAuthProvider(httpServer({}), undefined)).toBe(false);
    expect(needsOAuthProvider({ transport: "stdio", command: "true", args: [], env: {} }, factory)).toBe(false);
  });
});

describe("createMcpConnector.materialize — oauth provider selection", () => {
  test("http server WITHOUT Authorization requests a provider for its url; a static-auth one does NOT", async () => {
    const cwd = projectWith({
      mcpServers: {
        oauthed: { type: "http", url: "http://127.0.0.1:41999/mcp" },
        static: { type: "http", url: "http://127.0.0.1:41998/mcp", headers: { Authorization: "Bearer tok" } },
      },
    });
    const seen: string[] = [];
    const oauthProviderFor = (url: string): OAuthClientProvider | undefined => {
      seen.push(url);
      return undefined;
    };
    const set = await createMcpConnector({ oauthProviderFor }).materialize(["oauthed", "static"], {
      cwd,
      connectTimeoutMs: 500,
    });
    // The un-authed server asked for a provider by its url; the static-auth one never did.
    expect(seen).toEqual(["http://127.0.0.1:41999/mcp"]);
    await set.dispose();
  }, 30_000);

  test("daemon-style throwing onRedirect → server reported in errors, materialize resolves", async () => {
    const cwd = projectWith({ mcpServers: { oauthed: { type: "http", url: "http://127.0.0.1:41997/mcp" } } });
    const port: McpOAuthStore = { load: () => undefined, save: () => {}, clear: () => {} };
    const oauthProviderFor = (url: string): OAuthClientProvider =>
      new StoredOAuthProvider({
        url,
        store: port,
        redirectUrl: "http://127.0.0.1:41765/callback",
        onRedirect: () => {
          throw new Error(`MCP server ${url} requires OAuth`);
        },
      });
    // No live server → connect fails and the server is reported, never thrown.
    const set = await createMcpConnector({ oauthProviderFor }).materialize(["oauthed"], {
      cwd,
      connectTimeoutMs: 500,
    });
    expect(set.tools).toEqual([]);
    expect(set.errors).toHaveLength(1);
    expect(set.errors[0]?.server).toBe("oauthed");
    await set.dispose();
  }, 30_000);
});
