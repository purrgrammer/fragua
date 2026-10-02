// Regression: daemonEnvAllow is fed `deps.authStorage.list()` — which can
// include custom/unknown provider names. Its provider-prefix scan must tolerate
// a name pi-ai's registry can't resolve; even if pi-ai's `findEnvKeys` throws on
// an unknown name, the exception must not propagate out and crash daemon startup.

import { afterEach, describe, expect, mock, test } from "bun:test";
import * as pi from "@earendil-works/pi-ai/compat";

const realFindEnvKeys = pi.findEnvKeys;
const realGetProviders = pi.getProviders;
const realGetEnvApiKey = pi.getEnvApiKey;

afterEach(() => {
  mock.restore();
  // `mock.restore()` does not undo `mock.module` in bun — without this the
  // patched findEnvKeys leaks into every later test file in the process.
  mock.module("@earendil-works/pi-ai/compat", () => pi);
});

describe("daemonEnvAllow (unknown/custom provider)", () => {
  test("(unknown-provider) resolving an allow-list for a custom provider does not throw", async () => {
    mock.module("@earendil-works/pi-ai/compat", () => ({
      ...pi,
      getProviders: realGetProviders,
      getEnvApiKey: realGetEnvApiKey,
      findEnvKeys: (provider: string) => {
        if (provider === "custom-unknown-provider") {
          throw new Error("Unknown provider: custom-unknown-provider");
        }
        return realFindEnvKeys(provider);
      },
    }));
    const { daemonEnvAllow } = await import("../src/env-creds.ts");
    expect(() => daemonEnvAllow({ storeProviders: ["custom-unknown-provider"] })).not.toThrow();
  });
});
