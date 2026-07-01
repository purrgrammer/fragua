// Tests for the `mcp_oauth` store API — per-server OAuth state for remote
// (http) MCP servers, stored as an opaque JSON payload keyed by server URL.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/migrations.ts";
import { applyCreationPragmas, applyPragmas } from "../src/pragmas.ts";
import { SqliteStore } from "../src/store.ts";

function freshStore(): SqliteStore {
  return new SqliteStore();
}

describe("mcp_oauth store API", () => {
  test("upsert → get → list → delete round-trips a payload", () => {
    const store = freshStore();
    try {
      const url = "https://mcp.example.com/sse";
      const payload = JSON.stringify({ client: { id: "abc" }, tokens: { access: "tok" } });
      store.upsertMcpOAuth(url, payload);

      expect(store.getMcpOAuth(url)).toBe(payload);

      const list = store.listMcpOAuth();
      expect(list).toEqual([{ url, payload }]);

      store.deleteMcpOAuth(url);
      expect(store.getMcpOAuth(url)).toBeUndefined();
      expect(store.listMcpOAuth()).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("getMcpOAuth returns undefined for an unknown url", () => {
    const store = freshStore();
    try {
      expect(store.getMcpOAuth("https://unknown.example.com")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("upsert on conflict replaces the payload for the same url", () => {
    const store = freshStore();
    try {
      const url = "https://mcp.example.com";
      store.upsertMcpOAuth(url, JSON.stringify({ v: 1 }));
      store.upsertMcpOAuth(url, JSON.stringify({ v: 2 }));

      expect(store.getMcpOAuth(url)).toBe(JSON.stringify({ v: 2 }));
      expect(store.listMcpOAuth()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("listMcpOAuth returns all rows ordered by url", () => {
    const store = freshStore();
    try {
      store.upsertMcpOAuth("https://b.example.com", JSON.stringify({ n: "b" }));
      store.upsertMcpOAuth("https://a.example.com", JSON.stringify({ n: "a" }));
      store.upsertMcpOAuth("https://c.example.com", JSON.stringify({ n: "c" }));

      expect(store.listMcpOAuth().map((r) => r.url)).toEqual([
        "https://a.example.com",
        "https://b.example.com",
        "https://c.example.com",
      ]);
    } finally {
      store.close();
    }
  });

  test("deleteMcpOAuth is idempotent", () => {
    const store = freshStore();
    try {
      const url = "https://mcp.example.com";
      store.upsertMcpOAuth(url, JSON.stringify({ v: 1 }));
      store.deleteMcpOAuth(url);
      expect(() => store.deleteMcpOAuth(url)).not.toThrow();
      expect(store.getMcpOAuth(url)).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("a freshly-migrated DB includes the mcp_oauth table", () => {
    const db = new Database(":memory:");
    applyCreationPragmas(db);
    applyPragmas(db);
    migrate(db);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("mcp_oauth");
    db.close();
  });
});
