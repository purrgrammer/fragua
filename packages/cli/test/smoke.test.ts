import { expect, test } from "bun:test";
import { SWARM_CLI_VERSION } from "../src/index.ts";

test("cli package smoke test", () => {
  expect(SWARM_CLI_VERSION).toBe("0.0.0");
});
