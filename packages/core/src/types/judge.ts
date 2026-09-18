// Judge steps — turn-less typed judgments over a `state:` (SPEC §3.1 `judge`,
// docs/proposals/judge-step.md). The IR shapes the parser lowers a judge step
// to; the handler and validator read these.

import type { OutputProfile, OutputsDecl } from "./outputs.ts";

/** A `choice` / `score` / `noul` question as the System One API accepts it.
 * `instructions` and criteria values are opaque JSON: the API takes a string
 * or a structured mapping (`{question, focus, …}` / `{what, not_for, examples}`)
 * and the parser passes YAML mappings through unchanged. */
export type JudgeQuestion =
  | { type: "choice"; instructions: JudgeJson; criteria: Record<string, JudgeJson> }
  | { type: "score"; instructions: JudgeJson; criteria: JudgeJson[] }
  | { type: "noul"; instructions: JudgeJson; criteria?: Record<string, JudgeJson> };

export type JudgeJson = string | number | boolean | null | JudgeJson[] | { [k: string]: JudgeJson };

export type JudgeQuestionType = JudgeQuestion["type"];

/** A `state:` leaf. A string is literal text with `${{ … }}` substitution; a
 * `{file}` leaf is read from the run's worktree at dispatch (bounded,
 * read-only). Mappings nest to any fixed depth. */
export type JudgeStateLeaf = string | { file: string };
export type JudgeState = JudgeStateLeaf | { [k: string]: JudgeState };

/** The one `{file}` leaf test, shared by parser, validator and handler. */
export function isJudgeFileLeaf(s: JudgeState): s is { file: string } {
  return (
    typeof s === "object" && s !== null && "file" in s && typeof s.file === "string" && Object.keys(s).length === 1
  );
}

/** `decide.route` — a `choice` answer drives route-case edge selection. Below
 * `min_confidence` the handler takes `below` instead of the chosen option. */
export interface JudgeRouteDecision {
  question: string;
  min_confidence?: number;
  below?: string;
}

/** One `noul` threshold: the answer must reach `min` and/or stay under `max`.
 * Authored as `<id>: <min>` or `<id>: {min?, max?}`; at least one bound. */
export interface JudgeThreshold {
  question: string;
  min?: number;
  max?: number;
}

/** `decide.outcome` — every listed threshold must hold (all-of) for
 * `success`, else `fail`. Thresholds scale with risk, so each noul carries
 * its own bound. */
export interface JudgeOutcomeDecision {
  rules: JudgeThreshold[];
}

/** The `decide:` block. The parser enforces at most one of the two arms. */
export type JudgeDecide = { route: JudgeRouteDecision } | { outcome: JudgeOutcomeDecision };

/** `keep:` on a `for-each` judge — the per-item decision: an item stays in
 * `kept` when every threshold holds (all-of), same grammar as `decide.outcome`. */
export interface JudgeKeep {
  rules: JudgeThreshold[];
}

/** True when a noul probability satisfies a threshold's bounds. */
export function thresholdHolds(t: JudgeThreshold, p: number): boolean {
  if (t.min !== undefined && p < t.min) return false;
  if (t.max !== undefined && p > t.max) return false;
  return true;
}

export function describeThreshold(t: JudgeThreshold): string {
  const parts: string[] = [];
  if (t.min !== undefined) parts.push(`≥ ${t.min}`);
  if (t.max !== undefined) parts.push(`≤ ${t.max}`);
  return parts.join(" and ");
}

export const JUDGE_DEFAULT_FOR_EACH_MAX_ITEMS = 200;
export const JUDGE_HARD_FOR_EACH_MAX_ITEMS = 2000;

/** The provider's request limits: 64k tokens for state plus every question,
 * 32k for state plus the longest question. A `for-each` list is cut into
 * chunks that clear both with margin; the estimator uses the measured diff
 * ratio (~2.2 bytes/token), which errs toward smaller chunks. */
export const JUDGE_REQUEST_TOKEN_BUDGET = 48_000;
export const JUDGE_STATE_TOKEN_BUDGET = 24_000;
export const JUDGE_BYTES_PER_TOKEN = 2.2;

export interface JudgeChunkPlanInput {
  sharedBytes: number;
  itemBytes: readonly number[];
  /** Serialised bytes of the authored questions, expanded once per item. */
  questionBytesPerItem: number;
  longestQuestionBytes: number;
  requestTokenBudget?: number;
  stateTokenBudget?: number;
}

/** Cut a list into chunks of consecutive global indices that fit both
 * budgets. `undefined` when the shared state alone, or one item on its own,
 * cannot fit — the caller fails the node with the offending size. */
