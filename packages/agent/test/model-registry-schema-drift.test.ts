// Drift alarms for the schema block in model-registry.ts, which mirrors
// pi-coding-agent's models.json validation (see the provenance note in
// that file). pi-ai exports the TS types but not runtime validators, so
// the TypeBox mirror can drift in values without failing the typecheck.
// These assertions turn that drift into a loud failure at bump time.

import { describe, expect, test } from "bun:test";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AuthStorage, ModelRegistry, ProviderConfigSchema } from "../src/index.ts";

type ModelOverrideStatic = NonNullable<Static<typeof ProviderConfigSchema>["modelOverrides"]>[string];
type SchemaThinkingLevelMap = NonNullable<ModelOverrideStatic["thinkingLevelMap"]>;

// Mutual keyof equality: fails to compile when pi-ai adds or removes a
// thinking level the schema doesn't mirror.
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _thinkingLevelKeysInSync: AssertEqual<keyof SchemaThinkingLevelMap, keyof ThinkingLevelMap> = true;
void _thinkingLevelKeysInSync;

describe("model-registry schema drift", () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory({}));

  test("every built-in model's thinkingLevelMap validates against the mirrored schema", () => {
    const carriers = registry.getAll().filter((m) => m.thinkingLevelMap !== undefined);
    expect(carriers.length).toBeGreaterThan(0);
    for (const m of carriers) {
      const wrapped = { modelOverrides: { [m.id]: { thinkingLevelMap: m.thinkingLevelMap } } };
      expect(
        Value.Check(ProviderConfigSchema, wrapped),
        `built-in ${m.provider}/${m.id} carries a thinkingLevelMap the mirrored schema rejects`,
      ).toBe(true);
    }
  });
});
