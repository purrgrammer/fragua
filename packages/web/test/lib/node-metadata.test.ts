// Predicate matrix for `lib/node-metadata.ts`. Both the GraphView card
// and the NodeInspector drawer read these helpers; if the matrix
// shifts (e.g. `conditional` learns to call an LLM) only this file
// changes and both UIs follow.

import { describe, expect, it } from "bun:test";
import type { NodeAttrs } from "@swarm/core";
import { canRetry, fanInRank, isStructural, showsLlm } from "../../src/lib/node-metadata.ts";

const empty: NodeAttrs = {} as NodeAttrs;
const withPrompt: NodeAttrs = { prompt: "rank these" } as NodeAttrs;
const blankPrompt: NodeAttrs = { prompt: "   " } as NodeAttrs;

describe("node metadata predicates", () => {
  it("showsLlm: codergen → true; tool/start/exit/conditional/heuristic-fan-in → false; fan_in with prompt → true", () => {
    // Positive cases.
    expect(showsLlm("codergen", empty)).toBe(true);
    expect(showsLlm("parallel.fan_in", withPrompt)).toBe(true);

    // Negative cases — non-LLM handlers regardless of cascade-resolved attrs.
    expect(showsLlm("tool", { llm_model: "opus-4" } as NodeAttrs)).toBe(false);
    expect(showsLlm("start", empty)).toBe(false);
    expect(showsLlm("exit", empty)).toBe(false);
    expect(showsLlm("conditional", { llm_model: "opus-4" } as NodeAttrs)).toBe(false);
    expect(showsLlm("wait.human", empty)).toBe(false);
    expect(showsLlm("parallel", empty)).toBe(false);

    // fan_in heuristic ranker — no prompt, or whitespace-only prompt.
    expect(showsLlm("parallel.fan_in", empty)).toBe(false);
    expect(showsLlm("parallel.fan_in", blankPrompt)).toBe(false);
  });

  it("canRetry: start/exit/parallel → false; codergen/tool/conditional/wait.human/parallel.fan_in → true", () => {
    expect(canRetry("start")).toBe(false);
    expect(canRetry("exit")).toBe(false);
    expect(canRetry("parallel")).toBe(false);

    expect(canRetry("codergen")).toBe(true);
    expect(canRetry("tool")).toBe(true);
    expect(canRetry("conditional")).toBe(true);
    expect(canRetry("wait.human")).toBe(true);
    expect(canRetry("parallel.fan_in")).toBe(true);
  });

  it("fanInRank: prompt → 'prompt'; no prompt → 'heuristic'; non-fan_in handler → undefined", () => {
    expect(fanInRank("parallel.fan_in", withPrompt)).toBe("prompt");
    expect(fanInRank("parallel.fan_in", empty)).toBe("heuristic");
    expect(fanInRank("parallel.fan_in", blankPrompt)).toBe("heuristic");
    expect(fanInRank("codergen", withPrompt)).toBeUndefined();
    expect(fanInRank("parallel", empty)).toBeUndefined();
  });

  it("isStructural: start/exit → true; everything else → false", () => {
    expect(isStructural("start")).toBe(true);
    expect(isStructural("exit")).toBe(true);
    expect(isStructural("codergen")).toBe(false);
    expect(isStructural("tool")).toBe(false);
    expect(isStructural("parallel")).toBe(false);
  });
});
