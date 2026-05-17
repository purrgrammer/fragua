// Fan-in LLM delegate — wraps PiCodergenBackend to evaluate branch
// candidates when a tripleoctagon node carries prompt=.
//
// The delegate synthesises a prompt that concatenates each candidate's
// $<branchId>.output text, then calls the backend with no tools (only
// the built-in `abort` is force-included by the codergen backend). The
// LLM is instructed to end its reply with a single line:
//
//   WINNER: <branchId>
//
// The evaluator parses that line out of `outcome.notes` (the final
// assistant text the backend exposes) and validates the chosen
// branchId against the candidate set. No tool dependency.

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

/** Regex that matches the WINNER: <branchId> line. Anchored to a line
 *  (multi-line flag) so the LLM can put it anywhere in the reply, but
 *  by convention it's the final line. We take the LAST match to handle
 *  prompts that quote the format earlier in the reply. */
const WINNER_LINE = /^[ \t]*WINNER:[ \t]*([^\s].*?)[ \t]*$/gm;

function parseWinner(text: string): string | undefined {
  const matches = [...text.matchAll(WINNER_LINE)];
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  return last?.[1]?.trim();
}

/**
 * Build a `LlmFanInDelegate` backed by `PiCodergenBackend`.
 *
 * The returned closure is called by the fan-in handler each time a
 * tripleoctagon with `prompt=` is dispatched. It:
 *   1. Synthesises a prompt from the user's text + branch outputs +
 *      a WINNER:<branchId> trailer instruction.
 *   2. Calls `backend.run(...)` with `allowed_tools = ""` — no tools
 *      beyond the codergen backend's force-included `abort`.
 *   3. Parses the final assistant text (Outcome.notes) for the WINNER
 *      line and validates against the candidate set.
 *   4. Maps the result back to `LlmFanInResult`.
 */
export function makeFanInLlmDelegate(opts: MakeFanInLlmDelegateOpts): LlmFanInDelegate {
  if (!opts.backend && !opts.backendOpts) {
    throw new Error("makeFanInLlmDelegate: provide `backend` or `backendOpts`");
  }
  const backend: CodergenBackend = opts.backend ?? new PiCodergenBackend(opts.backendOpts!);

  return async (input: LlmFanInInput): Promise<LlmFanInResult> => {
    const { candidates, branchOutputs, prompt, nodeAttrs, signal } = input;

    // Synthesise the full prompt: user directive + branch summaries +
    // explicit WINNER trailer instruction with the legal set.
    const candidateIds = candidates.map((c: { branchId: string }) => c.branchId);
    const branchBlocks = candidates
      .map((c: { branchId: string; status: string; score?: number }) => {
        const header = `=== branch:${c.branchId} (status=${c.status}${c.score != null ? `, score=${c.score}` : ""}) ===`;
        const body = branchOutputs.get(c.branchId) ?? "";
        return `${header}\n${body}`;
      })
      .join("\n\n");

    const trailer = `End your reply with EXACTLY one line in the format:\n  WINNER: <branchId>\nwhere <branchId> is one of: ${candidateIds.join(", ")}.\nDo not output any text after that line.`;

    const fullPrompt = `${prompt}\n\n${branchBlocks}\n\n${trailer}`;

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
    // it to ~4KB). Parse the WINNER line out of it.
    const text = outcome.notes ?? "";
    const winner = parseWinner(text);
    if (winner === undefined) {
      return {
        failure: {
          reason: "fan_in_llm_emit_missing",
          detail: "no `WINNER: <branchId>` line found in the LLM reply",
        },
      };
    }

    if (!candidateIds.includes(winner)) {
      return {
        failure: {
          reason: "fan_in_llm_picked_unknown_branch",
          detail: `LLM picked "${winner}", not in candidate set: ${candidateIds.join(", ")}`,
        },
      };
    }

    return {
      winner,
      tokens,
      costUsd,
      ...(modelName !== undefined ? { modelName } : {}),
    };
  };
}

// Exported for unit testing.
export const __test = { parseWinner };
