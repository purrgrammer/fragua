// `judge` tool — the System One primitives (choice / score / noul) as an
// agent-callable tool, for the decisions an llm step reaches mid-turn that
// are better made as calibrated probabilities than as prose: "does the code
// at each of these twelve citations support its claim", "which of these
// candidates is the right one", "how severe is each finding". One call
// answers every question in parallel; the agent keeps the reasoning and the
// evidence-gathering, the judge supplies the calibrated verdicts.
//
// Present only when the run has a judge client (`fraguaContext.judge`); the
// llm backend strips it from the toolset otherwise, so a workflow authored
// against it never sees a "not configured" answer at runtime.

import type { JudgeJson, JudgeQuestion } from "@fragua/core";
import { JUDGE_DEFAULT_MODEL, parseJudgeQuestions } from "@fragua/core";
import { JudgeNotCredentialedError, JudgeProviderError, judgeCostPayload } from "@fragua/core/handler";
import { Type } from "@sinclair/typebox";
import type { Tool } from "./types.ts";

export interface JudgeToolArgs {
  state: unknown;
  questions: Record<string, unknown>;
}

export interface JudgeToolData {
  model: string;
  answers: Record<string, unknown>;
  input_tokens: number;
  cost_usd: number;
}

const QuestionSchema = Type.Object(
  {
    type: Type.Union([Type.Literal("choice"), Type.Literal("score"), Type.Literal("noul")]),
    instructions: Type.Any({
      description:
        "The one judgment to make, complete on its own (question ids are not sent). Reference state fields by backticked path, e.g. `findings[2].claim`.",
    }),
    criteria: Type.Optional(
      Type.Any({
        description:
          "choice: a map of option id → what it means (add an `other` when the list may not cover the input). score: an ordered list of level descriptions, lowest first. noul: optional {true: …, false: …}.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const judgeTool: Tool<JudgeToolArgs, JudgeToolData> = {
  name: "judge",
  description:
    "Ask a calibrated System One model a batch of narrow, typed questions about `state` and get back typed answers with probabilities — no prose, no reasoning, ~1s, ~free. " +
    "Use it when what you read NEXT depends on the answer — which of N candidates to open (one `choice`), whether a claim survives what you just read before you go further (one `noul`). " +
    "When the list to judge is known up front (every finding, every citation), do not call this: emit the list as a typed output and let a `for-each` judge step ask the questions, so the probabilities land in the graph where `keep:` and the next step can threshold them. " +
    "Put the evidence in `state` (text or a JSON object — file excerpts, the claim, the diff hunk), one judgment per question, and ask everything you need in ONE call: questions are answered in parallel and extra questions cost nothing in latency. " +
    "Answers: choice → {choice, probabilities, confidence}; score → {score, level probabilities, confidence}; noul → {noul: p(yes)}. A noul near 0.5 is undecided, not medium. " +
    "The model cannot read files or run commands — gather the evidence first, then judge. Input is capped near 32k tokens (~64 KB of code).",
  parameters: Type.Object(
    {
      state: Type.Any({
        description:
          "The facts to judge: a string, or a JSON object/array of text fields. Facts only — the judgment goes in each question's instructions.",
      }),
      questions: Type.Record(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]*$" }), QuestionSchema, {
        description: "question id → question. Ids are for you; they are not sent to the model.",
      }),
    },
    { additionalProperties: false },
  ),
  // A read-only external call: the same question over the same state is safe
  // to repeat on a dangling-call resume.
  idempotent: true,
  truncation: { max_chars: 60_000, mode: "head_tail" },

  async execute(args, _env, opts = {}) {
    const ctx = opts.fraguaContext;
    const judge = ctx?.judge;
    if (judge === undefined) {
      return errorResult(
        "judge is not available on this run — no judge provider is credentialed (`fragua providers add typesafe`)",
      );
    }
    let questions: Record<string, JudgeQuestion>;
    try {
      questions = parseJudgeQuestions(args.questions);
    } catch (err) {
      return errorResult(`invalid questions: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!isJudgeJson(args.state)) {
      return errorResult("`state` must be JSON: a string, or an object/array of strings, numbers, booleans");
    }
    try {
      const res = await judge.ask(
        { model: JUDGE_DEFAULT_MODEL, state: args.state, questions },
        opts.signal ?? new AbortController().signal,
      );
      ctx?.emit("cost.recorded", judgeCostPayload(judge.provider, res));
      const data: JudgeToolData = {
        model: res.model,
        answers: res.answers,
        input_tokens: res.usage.input_tokens,
        cost_usd: res.costUsd,
      };
      return { text: JSON.stringify(res.answers, null, 1), data };
    } catch (err) {
      if (err instanceof JudgeNotCredentialedError) return errorResult(err.message);
      if (err instanceof JudgeProviderError) {
        const hint =
          err.httpStatus === 400 ? " — the state is over the provider's input cap; judge a smaller excerpt" : "";
        return errorResult(
          `judge provider error${err.httpStatus !== null ? ` (${err.httpStatus})` : ""}: ${err.message}${hint}`,
        );
      }
      throw err;
    }
  },
};

function isJudgeJson(v: unknown): v is JudgeJson {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.every(isJudgeJson);
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isJudgeJson);
  return false;
}

function errorResult(text: string): { text: string; is_error: true } {
  return { text, is_error: true };
}
