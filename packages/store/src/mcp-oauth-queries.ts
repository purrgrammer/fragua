// SQL + typed helpers for the `mcp_oauth` table.
//
// Mirrors `provider-credentials-queries.ts`: every literal SQL string touching
// `mcp_oauth` lives here. `store.ts` owns the transaction boundary; the
// `payload` is an opaque JSON string the store never parses, so this module
// stays free of JSON.stringify / parse calls and invariant I1 (no
// JSON.stringify inside write transactions) is structurally guaranteed.

import type { Database } from "bun:sqlite";

export interface McpOAuthDbRow {
  url: string;
  payload: string;
  created_at: number;
  updated_at: number;
}

const SELECT_MCP_OAUTH_SQL = `
  SELECT url, payload, created_at, updated_at
    FROM mcp_oauth
   WHERE url = ?
`;

export function selectMcpOAuth(db: Database, url: string): McpOAuthDbRow | null {
  return db.query<McpOAuthDbRow, [string]>(SELECT_MCP_OAUTH_SQL).get(url) ?? null;
}

const SELECT_ALL_MCP_OAUTH_SQL = `
  SELECT url, payload, created_at, updated_at
    FROM mcp_oauth
   ORDER BY url ASC
`;

export function selectAllMcpOAuth(db: Database): McpOAuthDbRow[] {
  return db.query<McpOAuthDbRow, []>(SELECT_ALL_MCP_OAUTH_SQL).all();
}

// `created_at` is intentionally absent from the UPDATE clause: a conflict
// preserves the original insert timestamp. `updated_at` always advances.
const UPSERT_MCP_OAUTH_SQL = `
  INSERT INTO mcp_oauth (url, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
      payload    = excluded.payload,
      updated_at = excluded.updated_at
`;

export function upsertMcpOAuth(
  db: Database,
  args: {
    url: string;
    payload: string;
    now: number;
  },
): void {
  db.query(UPSERT_MCP_OAUTH_SQL).run(args.url, args.payload, args.now, args.now);
}

const DELETE_MCP_OAUTH_SQL = `
  DELETE FROM mcp_oauth WHERE url = ?
`;

export function deleteMcpOAuth(db: Database, url: string): void {
  db.query(DELETE_MCP_OAUTH_SQL).run(url);
}
