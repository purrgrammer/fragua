// Verify the exported DEFAULT_TOOL_MAX_MS constant is correct.

import { describe, expect, test } from "bun:test";
import { DEFAULT_TOOL_MAX_MS } from "../../src/parser/yaml.ts";

describe("DEFAULT_TOOL_MAX_MS", () => {
  test("constant is exported and equals 5 minutes in ms", () => {
    expect(DEFAULT_TOOL_MAX_MS).toBe(5 * 60 * 1000);
  });
});
