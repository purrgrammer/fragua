import { expect, test } from "bun:test";
import { SWARM_CORE_VERSION } from "../src/index.ts";

test("core package smoke test", () => {
  expect(SWARM_CORE_VERSION).toBe("0.0.0");
});