export function planForEachChunks(input: JudgeChunkPlanInput): number[][] | { tooLarge: "shared" | number } {
  const reqBudget = (input.requestTokenBudget ?? JUDGE_REQUEST_TOKEN_BUDGET) * JUDGE_BYTES_PER_TOKEN;
  const stateBudget = (input.stateTokenBudget ?? JUDGE_STATE_TOKEN_BUDGET) * JUDGE_BYTES_PER_TOKEN;
  if (input.sharedBytes + input.longestQuestionBytes > stateBudget || input.sharedBytes > reqBudget) {
    return { tooLarge: "shared" };
  }
  const chunks: number[][] = [];
  let current: number[] = [];
  let bytes = 0;
  const fits = (itemsBytes: number, count: number): boolean =>
    input.sharedBytes + itemsBytes + count * input.questionBytesPerItem <= reqBudget &&
    input.sharedBytes + itemsBytes + input.longestQuestionBytes <= stateBudget;
  input.itemBytes.forEach((b, i) => {
    if (!fits(b, 1)) return;
    if (current.length > 0 && !fits(bytes + b, current.length + 1)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(i);
    bytes += b;
  });
  const oversized = input.itemBytes.findIndex((b) => !fits(b, 1));
  if (oversized !== -1) return { tooLarge: oversized };
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** The key the list travels under in a `for-each` request's state. */
export const JUDGE_FOR_EACH_ITEMS_KEY = "items";

export const JUDGE_DEFAULT_MODEL = "jev-latest";
export const JUDGE_DEFAULT_PROVIDER = "typesafe";
export const JUDGE_DEFAULT_STATE_MAX_BYTES = 64 * 1024;
export const JUDGE_HARD_STATE_MAX_BYTES = 1024 * 1024;

const IDENT = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function isJudgeIdentifier(s: string): boolean {
  return IDENT.test(s);
}

/** The typed `outputs:` decl a judge produces, derived from its questions —
 * one record per question. Score probabilities are positional (the API keys
 * them by string digit, which is not a valid output identifier).
 *
 * With `forEach` the decl is `answers: array<record{<q>: …}>` aligned with
 * the input list, plus `kept` / `dropped` (each item's own fields under the
 * producer's declared item profile, and the answers under `judge`) when a
 * `keep:` is set. An item profile that is not a record sits under `item`. */
export function deriveJudgeOutputs(
  questions: Record<string, JudgeQuestion>,
  forEach?: { itemProfile: OutputProfile | undefined; keep: boolean },
): OutputsDecl {
  const perQuestion = deriveAnswerRecords(questions);
  if (forEach === undefined) return perQuestion;
  const answerRecord: OutputProfile = {
    kind: "record",
    fields: perQuestion,
    required: Object.keys(perQuestion).sort(),
  };
  const decl: OutputsDecl = { answers: { kind: "array", items: answerRecord } };
  if (!forEach.keep) return decl;
  const item = forEach.itemProfile;
  const itemFields: Record<string, OutputProfile> =
    item !== undefined && item.kind === "record" ? { ...item.fields } : { item: item ?? { kind: "string" } };
  const itemRequired = item !== undefined && item.kind === "record" ? [...item.required] : ["item"];
  const judged: OutputProfile = {
    kind: "record",
    fields: { ...itemFields, judge: answerRecord },
    required: [...itemRequired, "judge"].sort(),
  };
  decl["kept"] = { kind: "array", items: judged };
  decl["dropped"] = { kind: "array", items: judged };
  return decl;
}

/** Question id → question, for the items of one `for-each` chunk. `indices`
 * are the items' positions in the whole list (the id suffix, so answers fold
 * back to the right item); the state carries only the chunk, so every
 * backticked path that starts with `item` is re-aimed at `items[j]` with `j`
 * the chunk-local position. */
export function expandForEachQuestions(
  questions: Record<string, JudgeQuestion>,
  indices: readonly number[],
): Record<string, JudgeQuestion> {
  const out: Record<string, JudgeQuestion> = {};
  indices.forEach((global, local) => {
    const target = `\`${JUDGE_FOR_EACH_ITEMS_KEY}[${local}]`;
    for (const [id, q] of Object.entries(questions)) {
      out[forEachQuestionId(id, global)] = JSON.parse(
        JSON.stringify(q).replace(/`item(?=[.[`])/g, target),
      ) as JudgeQuestion;
    }
  });
  return out;
}

export function forEachQuestionId(id: string, index: number): string {
  return `${id}__${index}`;
}

/** Inverse of `forEachQuestionId`; `undefined` for an id without the suffix. */
export function splitForEachQuestionId(expanded: string): { id: string; index: number } | undefined {
  const m = /^(.*)__(\d+)$/.exec(expanded);
  if (m === null || m[1] === undefined || m[2] === undefined) return undefined;
  return { id: m[1], index: Number(m[2]) };
}

function deriveAnswerRecords(questions: Record<string, JudgeQuestion>): OutputsDecl {
  const decl: OutputsDecl = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const probFields: OutputsDecl = {};
      for (const o of options) probFields[o] = { kind: "number" };
      decl[id] = {
        kind: "record",
        fields: {
          choice: { kind: "choice", options: [...options].sort() },
          confidence: { kind: "number" },
          probabilities: { kind: "record", fields: probFields, required: [...options].sort() },
        },
        required: ["choice", "confidence", "probabilities"],
      };
    } else if (q.type === "score") {
      decl[id] = {
        kind: "record",
        fields: {
          score: { kind: "number" },
          level: { kind: "number" },
          confidence: { kind: "number" },
          probabilities: { kind: "array", items: { kind: "number" } },
        },
        required: ["confidence", "level", "probabilities", "score"],
      };
    } else {
      decl[id] = { kind: "record", fields: { noul: { kind: "number" } }, required: ["noul"] };
    }
  }
  return decl;
}

// ─────────────── Client contract (System One API) ───────────────

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
