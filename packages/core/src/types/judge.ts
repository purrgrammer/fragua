// Judge steps — turn-less typed judgments over a `state:` (SPEC §3.1 `judge`,
// docs/proposals/judge-step.md). The IR shapes the parser lowers a judge step
// to; the handler and validator read these.

import type { OutputsDecl } from "./outputs.ts";

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

/** `decide.outcome` — one or more `noul` answers threshold into `success` /
 * `fail`: every listed noul must reach `min` (all-of). Authored as
 * `question: <id>` or `questions: [<id>, …]`; the parser normalises to a list. */
export interface JudgeOutcomeDecision {
  questions: string[];
  min: number;
}

/** The `decide:` block. The parser enforces at most one of the two arms. */
export type JudgeDecide = { route: JudgeRouteDecision } | { outcome: JudgeOutcomeDecision };

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
 * them by string digit, which is not a valid output identifier). */
export function deriveJudgeOutputs(questions: Record<string, JudgeQuestion>): OutputsDecl {
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
