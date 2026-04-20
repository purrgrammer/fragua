import type { LlmCallParams, LlmClient, LlmResult } from "./types.ts";

export interface LlmAccounting {
  addUsage(params: {
    tokens: number;
    costUsd: number;
    model: string;
    /** Input/output/cache split. Optional because the legacy
     * `LlmCallFn` contract (`LlmResult`) only carries a flat `tokens`
     * scalar — tool handlers driving a non-streaming LLM don't have
     * the split. The executor treats missing fields as 0. */
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }): void;
}

export type LlmCallFn = (params: LlmCallParams, signal: AbortSignal) => Promise<LlmResult>;

export interface LlmClientOpts {
  signal: AbortSignal;
  call: LlmCallFn;
  /** Accounting hook — executor tracks per-node token/cost for fact.node_completed. */
  accounting?: LlmAccounting;
}

/**
 * LLM client that binds the executor's AbortSignal to every call and reports
 * usage into the accounting hook. Provider-specific details live in the
 * injected `call` function so the core package stays provider-agnostic.
 */
export function makeLlmClient(opts: LlmClientOpts): LlmClient {
  return {
    async call(params) {
      if (opts.signal.aborted) {
        throw opts.signal.reason ?? new Error("aborted");
      }
      const result = await opts.call(params, opts.signal);
      opts.accounting?.addUsage({
        tokens: result.tokens,
        costUsd: result.costUsd,
        model: result.model,
      });
      return result;
    },
  };
}
