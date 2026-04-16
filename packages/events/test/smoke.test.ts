import { expect, test } from "bun:test";
import { SWARM_EVENTS_VERSION } from "../src/index.ts";

test("events package smoke test", () => {
  expect(SWARM_EVENTS_VERSION).toBe("0.0.0");
});
