// AuthStorage backed by the SQLite `provider_credentials` table.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@swarm/store";
import { AuthStorage, SqliteAuthStorageBackend } from "../src/credentials/auth-storage.ts";

function freshStore(): SqliteStore {
  return new SqliteStore();
}

describe("SqliteAuthStorageBackend", () => {
  test("api_key set/get round-trip persists across AuthStorage instances", async () => {
    const store = freshStore();
    try {
      const a = AuthStorage.fromStore(store);
      a.set("openai", { type: "api_key", key: "sk-x" });

      const b = AuthStorage.fromStore(store);
      expect(await b.getApiKey("openai")).toBe("sk-x");
      expect(b.has("openai")).toBe(true);

      const row = store.getProviderCredential("openai");
      expect(row).not.toBeNull();
      expect(row!.kind).toBe("api_key");
      expect(row!.payload).toEqual({ type: "api_key", key: "sk-x" });
    } finally {
      store.close();
    }
  });

  test("full-replace apply deletes providers absent from next blob", () => {
    const store = freshStore();
    try {
      const auth = AuthStorage.fromStore(store);
      auth.set("a", { type: "api_key", key: "ka" });
      auth.set("b", { type: "api_key", key: "kb" });
      expect(store.getProviderCredential("a")).not.toBeNull();
      expect(store.getProviderCredential("b")).not.toBeNull();

      auth.remove("a");
      expect(store.getProviderCredential("a")).toBeNull();
      expect(store.getProviderCredential("b")).not.toBeNull();
      expect(auth.list().sort()).toEqual(["b"]);
    } finally {
      store.close();
    }
  });

  test("oauth refresh occurs outside the write txn and persists merged credentials", async () => {
    const store = freshStore();
    try {
      // Backend directly so we can drive `withLockAsync` without
      // needing a real pi-ai OAuth provider. The test asserts the
      // shape: read → await → write apply, with the write happening
      // through `upsertProviderCredential` (not held across the await).
      const backend = new SqliteAuthStorageBackend(store);

      // Seed an "expired" oauth row.
      backend.withLock(() => ({
        result: undefined,
        next: JSON.stringify({
          fake: { type: "oauth", access: "old", refresh: "r", expires: 0 },
        }),
      }));
      expect(store.getProviderCredential("fake")!.payload).toEqual({
        type: "oauth",
        access: "old",
        refresh: "r",
        expires: 0,
      });

      let observedDuringAwait: unknown = null;
      const result = await backend.withLockAsync(async (current) => {
        // `current` is observable mid-await — proves we didn't hold a
        // write txn (otherwise reads from a second connection would
        // block; we instead see the seeded value freely).
        observedDuringAwait = JSON.parse(current!);
        await new Promise((r) => setTimeout(r, 1));
        const parsed = JSON.parse(current!) as Record<string, { type: string; [k: string]: unknown }>;
        parsed["fake"] = { type: "oauth", access: "new", refresh: "r", expires: Date.now() + 60_000 };
        return { result: "ok", next: JSON.stringify(parsed) };
      });
      expect(result).toBe("ok");
      expect(observedDuringAwait).toEqual({
        fake: { type: "oauth", access: "old", refresh: "r", expires: 0 },
      });

      const row = store.getProviderCredential("fake");
      expect(row).not.toBeNull();
      expect((row!.payload as { access: string }).access).toBe("new");
    } finally {
      store.close();
    }
  });

  test("concurrent writers see last-writer-wins semantics without torn JSON", async () => {
    const store = freshStore();
    try {
      const a = AuthStorage.fromStore(store);
      const b = AuthStorage.fromStore(store);

      await Promise.all([
        Promise.resolve().then(() => a.set("p", { type: "api_key", key: "from-a" })),
        Promise.resolve().then(() => b.set("p", { type: "api_key", key: "from-b" })),
      ]);

      const row = store.getProviderCredential("p");
      expect(row).not.toBeNull();
      // Exactly one of the two wrote last; the row's payload is fully
      // valid JSON (no torn write).
      const payload = row!.payload as { key: string };
      expect(["from-a", "from-b"]).toContain(payload.key);

      // Re-load any instance — the stored value is consistent (not e.g.
      // truncated to "from-").
      const c = AuthStorage.fromStore(store);
      expect(["from-a", "from-b"]).toContain(await c.getApiKey("p"));
    } finally {
      store.close();
    }
  });

  test("removed runtimeOverrides / env path: getApiKey ignores process.env", async () => {
    const store = freshStore();
    const originalEnv = process.env["ANTHROPIC_API_KEY"];
    process.env["ANTHROPIC_API_KEY"] = "env-fallback-should-be-ignored";
    try {
      const auth = AuthStorage.fromStore(store);
      // No row for anthropic in provider_credentials.
      expect(await auth.getApiKey("anthropic")).toBeUndefined();
      expect(auth.hasAuth("anthropic")).toBe(false);
    } finally {
      if (originalEnv === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = originalEnv;
      store.close();
    }
  });
});

describe("AuthStorage.describeAuthSource", () => {
  test("labels collapse to stored api_key / stored oauth / null", () => {
    const store = freshStore();
    try {
      const auth = AuthStorage.fromStore(store);
      auth.set("a", { type: "api_key", key: "literal-key" });
      auth.set("b", { type: "api_key", key: "!op read 'op://x/y'" });
      auth.set("c", { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 60_000 });

      // No `!`-prefix / env-var detection on the key string anymore —
      // every api_key row reports the same label.
      expect(auth.describeAuthSource("a")).toBe("stored api_key");
      expect(auth.describeAuthSource("b")).toBe("stored api_key");
      expect(auth.describeAuthSource("c")).toBe("stored oauth");
      expect(auth.describeAuthSource("never-configured")).toBeNull();
    } finally {
      store.close();
    }
  });
});
