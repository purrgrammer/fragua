import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { resolveThinkingLevel } from "../src/backend.ts";

// Regression guard for a silent app-wide "thinking went dark" failure: fragua
// never set `thinkingLevel`, so it inherited pi-agent-core's default. A
// dependency bump flipped that default to "off", leaving every llm node with no
// thinking channel (the model then narrated its reasoning into bash comments).
// resolveThinkingLevel makes the level explicit so the upstream default can
// never decide it for us again.

function model(reasoning: boolean): Model<string> {
  return { reasoning } as unknown as Model<string>;
}

describe("resolveThinkingLevel", () => {
  test("non-reasoning model is always off (sending thinking would be wrong / error)", () => {
    expect(resolveThinkingLevel(model(false), {})).toBe("off");
    expect(resolveThinkingLevel(model(false), { reasoning_effort: "high" })).toBe("off");
  });

  test("reasoning-capable model with no effort defaults to medium (not the upstream 'off')", () => {
    expect(resolveThinkingLevel(model(true), {})).toBe("medium");
  });

  test("node effort is honoured on a reasoning-capable model", () => {
    expect(resolveThinkingLevel(model(true), { reasoning_effort: "low" })).toBe("low");
    expect(resolveThinkingLevel(model(true), { reasoning_effort: "medium" })).toBe("medium");
    expect(resolveThinkingLevel(model(true), { reasoning_effort: "high" })).toBe("high");
  });

  test("an out-of-range effort value falls back to the default, not through verbatim", () => {
    expect(resolveThinkingLevel(model(true), { reasoning_effort: "ludicrous" })).toBe("medium");
  });

  test("a model missing the reasoning flag is treated as non-reasoning", () => {
    expect(resolveThinkingLevel({} as Model<string>, { reasoning_effort: "high" })).toBe("off");
  });
});
