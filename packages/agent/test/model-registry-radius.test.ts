// Guards the empty-static-catalogue path in `ModelRegistry.parseModels`.
//
// `radius` is a KnownProvider with no static catalogue entry (it is not
// in pi-ai's `getProviders()`). A `provider_config` row that defines
// custom `models:` for such a provider must NOT be silently dropped:
// with no built-in api/baseUrl to borrow, validation requires them
// explicitly and surfaces an error instead.

import { describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { AuthStorage, ModelRegistry } from "../src/index.ts";

describe("ModelRegistry — dynamic-only provider (radius) with custom models", () => {
  test("a radius row with models but no api/baseUrl surfaces an error rather than silently dropping the model", () => {
    const store = new SqliteStore();
    try {
      store.upsertProviderConfig({
        provider: "radius",
        config: JSON.stringify({
          models: [{ id: "radius-custom", name: "radius-custom" }],
        }),
      });

      const registry = ModelRegistry.create(AuthStorage.fromStore(store), store);

      // No built-in catalogue to borrow api/baseUrl from, so the model
      // cannot resolve.
      expect(registry.find("radius", "radius-custom")).toBeUndefined();
      // The drop is observable: the load surfaces an error naming the row.
      const err = registry.getError();
      expect(err).toBeDefined();
      expect(err).toContain("radius");
    } finally {
      store.close();
    }
  });
});
