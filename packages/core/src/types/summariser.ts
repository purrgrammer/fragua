// Pure port for a small-model summariser backend. Concrete
// implementations live outside @swarm/core (pi-ai wrapper in @swarm/agent,
// test stubs in tests). Kept separate from CodergenBackend because:
//
// 1. Summarisation runs on a different (cheaper) model than the node
//    being summarised — exposing it as its own port makes that swap
//    explicit rather than implicit.
// 2. It's invoked by both `execute()` (run title) and backends
//    (fidelity=summary:medium/high), so it lives in core so both sides
//    can depend on it.
// 3. It has its own event surface (summary.started / summary.completed /
//    cost.recorded under a synthetic node id) — keeping the contract
//    narrow makes that surface enforceable.

import type { EventType } from "./events.ts";
import type { FidelityMode } from "./fidelity.ts";

export type SummaryPurpose = "title" | "fidelity";

/** Input to a single summariser call. The caller constructs this per
 * invocation — there's no persistent state on the backend. */
export interface SummariseInput {
  purpose: SummaryPurpose;
  /** Raw text to summarise. For `purpose="title"` this is the user's
   * `$ARGUMENTS`; for `purpose="fidelity"` this is a pre-digest of the
   * prior transcript (role census + last N messages). Summariser impls
   * must accept arbitrary length and clip/chunk internally. */
  input: string;
  /** Workflow-level goal. Frames the compression prompt so the
   * summariser keeps whatever part of `input` serves the goal. */
  goal?: string;
  /** Run id. Captured on the synthetic node's events for traceability. */
  run_id: string;
  /** Workflow sha, for the event envelope. */
  workflow_sha: string;
  /** Where the event should say it originated. For `purpose="title"` this
   * is `__summary.title`. For `purpose="fidelity"` it's
   * `__summary.<caller_node_id>` (+ `#<iter>` when inside a loop). */
  synthetic_node_id: string;
  /** Real caller — only set for `purpose="fidelity"`. Surfaced on
   * summary.started / summary.completed so UIs can link the synthetic
   * step to the real node that asked for it. */
  caller_node_id?: string;
  iteration?: { n: number; max: number };
  fidelity?: FidelityMode;
  /** Optional per-call cap on the output length in tokens. Defaults to
   * the backend's `default_max_output_tokens`. */
  max_output_tokens?: number;
  /** Event sink hook. Summariser emits `summary.started`,
   * `summary.completed`, and `cost.recorded` under `synthetic_node_id`.
   * When omitted the summariser still returns the text but writes no
   * events — useful for unit tests that just want the compression. */
  emit?: (type: EventType, data: Record<string, unknown>, node_id: string) => Promise<void>;
  /** Cooperative cancellation from the executor. */
  signal?: AbortSignal;
}

export interface SummariseOutput {
  /** Compressed / generated text. Empty string when the call failed. */
  text: string;
  /** True when the backend produced a usable summary; false on any
   * error. Callers fall back to a deterministic template when false
   * so a missing API key or network blip doesn't break a run. */
  ok: boolean;
  /** Populated on `!ok` to explain the fallback. */
  error?: string;
  /** Provider + model that serviced the call (or would have, on error). */
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
}

/** The contract. Implementations must be side-effect free beyond (a)
 * their LLM call and (b) the event `emit` callback. */
export interface SummariserBackend {
  summarise(input: SummariseInput): Promise<SummariseOutput>;
}

/** Convention: synthetic nodes always start with `__` so they can never
 * collide with a real DOT node id (DOT identifiers can't start with
 * underscore followed by two more characters without quoting, and even
 * then, `__summary.*` is reserved by this module). */
export const SYNTHETIC_NODE_PREFIX = "__summary";

export function titleSyntheticNodeId(): string {
  return `${SYNTHETIC_NODE_PREFIX}.title`;
}

export function fidelitySyntheticNodeId(callerNodeId: string, iteration?: { n: number }): string {
  const base = `${SYNTHETIC_NODE_PREFIX}.${callerNodeId}`;
  return iteration ? `${base}#${iteration.n}` : base;
}
