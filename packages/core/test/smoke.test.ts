import { expect, test } from "bun:test";
import { FRAGUA_CORE_VERSION } from "../src/index.ts";

test("core package smoke test", () => {
  expect(FRAGUA_CORE_VERSION).toBe("0.0.0");
});
