// Tests for makeFanInLlmDelegate.
//
// All tests inject a stub CodergenBackend so no real LLM calls fire.
// The stubs record every CodergenInput.prompt + node.attrs.output_schema
// so we can verify prompt synthesis and schema construction.

import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
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

describe("makeFanInLlmDelegate", () => {
  test("throws when neither backendOpts nor backend is provided", () => {
    expect(() => makeFanInLlmDelegate({})).toThrow("provide `backend` or `backendOpts`");
  });

  test("synthesises prompt with branch outputs and passes it to the backend", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_a" } } }));
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
  });

  test("sets output_schema on the synthesised node with candidate ids as enum", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_b" } } }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "choose", nodeAttrs: {}, signal });

    const schema = JSON.parse(calls[0]!.node.attrs.output_schema as string);
    expect(schema.required).toEqual(["winner"]);
    expect(schema.properties.winner.enum).toEqual(["branch_a", "branch_b"]);
    // Verify Value.Check accepts a valid payload and rejects invalid ones.
    const WinnerSchema = Type.Object(
      { winner: Type.Union([Type.Literal("branch_a"), Type.Literal("branch_b")]) },
      { additionalProperties: false },
    );
    expect(Value.Check(WinnerSchema, { winner: "branch_a" })).toBe(true);
    expect(Value.Check(WinnerSchema, { winner: 42 })).toBe(false);
    expect(Value.Check(WinnerSchema, {})).toBe(false);
  });

  test("only context_set and emit_output appear in allowed_tools on the synthesised node", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_a" } } }));
    const delegate = makeFanInLlmDelegate({ backend });
    await delegate({ nodeId: "join", candidates, branchOutputs, prompt: "choose", nodeAttrs: {}, signal });
    const allowedTools = calls[0]!.node.attrs.allowed_tools;
    expect(Array.isArray(allowedTools)).toBe(true);
    expect(allowedTools).toContain("context_set");
    expect(allowedTools).toContain("emit_output");
    expect(allowedTools).toHaveLength(2);
  });

  test("propagates llm_model and llm_provider from nodeAttrs to synthesised node", async () => {
    const { backend, calls } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_a" } } }));
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

  test("returns winner from pendingOutput.data.winner", async () => {
    const { backend } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_b" } } }));
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

  test("missing emit_output downgrades to fan_in_llm_emit_missing failure", async () => {
    const { backend } = makeStubBackend(() => {
      // Omit pendingOutput entirely (exactOptionalPropertyTypes: pendingOutput cannot be `undefined`).
      const { pendingOutput: _omitted, ...rest } = makeOutcome({ status: "success" });
      return rest as Outcome;
    });
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
      expect(result.failure.detail).toMatch(/emit_output/);
    }
  });

  test("emit_output payload not in candidate ids produces fan_in_llm_picked_unknown_branch failure", async () => {
    const { backend } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "ghost_branch" } } }));
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
    const { backend } = makeStubBackend(() => makeOutcome({ pendingOutput: { data: { winner: "branch_a" } } }));
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

  test("contextWrites from Outcome are forwarded in the result", async () => {
    const { backend } = makeStubBackend(() =>
      makeOutcome({
        pendingOutput: { data: { winner: "branch_a" } },
        contextWrites: [{ key: "severity", value: "high" }],
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
    if (!("failure" in result)) {
      expect(result.contextWrites).toBeDefined();
      expect(result.contextWrites).toHaveLength(1);
      expect(result.contextWrites![0]!.key).toBe("severity");
      expect(result.contextWrites![0]!.value).toBe("high");
    }
  });
});
