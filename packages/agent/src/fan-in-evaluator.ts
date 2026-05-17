// Fan-in LLM delegate — wraps PiCodergenBackend to evaluate branch
// candidates when a tripleoctagon node carries prompt=.
//
// The delegate synthesises a prompt that concatenates each candidate's
// $<branchId>.output text, then calls the backend with an output_schema
// that forces the LLM to call emit_output({winner: "<branchId>"}). The
// resolved branchId is returned to the fan-in handler, which writes it
// into routing under fan_in.<nodeId>.winner.
//
// context_set calls made by the LLM are forwarded back as contextWrites
// so the handler can fold them into routingDelta and emit
// fact.context_written events for downstream ${context.<key>} resolution.

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CodergenBackend, CodergenInput, Node } from "@swarm/core";
import type { LlmFanInDelegate, LlmFanInInput, LlmFanInResult } from "@swarm/core/handler";
import type { PiCodergenBackendOptions } from "./backend.ts";
import { PiCodergenBackend } from "./backend.ts";

export interface MakeFanInLlmDelegateOpts {
  /** Backend constructor options. Mutually exclusive with `backend`. */
  backendOpts?: PiCodergenBackendOptions;
  /** Pre-built backend. Mutually exclusive with `backendOpts`. Used by
   * tests to inject a stub without spinning pi-agent-core. */
  backend?: CodergenBackend;
}

/**
 * Build a `LlmFanInDelegate` backed by `PiCodergenBackend`.
 *
 * The returned closure is called by the fan-in handler each time a
 * tripleoctagon with `prompt=` is dispatched. It:
 *   1. Synthesises a prompt from the user's text + branch outputs.
 *   2. Sets `output_schema` on the synthesised node so the backend's
 *      `emit_output` enforcement requires `{winner: <branchId>}`.
 *   3. Calls `backend.run(...)` with `allowed_tools = ["context_set",
 *      "emit_output"]` — the LLM's only affordances for this call.
 *   4. Maps the `Outcome` back to `LlmFanInResult`.
 */
export function makeFanInLlmDelegate(opts: MakeFanInLlmDelegateOpts): LlmFanInDelegate {
  if (!opts.backend && !opts.backendOpts) {
    throw new Error("makeFanInLlmDelegate: provide `backend` or `backendOpts`");
  }
  const backend: CodergenBackend = opts.backend ?? new PiCodergenBackend(opts.backendOpts!);

  return async (input: LlmFanInInput): Promise<LlmFanInResult> => {
    const { candidates, branchOutputs, prompt, nodeAttrs, signal } = input;

    // Synthesise the full prompt: user directive + branch summaries.
    const branchBlocks = candidates
      .map((c: { branchId: string; status: string; score?: number }) => {
        const header = `=== branch:${c.branchId} (status=${c.status}${c.score != null ? `, score=${c.score}` : ""}) ===`;
        const body = branchOutputs.get(c.branchId) ?? "";
        return `${header}\n${body}`;
      })
      .join("\n\n");

    const fullPrompt = `${prompt}\n\n${branchBlocks}`;

    // Output schema: winner must be one of the known branch ids.
    // The backend's emit_output tool will enforce this via Value.Check.
    const candidateIds = candidates.map((c: { branchId: string }) => c.branchId);
    const outputSchema = JSON.stringify({
      type: "object",
      required: ["winner"],
      additionalProperties: false,
      properties: {
        winner: {
          type: "string",
          enum: candidateIds,
        },
      },
    });

    // Synthesise a Node whose attrs carry the tripleoctagon's llm_model /
    // llm_provider (already resolved by prepareGraph + stylesheet at
    // auto-dispatch time), plus the output_schema and a narrow tool list.
    const syntheticNode: Node = {
      id: input.nodeId,
      shape: "tripleoctagon",
      classes: [],
      attrs: {
        ...nodeAttrs,
        output_schema: outputSchema,
        allowed_tools: ["context_set", "emit_output"],
      },
    };

    // Drive the backend. We don't have a HandlerContext here — the
    // parent fan-in handler owns that. Collect cost.recorded events via
    // the emit callback so the returned result carries accurate cost.
    let tokens = 0;
    let costUsd = 0;
    let modelName: string | undefined;
    type EmitFn = NonNullable<CodergenInput["emit"]>;
    const collectEmit: EmitFn = async (type, data) => {
      if (type === "cost.recorded") {
        const t = data["total_tokens"];
        const c = data["cost_usd"];
        const m = data["model"];
        if (typeof t === "number") tokens += t;
        if (typeof c === "number") costUsd += c;
        if (typeof m === "string") modelName = m;
      }
    };
    const outcome = await backend.run({
      node: syntheticNode,
      prompt: fullPrompt,
      context: {},
      thread_id: undefined,
      fidelity: "full",
      signal,
      run_id: `fan_in_eval:${input.nodeId}`,
      workflow_sha: "",
      emit: collectEmit,
      persistMessage: () => {},
    });

    // Map Outcome → LlmFanInResult.

    if (outcome.provider_error != null) {
      return {
        failure: {
          reason: "fan_in_llm_provider_error",
          detail: outcome.provider_error.errorMessage,
        },
      };
    }

    if (outcome.pendingOutput?.data === undefined) {
      return {
        failure: {
          reason: "fan_in_llm_emit_missing",
          detail: "LLM did not call emit_output with {winner: <branchId>}",
        },
      };
    }

    // Validate the payload with Typebox Value.Check.
    const WinnerSchema = Type.Object(
      { winner: Type.Union(candidateIds.map((id: string) => Type.Literal(id))) },
      { additionalProperties: false },
    );

    const data = outcome.pendingOutput.data;
    if (!Value.Check(WinnerSchema, data)) {
      return {
        failure: {
          reason: "fan_in_llm_picked_unknown_branch",
          detail: `not a valid {winner: one-of-candidates} payload: ${JSON.stringify(data)}`,
        },
      };
    }

    const winner = (data as { winner: string }).winner;

    // Collect contextWrites from the Outcome.
    const contextWrites = outcome.contextWrites ?? [];

    return {
      winner,
      ...(contextWrites.length > 0 ? { contextWrites } : {}),
      tokens,
      costUsd,
      ...(modelName !== undefined ? { modelName } : {}),
    };
  };
}
