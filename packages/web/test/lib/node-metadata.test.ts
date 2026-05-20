// Predicate matrix for `lib/node-metadata.ts`. Both the GraphView card
// and the NodeInspector drawer read these helpers; if the matrix
// shifts only this file changes and both UIs follow.

import { describe, expect, it } from "bun:test";
import type { NodeAttrs } from "@swarm/core";
import { canRetry, isStructural, showsLlm } from "../../src/lib/node-metadata.ts";

const empty: NodeAttrs = {} as NodeAttrs;

describe("node metadata predicates", () => {
  it("showsLlm: llm → true; tool/start/exit/wait.human → false", () => {
    expect(showsLlm("llm", empty)).toBe(true);

    // Negative cases — non-LLM handlers regardless of cascade-resolved attrs.
    expect(showsLlm("tool", { model: "opus-4" } as NodeAttrs)).toBe(false);
    expect(showsLlm("start", empty)).toBe(false);
    expect(showsLlm("exit", empty)).toBe(false);
    expect(showsLlm("wait.human", empty)).toBe(false);
  });

  it("canRetry: start/exit → false; llm/tool/wait.human → true", () => {
    expect(canRetry("start")).toBe(false);
    expect(canRetry("exit")).toBe(false);

    expect(canRetry("llm")).toBe(true);
    expect(canRetry("tool")).toBe(true);
    expect(canRetry("wait.human")).toBe(true);
  });

  it("isStructural: start/exit → true; everything else → false", () => {
    expect(isStructural("start")).toBe(true);
    expect(isStructural("exit")).toBe(true);
    expect(isStructural("llm")).toBe(false);
    expect(isStructural("tool")).toBe(false);
  });
});
