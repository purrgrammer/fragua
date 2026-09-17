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

/** `decide.route` — a `choice` answer drives route-case edge selection. Below
 * `min_confidence` the handler takes `below` instead of the chosen option. */
export interface JudgeRouteDecision {
  question: string;
  min_confidence?: number;
  below?: string;
}

/** `decide.outcome` — a `noul` answer thresholds into `success` / `fail`. */
export interface JudgeOutcomeDecision {
  question: string;
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
