// Tests for the `provider_credentials` store API
// (docs/proposals/provider-credentials-storage.md).

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "../src/store.ts";

function freshStore(): SqliteStore {
  return new SqliteStore();
}

describe("provider_credentials store API", () => {
  test("upsert + get round-trips an api_key credential", () => {
    const store = freshStore();
    try {
      const payload = JSON.stringify({ type: "api_key", key: "sk-test-123" });
      store.upsertProviderCredential({ provider: "anthropic", kind: "api_key", payload });

      const got = store.getProviderCredential("anthropic");
      expect(got).not.toBeNull();
      expect(got!.provider).toBe("anthropic");
      expect(got!.kind).toBe("api_key");
      expect(got!.payload).toEqual({ type: "api_key", key: "sk-test-123" });
      expect(typeof got!.createdAt).toBe("number");
      expect(typeof got!.updatedAt).toBe("number");
    } finally {
      store.close();
    }
  });

  test("upsert preserves created_at on conflict", () => {
    let nowValue = 1_000;
    const store = new SqliteStore({ now: () => nowValue });
    try {
      const payload1 = JSON.stringify({ type: "api_key", key: "first" });
      store.upsertProviderCredential({ provider: "openai", kind: "api_key", payload: payload1 });
      const first = store.getProviderCredential("openai")!;

      nowValue = 2_500;
      const payload2 = JSON.stringify({ type: "api_key", key: "second" });
      store.upsertProviderCredential({ provider: "openai", kind: "api_key", payload: payload2 });

      const second = store.getProviderCredential("openai")!;
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect(second.payload).toEqual({ type: "api_key", key: "second" });
    } finally {
      store.close();
    }
  });

  test("listProviderCredentials returns all rows ordered by provider", () => {
    const store = freshStore();
    try {
      store.upsertProviderCredential({
        provider: "openai",
        kind: "api_key",
        payload: JSON.stringify({ type: "api_key", key: "o" }),
      });
      store.upsertProviderCredential({
        provider: "anthropic",
        kind: "oauth",
        payload: JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: 1 }),
      });
      store.upsertProviderCredential({
        provider: "google",
        kind: "api_key",
        payload: JSON.stringify({ type: "api_key", key: "g" }),
      });

      const list = store.listProviderCredentials();
      expect(list.map((r) => r.provider)).toEqual(["anthropic", "google", "openai"]);
      expect(list.map((r) => r.kind)).toEqual(["oauth", "api_key", "api_key"]);
    } finally {
      store.close();
    }
  });

  test("deleteProviderCredential removes the row", () => {
    const store = freshStore();
    try {
      store.upsertProviderCredential({
        provider: "groq",
        kind: "api_key",
        payload: JSON.stringify({ type: "api_key", key: "g" }),
      });
      expect(store.getProviderCredential("groq")).not.toBeNull();

      store.deleteProviderCredential("groq");
      expect(store.getProviderCredential("groq")).toBeNull();

      // Idempotent: second delete is a no-op.
      store.deleteProviderCredential("groq");
      expect(store.getProviderCredential("groq")).toBeNull();
    } finally {
      store.close();
    }
  });

  test("CHECK rejects unknown kind", () => {
    const store = freshStore();
    try {
      // Use the public surface: the API parameter is typed but we cast
      // to bypass for the runtime CHECK assertion.
      expect(() =>
        store.upsertProviderCredential({
          provider: "weird",
          kind: "garbage" as unknown as "api_key",
          payload: "{}",
        }),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      store.close();
    }
  });
});
