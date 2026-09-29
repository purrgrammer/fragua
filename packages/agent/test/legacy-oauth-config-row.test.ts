// Before OAuth moved onto `Provider.auth.oauth`, a custom provider could ship
// its own OAuth flow in a `provider_config` row's `oauth:` block, which
// `registerOAuthProvider` consumed at load. That key is gone from the schema —
// and TypeBox `Value.Check` is non-strict, so such a row still VALIDATES and
// the block is simply discarded.
//
// That is the silent half of a migration: the provider keeps loading, then
// resolves no key, and every call through it returns undefined with nothing
// saying why. The row has to be named at load instead.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

describe("ModelRegistry — a legacy `oauth:` provider_config row", () => {
  test("is surfaced as an error naming the provider, not silently dropped", () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderConfig({
        provider: "legacy-oauth-provider",
        config: JSON.stringify({
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          models: [{ id: "m1", name: "m1" }],
          // The shape the old registerOAuthProvider path consumed.
          oauth: { authUrl: "https://example.test/authorize", tokenUrl: "https://example.test/token" },
        }),
      });

      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);
      const err = registry.getError();

      expect(err).toBeDefined();
      expect(err).toContain("legacy-oauth-provider");
      expect(err).toContain("oauth");

      // WARN, don't skip. The row is still a valid provider definition — only
      // its `oauth:` block is dead — so the models must keep resolving. A
      // stray `continue` in loadCustomModels would turn this warning into a
      // silent drop and nothing else here would notice.
      expect(registry.find("legacy-oauth-provider", "m1")).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("a row with no `oauth:` key loads without inventing an error", () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderConfig({
        provider: "clean-provider",
        config: JSON.stringify({
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          models: [{ id: "m1", name: "m1" }],
        }),
      });

      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);

      expect(registry.getError()).toBeUndefined();
      expect(registry.find("clean-provider", "m1")).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe("ModelRegistry — the legacy `oauth:` remedy depends on the provider", () => {
  test("a CUSTOM provider is told to remove the key, not to run a login that would reject it", () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderConfig({
        provider: "custom-oauth-provider",
        config: JSON.stringify({
          api: "openai-completions",
          baseUrl: "https://example.test/v1",
          models: [{ id: "m1", name: "m1" }],
          oauth: { authUrl: "https://example.test/authorize", tokenUrl: "https://example.test/token" },
        }),
      });

      const err = ModelRegistry.create(AuthStorage.fromStore(store), store).getError();

      // `providers login` only accepts ids in the built-in OAuth set, so
      // naming it here walks the operator into a second, unexplained error.
      expect(err).toBeDefined();
      expect(err).not.toContain("providers login");
      expect(err).toContain("no longer supported");
    } finally {
      store.close();
    }
  });
});
