// Tests for makeFanInLlmDelegate.
//
// All tests inject a stub CodergenBackend so no real LLM calls fire.
// The stubs record every CodergenInput so we can verify prompt
// framing and node-attr propagation. The delegate returns `outcome.notes`
// verbatim as the synthesised `output` — no winner parsing.

import { describe, expect, test } from "bun:test";
import type { CodergenBackend, CodergenInput, FanInCandidate, Node, Outcome } from "@swarm/core";
import { ok } from "@swarm/core";
import { makeFanInLlmDelegate } from "../src/fan-in-evaluator.ts";

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

describe("makeFanInLlmDelegate", () => {
  test("throws when neither backendOpts nor backend is provided", () => {
    expect(() => makeFanInLlmDelegate({})).toThrow("provide `backend` or `backendOpts`");
  });

  test("synthesised prompt concatenates user directive + per-branch blocks, no WINNER trailer", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "## Synthesised review\n…" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "Integrate findings into a single review document",
      nodeAttrs: {},
      signal,
    });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    // User directive is included.
    expect(prompt).toContain("Integrate findings into a single review document");
    // Branch headers are included.
    expect(prompt).toContain("=== branch:branch_a");
    expect(prompt).toContain("=== branch:branch_b");
    // Branch outputs are included verbatim.
    expect(prompt).toContain("Analysis from branch A");
    expect(prompt).toContain("Analysis from branch B: high severity issue found");
    // Status and score appear in the headers.
    expect(prompt).toContain("status=success");
    expect(prompt).toContain("score=0.9");
    // No WINNER trailer — the LLM's reply IS the output, not a pick.
    expect(prompt).not.toContain("WINNER:");
    expect(prompt).not.toContain("WINNER ");
  });

  test("synthesised node has empty allowed_tools (no context_set/emit_output)", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "doc" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "integrate", nodeAttrs: {}, signal });
    const allowedTools = calls[0]!.node.attrs.allowed_tools;
    expect(Array.isArray(allowedTools)).toBe(true);
    expect(allowedTools).toEqual([]);
  });

  test("synthesised node carries no output_schema attr", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "doc" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "integrate", nodeAttrs: {}, signal });
    expect(calls[0]!.node.attrs["output_schema"]).toBeUndefined();
  });

  test("propagates llm_model and llm_provider from nodeAttrs to the synthesised codergen node", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ notes: "doc" }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "integrate",
      nodeAttrs: { llm_model: "claude-3-5", llm_provider: "anthropic" },
      signal,
    });
    const node: Node = calls[0]!.node;
    expect(node.attrs.llm_model).toBe("claude-3-5");
    expect(node.attrs.llm_provider).toBe("anthropic");
  });

  test("returns Outcome.notes as the synthesised output, propagating cost.recorded tokens/usd", async () => {
    const synthesised = "Branch B is clearly more severe.\n\n## Combined review\nFinding 1: …";
    const { backend } = makeStubBackend(() => makeOutcome({ notes: synthesised }));
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "integrate",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(false);
    if (!("failure" in result)) {
      expect(result.output).toBe(synthesised);
      // cost.recorded from the stub backend.
      expect(result.tokens).toBe(20);
      expect(result.costUsd).toBeCloseTo(0.002);
      expect(result.modelName).toBe("test-model");
    }
  });

  test("empty outcome.notes returns an empty output (no synthesis content; not a failure)", async () => {
    const { backend } = makeStubBackend(() => makeOutcome({ notes: "" }));
    const delegate = makeFanInLlmDelegate({ backend });
    const result = await delegate({
      nodeId: "join",
      candidates,
      branchOutputs,
      prompt: "integrate",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(false);
    if (!("failure" in result)) {
      expect(result.output).toBe("");
    }
  });

  test("provider_error on Outcome maps to fan_in_llm_provider_error failure", async () => {
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
      prompt: "integrate",
      nodeAttrs: {},
      signal,
    });
    expect("failure" in result).toBe(true);
    if ("failure" in result) {
      expect(result.failure.reason).toBe("fan_in_llm_provider_error");
      expect(result.failure.detail).toMatch(/rate limited/);
    }
  });
});
