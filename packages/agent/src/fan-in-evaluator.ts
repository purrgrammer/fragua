// Fan-in LLM delegate — wraps PiCodergenBackend to synthesise a single
// document from branch outputs when a tripleoctagon node carries prompt=.
//
// The delegate frames a prompt that contains the user's directive plus
// each branch's $<branchId>.output text in a labelled block, then calls
// the backend with no tools (only the built-in `abort` is force-included
// by the codergen backend). The LLM's reply IS the synthesised output:
// `outcome.notes` is returned verbatim as `LlmFanInSuccess.output`.
// The fan-in handler persists it as the node's `output` artifact so
// downstream nodes can read it via `$<fanInId>.output` substitution.
//
// Note: `outcome.notes` is sliced to ~4 KB by the codergen backend.
// Long synthesised documents will truncate; widening that cap is a
// pi-agent-core concern outside this evaluator.

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
 *   1. Frames a prompt: user directive + per-branch labelled blocks.
 *   2. Calls `backend.run(...)` with `allowed_tools = []` — no tools
 *      beyond the codergen backend's force-included `abort`.
 *   3. Returns `outcome.notes` verbatim as the synthesised `output`.
 *      `outcome.provider_error` maps to `fan_in_llm_provider_error`.
 */
export function makeFanInLlmDelegate(opts: MakeFanInLlmDelegateOpts): LlmFanInDelegate {
  if (!opts.backend && !opts.backendOpts) {
    throw new Error("makeFanInLlmDelegate: provide `backend` or `backendOpts`");
  }
  const backend: CodergenBackend = opts.backend ?? new PiCodergenBackend(opts.backendOpts!);

  return async (input: LlmFanInInput): Promise<LlmFanInResult> => {
    const { candidates, branchOutputs, prompt, nodeAttrs, signal } = input;

    // Frame the prompt: user directive + per-branch labelled blocks.
    // No WINNER trailer — the LLM's reply IS the synthesised document.
    const branchBlocks = candidates
      .map((c: { branchId: string; status: string; score?: number }) => {
        const header = `=== branch:${c.branchId} (status=${c.status}${c.score != null ? `, score=${c.score}` : ""}) ===`;
        const body = branchOutputs.get(c.branchId) ?? "";
        return `${header}\n${body}`;
      })
      .join("\n\n");

    const fullPrompt = `${prompt}\n\n${branchBlocks}`;

    // Synthesise a Node whose attrs carry the tripleoctagon's llm_model /
    // llm_provider (already resolved by prepareGraph + stylesheet at
    // auto-dispatch time), plus an empty tool list. The codergen backend
    // force-includes `abort`, which is the only affordance we want.
    const syntheticNode: Node = {
      id: input.nodeId,
      shape: "tripleoctagon",
      classes: [],
      attrs: {
        ...nodeAttrs,
        allowed_tools: [],
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

    // outcome.notes carries the final assistant text (the backend slices
    // it to ~4KB). Return it verbatim — it IS the synthesised document.
    const output = outcome.notes ?? "";

    return {
      output,
      tokens,
      costUsd,
      ...(modelName !== undefined ? { modelName } : {}),
    };
  };
}
