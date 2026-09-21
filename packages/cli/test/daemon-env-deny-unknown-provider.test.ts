// Regression: daemonEnvDeny is fed `deps.authStorage.list()` — which can
// include custom/unknown provider names. pi-ai's `findEnvKeys` contract for
// unknown names is not asserted in this package; if it throws, the exception
// must not propagate out of daemonEnvDeny and crash daemon startup.

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

describe("daemonEnvDeny (unknown/custom provider)", () => {
  test("(unknown-provider) a findEnvKeys throw does not propagate out of daemonEnvDeny", async () => {
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
    const { daemonEnvDeny } = await import("../src/env-creds.ts");
    expect(() => daemonEnvDeny({ env: {}, storeProviders: ["custom-unknown-provider"] })).not.toThrow();
  });
});
