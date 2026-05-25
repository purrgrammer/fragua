// retainPortableTables — the prune `fragua ci` runs before it leaves a `--db`
// artifact behind. The secret-bearing + instance-scoped tables go; the
// portable, replayable run record stays. Guards against a credential riding
// out in an uploaded store.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { freshStore, seedRun } from "./helpers.ts";

function tableNames(store: unknown): string[] {
  const db = (store as { db: Database }).db;
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
}

const PORTABLE = ["artifacts", "blobs", "events", "messages", "run_state", "schema_version", "workflows"];

describe("retainPortableTables", () => {
  test("drops credential + instance tables, keeps the portable run record", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    // What `fragua ci` seeds from the environment.
    store.upsertProviderCredential({
      provider: "anthropic",
      kind: "api_key",
      payload: JSON.stringify({ type: "api_key", key: "sk-ant-test-SECRET-do-not-leak" }),
    });
    expect(store.getProviderCredential("anthropic")).not.toBeNull();
    expect(tableNames(store)).toContain("provider_credentials");

    store.retainPortableTables();

    // Exactly the portable allowlist remains — provider_credentials,
    // provider_config, daemon_lock, server_endpoint, daemon_events, schedules
    // are all gone.
    expect(tableNames(store).sort()).toEqual([...PORTABLE].sort());
    // The run record survived the prune and is still readable.
    expect(store.getState(runId)).not.toBeNull();

    store.close();
  });

  test("is idempotent — re-pruning a portable store is a no-op", async () => {
    const store = freshStore();
    await seedRun(store);
    store.retainPortableTables();
    const after = tableNames(store).sort();
    store.retainPortableTables();
    expect(tableNames(store).sort()).toEqual(after);
    store.close();
  });
});
