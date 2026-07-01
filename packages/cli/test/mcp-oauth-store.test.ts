import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { makeMcpOAuthStore } from "../src/mcp-oauth-store.ts";

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fragua-mcp-oauth-store-"));
  store = new SqliteStore({ path: join(dir, "t.db") });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("makeMcpOAuthStore", () => {
  test("round-trips load / save / clear against the store's mcp_oauth methods", () => {
    const port = makeMcpOAuthStore(store);
    const url = "https://mcp.example.com/sse";

    expect(port.load(url)).toBeUndefined();

    const payload = JSON.stringify({ tokens: { access_token: "abc", token_type: "bearer" } });
    port.save(url, payload);
    expect(port.load(url)).toBe(payload);

    port.clear(url);
    expect(port.load(url)).toBeUndefined();
  });
});
