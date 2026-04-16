import { expect, test } from "bun:test";
import { SWARM_WORKSPACE_VERSION } from "../src/index.ts";

test("workspace package smoke test", () => {
  expect(SWARM_WORKSPACE_VERSION).toBe("0.0.0");
});
