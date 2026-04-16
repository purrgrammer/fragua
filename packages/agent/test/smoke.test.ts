import { expect, test } from "bun:test";
import { SWARM_AGENT_VERSION } from "../src/index.ts";

test("agent package smoke test", () => {
  expect(SWARM_AGENT_VERSION).toBe("0.0.0");
});
