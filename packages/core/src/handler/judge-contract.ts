// The System One request / answer contract and the pre-wired client the
// handler and the agent tool talk to. Server-side only: the browser bundle
// never speaks to the provider, so nothing here is reachable from the main
// entry.

import type { JudgeJson, JudgeQuestion } from "../types/judge.ts";
export interface JudgeRequest {
  model: string;
  state: JudgeJson;
  questions: Record<string, JudgeQuestion>;
}

export type JudgeAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | { type: "noul"; noul: number };

export interface JudgeResponse {
  /** Resolved model id (`jev-1.13.0`), never the alias the author wrote. */
  model: string;
  answers: Record<string, JudgeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  /** Priced by the client from `usage` (input tokens only; output is free). */
  costUsd: number;
}

/** Pre-wired System One client on `ctx.judge`. Handlers may not `fetch`. */
export interface JudgeClient {
  readonly provider: string;
  ask(req: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse>;
}

/** A provider-side failure the handler maps onto a result: 401/403 → a
 * non-retryable fail, 422 → an error halt, 429/529/network → `pause_provider`. */
export class JudgeProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly httpStatus: number | null,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "JudgeProviderError";
  }
}

/** Thrown when no credential row exists for the judge provider. */
export class JudgeNotCredentialedError extends Error {
  constructor(public readonly provider: string) {
    super(`provider "${provider}" is not credentialed — run \`fragua providers add ${provider}\``);
    this.name = "JudgeNotCredentialedError";
  }
}

/** Input-token price for Jev; output tokens are free. Per-provider constant
 * until a second System One model exists. */
export const JUDGE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

/** The `cost.recorded` payload for one judge call — the same shape the llm
 * boundary emits, so the run-level cost fold and the per-step window need no
 * special case. */
export function judgeCostPayload(provider: string, res: JudgeResponse): Record<string, unknown> {
  return {
    provider,
    model: res.model,
    // Marks the event as a System One call so a step's cost aggregate can
    // report it beside the step's own model spend instead of pricing the
    // tokens at that model's rate.
    kind: "judge",
    stop_reason: "stop",
    input_tokens: res.usage.input_tokens,
    output_tokens: res.usage.output_tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    cost_usd: res.costUsd,
    cost_input_usd: res.costUsd,
    cost_output_usd: 0,
    cost_cache_read_usd: 0,
    cost_cache_write_usd: 0,
  };
}
