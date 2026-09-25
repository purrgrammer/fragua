// Guards the can't-resolve path in `ModelRegistry.parseModels`.
//
// A `provider_config` row that defines custom `models:` for a provider
// with no built-in api/baseUrl to borrow must NOT be silently dropped:
// validation requires them explicitly and surfaces an error instead.
// `radius` used to be the example (a KnownProvider absent from pi-ai's
// `getProviders()`); pi-ai now ships it as a real built-in, so a
// non-built-in provider stands in for the unresolvable case.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

describe("ModelRegistry — custom models for a provider with no resolvable api/baseUrl", () => {
  test("a row with models but no api/baseUrl surfaces an error rather than silently dropping the model", () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderConfig({
        provider: "phantom-provider",
        config: JSON.stringify({
          models: [{ id: "phantom-model", name: "phantom-model" }],
        }),
      });

      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);

      // No built-in catalogue to borrow api/baseUrl from, so the model
      // cannot resolve.
      expect(registry.find("phantom-provider", "phantom-model")).toBeUndefined();
      // The drop is observable: the load surfaces an error naming the row.
      const err = registry.getError();
      expect(err).toBeDefined();
      expect(err).toContain("phantom-provider");
    } finally {
      store.close();
    }
  });
});
