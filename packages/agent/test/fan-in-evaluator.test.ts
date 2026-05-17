// Tests for makeFanInLlmDelegate.
//
// All tests inject a stub CodergenBackend so no real LLM calls fire.
// The stubs record every CodergenInput so we can verify prompt
// synthesis and node-attr propagation. Winner is parsed from
// `outcome.notes` (final assistant text) — no tool dependency.

import { describe, expect, test } from "bun:test";
import type { CodergenBackend, CodergenInput, FanInCandidate, Node, Outcome } from "@swarm/core";
import { ok } from "@swarm/core";
import { __test, makeFanInLlmDelegate } from "../src/fan-in-evaluator.ts";

function makeOutcome(overrides: Partial<Outcome>): Outcome {
  return {
    ...ok(),
    ...overrides,
  };
}

function makeStubBackend(responseFactory: (input: CodergenInput) => Outcome): {
  backend: CodergenBackend;
  calls: CodergenInput[];
} {
  const calls: CodergenInput[] = [];
  const backend: CodergenBackend = {
    run: async (input: CodergenInput): Promise<Outcome> => {
      calls.push(input);
      // Simulate a cost.recorded event.
      if (input.emit) {
        await input.emit("cost.recorded" as "cost.recorded", {
          total_tokens: 20,
          cost_usd: 0.002,
          model: "test-model",
        });
      }
      return responseFactory(input);
    },
  };
  return { backend, calls };
}

const candidates: FanInCandidate[] = [
  { branchId: "branch_a", status: "success", score: 0.5 },
  { branchId: "branch_b", status: "success", score: 0.9 },
];

const branchOutputs = new Map([
  ["branch_a", "Analysis from branch A: low risk"],
  ["branch_b", "Analysis from branch B: high severity issue found"],
]);

const signal = new AbortController().signal;

describe("parseWinner (regex)", () => {
  test("matches a clean trailing WINNER line", () => {
    expect(__test.parseWinner("some prose\nWINNER: branch_b")).toBe("branch_b");
  });
  test("matches WINNER line with leading/trailing whitespace tolerantly", () => {
    expect(__test.parseWinner("...\n  WINNER:   branch_a  ")).toBe("branch_a");
  });
  test("takes the last WINNER when multiple appear (model quoted the format earlier)", () => {
    expect(__test.parseWinner("Format reminder: WINNER: <branchId>\n\nAnalysis...\nWINNER: branch_b")).toBe("branch_b");
  });
  test("returns undefined when no WINNER line present", () => {
    expect(__test.parseWinner("just prose, no decision")).toBeUndefined();
  });
  test("returns undefined when WINNER value is empty", () => {
    expect(__test.parseWinner("WINNER: ")).toBeUndefined();
  });
});

describe("makeFanInLlmDelegate", () => {
  test("throws when neither backendOpts nor backend is provided", () => {
    expect(() => makeFanInLlmDelegate({})).toThrow("provide `backend` or `backendOpts`");
  });

  test("synthesises prompt with branch outputs and the WINNER trailer", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "WINNER: branch_a" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "pick the most critical finding",
      nodeAttrs: {},
      signal,
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    // User directive is included.
    expect(prompt).toContain("pick the most critical finding");
    // Branch headers are included.
    expect(prompt).toContain("=== branch:branch_a");
    expect(prompt).toContain("=== branch:branch_b");
    // Branch outputs are included.
    expect(prompt).toContain("Analysis from branch A");
    expect(prompt).toContain("Analysis from branch B: high severity issue found");
    // Status and score appear in the header.
    expect(prompt).toContain("status=success");
    expect(prompt).toContain("score=0.9");
    // The WINNER trailer instruction is appended with the legal candidate list.
    expect(prompt).toContain("WINNER: <branchId>");
    expect(prompt).toContain("branch_a, branch_b");
  });

  test("synthesised node has empty allowed_tools (no context_set/emit_output)", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "WINNER: branch_a" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "choose", nodeAttrs: {}, signal });
    const allowedTools = calls[0]!.node.attrs.allowed_tools;
    expect(Array.isArray(allowedTools)).toBe(true);
    expect(allowedTools).toEqual([]);
  });

  test("synthesised node carries no output_schema attr", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "WINNER: branch_a" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "choose", nodeAttrs: {}, signal });
    expect(calls[0]!.node.attrs.output_schema).toBeUndefined();
  });

  test("propagates llm_model and llm_provider from nodeAttrs to synthesised node", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "WINNER: branch_a" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: { llm_model: "claude-3-5", llm_provider: "anthropic" },
      signal,
    });
    const node: Node = calls[0]!.node;
    expect(node.attrs.llm_model).toBe("claude-3-5");
    expect(node.attrs.llm_provider).toBe("anthropic");
  });

  test("returns winner parsed from outcome.notes WINNER line", async () => {
    const { backend } = makeStubBackend(() =>
      makeOutcome({ notes: "Branch B is clearly more severe.\n\nWINNER: branch_b" }),
    );
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(false);
    if (!("failure" in result)) {
      expect(result.winner).toBe("branch_b");
    }
  });

  test("missing WINNER line returns fan_in_llm_emit_missing failure", async () => {
    const { backend } = makeStubBackend(() => makeOutcome({ notes: "I cannot decide." }));
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(true);
    if ("failure" in result) {
      expect(result.failure.reason).toBe("fan_in_llm_emit_missing");
      expect(result.failure.detail).toMatch(/WINNER/);
    }
  });

  test("WINNER pointing to an unknown branch produces fan_in_llm_picked_unknown_branch failure", async () => {
    const { backend } = makeStubBackend(() => makeOutcome({ notes: "WINNER: ghost_branch" }));
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(true);
    if ("failure" in result) {
      expect(result.failure.reason).toBe("fan_in_llm_picked_unknown_branch");
      expect(result.failure.detail).toMatch(/ghost_branch/);
    }
  });

  test("provider_error in outcome returns fan_in_llm_provider_error failure", async () => {
    const { backend } = makeStubBackend(() =>
      makeOutcome({
        provider_error: {
          httpStatus: 429,
          provider: "anthropic",
          errorMessage: "rate limited",
        },
      }),
    );
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(true);
    if ("failure" in result) {
      expect(result.failure.reason).toBe("fan_in_llm_provider_error");
      expect(result.failure.detail).toMatch(/rate limited/);
    }
  });

  test("cost is collected from cost.recorded events emitted by the backend", async () => {
    // The stub backend above emits cost.recorded with total_tokens=20, cost_usd=0.002.
    const { backend } = makeStubBackend(() => makeOutcome({ notes: "WINNER: branch_a" }));
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "choose",
      nodeAttrs: {},
      signal,
    });
    if (!("failure" in result)) {
      expect(result.tokens).toBe(20);
      expect(result.costUsd).toBeCloseTo(0.002);
      expect(result.modelName).toBe("test-model");
    }
  });
});
