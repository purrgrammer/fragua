// Direct store-client seam for the CLI. Operator verbs, enqueue, and schedule
// ops open the local SQLite store and write through the intent plane (or the
// store's own methods) — no HTTP round-trip, no running-server dependency.
//
// The store path is the harness's global store (`~/.fragua/fragua.db`) by
// default, or an explicit `--db <path>` (the CI primitive). Opened with
// `migrate: false`: a store-client never mutates schema — the harness/daemon
// owns migration. On a missing or schema-mismatched store the open throws,
// which `withStoreClient` turns into an actionable CLI error.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type IntentPlane, makeIntentPlane } from "@fragua/core/intent-plane";
import { makeReadPlane, type ReadPlane } from "@fragua/core/read-plane";
import { newRunId, SqliteStore, type SqliteStore as SqliteStoreType } from "@fragua/store";
import chalk from "chalk";

export interface StoreClientOpts {
  /** Explicit store path. Default `~/.fragua/fragua.db` (the harness store). */
  dbPath?: string;
}

export interface StoreClient {
  store: SqliteStoreType;
  /** Write surface — validate/construct/commit intents. */
  plane: IntentPlane;
  /** Read surface — run summary / detail / step / message projections. */
  readPlane: ReadPlane;
  close(): void;
}

/** Resolve the store path: `--db`, else the harness global store. */
export function resolveStorePath(opts: StoreClientOpts): string {
  return opts.dbPath ? resolve(opts.dbPath) : resolve(homedir(), ".fragua/fragua.db");
}

/** Open the store read/write as a client (no schema migration) and build the
 * intent + read planes over it. Throws if the store is absent or
 * schema-incompatible. */
export function openStoreClient(opts: StoreClientOpts): StoreClient {
  const path = resolveStorePath(opts);
  const store = new SqliteStore({ path, migrate: false });
  const plane = makeIntentPlane({ store, newRunId });
  const readPlane = makeReadPlane({ store });
  return { store, plane, readPlane, close: () => store.close() };
}

/** Run `fn` against an open store-client, mapping a failed open to an actionable
 * CLI error + exit 1, and always closing the connection. */
export async function withStoreClient(
  opts: StoreClientOpts,
  fn: (client: StoreClient) => Promise<number> | number,
): Promise<number> {
  const path = resolveStorePath(opts);
  if (!existsSync(path)) {
    console.error(chalk.red(`no fragua store at ${path}`));
    console.error(chalk.dim("  start the harness (`fragua harness`) to create it, or pass --db <path>"));
    return 1;
  }
  let client: StoreClient;
  try {
    client = openStoreClient(opts);
  } catch (err) {
    console.error(chalk.red(`cannot open store at ${path}: ${(err as Error).message}`));
    return 1;
  }
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
