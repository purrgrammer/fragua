// judge handler — graph-level typed judgment (SPEC §3.1 `judge`,
// docs/proposals/judge-step.md §4).
//
// Resolves `state:` (substituted text, `{file}` reads through ctx.env),
// asks the System One client on `ctx.judge` the node's questions in one
// request, folds the answers into the derived `outputs:` record, and applies
// `decide:` — a `choice` becomes the route (with a confidence floor + `below`
// landing), a `noul` thresholds into success / fail. No tools, no thread, no
// agent turn.

import type { JudgeNodeMessage } from "@fragua/types";
import { UnpopulatedOutputError } from "../../engine/outputs-substitution.ts";
import { substitute } from "../../engine/substitution.ts";
import {
  JUDGE_DEFAULT_MODEL,
  JUDGE_DEFAULT_STATE_MAX_BYTES,
  JUDGE_USD_PER_INPUT_TOKEN,
  type JudgeAnswer,
  type JudgeDecide,
  type JudgeJson,
  JudgeNotCredentialedError,
  JudgeProviderError,
  type JudgeQuestion,
  type JudgeState,
} from "../../types/judge.ts";
import type { OutputStructValue, OutputsValue } from "../../types/outputs.ts";
import type { Handler, HandlerContext, HandlerResult, HandlerSpec } from "../types.ts";

export interface JudgeConfig {
  nodeId: string;
  state: JudgeState;
  questions: Record<string, JudgeQuestion>;
  decide?: JudgeDecide;
  stateMaxBytes?: number;
  model?: string;
  maxMs?: number;
}

export const DEFAULT_JUDGE_MAX_MS = 30_000;
const STATE_PREVIEW_CHARS = 2_000;

export function makeJudgeHandler(cfg: JudgeConfig): HandlerSpec {
  const maxMs = cfg.maxMs ?? DEFAULT_JUDGE_MAX_MS;
  const stateMaxBytes = cfg.stateMaxBytes ?? JUDGE_DEFAULT_STATE_MAX_BYTES;
  const model = cfg.model ?? JUDGE_DEFAULT_MODEL;

  const handler: Handler = async (ctx) => {
    const judge = ctx.judge;
    if (judge === undefined) {
      return halt(
        `judge step "${cfg.nodeId}": no judge client wired — configure the judge provider (\`fragua providers add typesafe\`)`,
      );
    }

    const resolved = await resolveState(cfg.state, ctx, cfg.nodeId);
    if ("fail" in resolved) return fail(resolved.fail);
    if ("halt" in resolved) return halt(resolved.halt);
    const stateText = JSON.stringify(resolved.state);
    const stateBytes = new TextEncoder().encode(stateText).byteLength;
    if (stateBytes > stateMaxBytes) {
      return fail(`judge state is ${stateBytes} bytes, over the ${stateMaxBytes}-byte cap (state-max-bytes)`);
    }

    const questionIds = Object.keys(cfg.questions);
    ctx.emit("judge.requested", { provider: judge.provider, model, questionIds, stateBytes });

    const startedAt = Date.now();
    let response: Awaited<ReturnType<typeof judge.ask>>;
    try {
      response = await judge.ask({ model, state: resolved.state, questions: cfg.questions }, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) return halt("judge aborted");
      if (err instanceof JudgeNotCredentialedError) return halt(err.message);
      if (err instanceof JudgeProviderError) {
        if (err.httpStatus === 401 || err.httpStatus === 403) {
          return halt(`judge provider "${err.provider}" rejected the credential (${err.httpStatus}) — ${err.message}`);
        }
        if (err.httpStatus === 422 || err.httpStatus === 400) {
          return halt(`judge request rejected by "${err.provider}" (${err.httpStatus}) — ${err.message}`);
        }
        if (err.httpStatus === 200)
          return halt(`judge provider "${err.provider}" returned a malformed response — ${err.message}`);
        return {
          kind: "pause_provider",
          httpStatus: err.httpStatus,
          provider: err.provider,
          errorMessage: err.message,
          ...(err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}),
        } satisfies HandlerResult;
      }
      return halt(`judge call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const durationMs = Date.now() - startedAt;

    const folded = foldAnswers(cfg.questions, response.answers);
    if ("error" in folded) return halt(`judge provider returned malformed answers — ${folded.error}`);
    const outputs = folded.outputs;

    const decision = applyDecide(cfg.decide, response.answers);
    if (decision !== undefined && "error" in decision) return halt(decision.error);

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costUsd = inputTokens * JUDGE_USD_PER_INPUT_TOKEN;
    const recordedDecision: JudgeNodeMessage["decision"] =
      decision === undefined
        ? undefined
        : decision.kind === "route"
          ? { kind: "route", route: decision.route, belowThreshold: decision.belowThreshold }
          : { kind: "outcome", status: decision.status };

    const message: JudgeNodeMessage = {
      role: "judge_node",
      provider: judge.provider,
      model: response.model,
      statePreview: stateText.slice(0, STATE_PREVIEW_CHARS),
      stateBytes,
      questions: Object.fromEntries(
        Object.entries(cfg.questions).map(([id, q]) => [id, { type: q.type, instructions: q.instructions }]),
      ),
      answers: response.answers,
      ...(recordedDecision !== undefined ? { decision: recordedDecision } : {}),
      durationMs,
      timestamp: Date.now(),
    };
    ctx.messages.append(message);

    ctx.emit("judge.answered", {
      provider: judge.provider,
      model: response.model,
      durationMs,
      answers: response.answers,
      ...(recordedDecision !== undefined ? { decision: recordedDecision } : {}),
    });
    ctx.emit("cost.recorded", {
      provider: judge.provider,
      model: response.model,
      stop_reason: "stop",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: inputTokens + outputTokens,
      cost_usd: costUsd,
      cost_input_usd: costUsd,
      cost_output_usd: 0,
      cost_cache_read_usd: 0,
      cost_cache_write_usd: 0,
    });

    const result: HandlerResult = {
      kind: "transition",
      tokens: inputTokens + outputTokens,
      costUsd,
      inputCostUsd: costUsd,
      outputCostUsd: 0,
      inputTokens,
      outputTokens,
      modelName: response.model,
      outputs,
    };
    if (decision?.kind === "route") result.route = decision.route;
    if (decision?.kind === "outcome") {
      result.outcomeStatus = decision.status;
      if (decision.status === "fail") result.failureReason = decision.reason;
    }
    return result;
  };

  return { kind: "judge", sideEffect: "idempotent", maxMs, handler };
}

// ─────────────── state ───────────────

type ResolvedState = { state: JudgeJson } | { fail: string } | { halt: string };

async function resolveState(state: JudgeState, ctx: HandlerContext, nodeId: string): Promise<ResolvedState> {
  const walk = async (s: JudgeState, path: string): Promise<ResolvedState> => {
    if (typeof s === "string") {
      try {
        return { state: substitute(s, { args: ctx.args }) };
      } catch (err) {
        if (err instanceof UnpopulatedOutputError) return { fail: err.message };
        throw err;
      }
    }
    if ("file" in s && typeof s.file === "string" && Object.keys(s).length === 1) {
      if (ctx.env === undefined) {
        return {
          halt: `judge step "${nodeId}": \`${path}\` is a {file} leaf but no execution environment is wired (this is a bug — every dispatch must carry ctx.env)`,
        };
      }
      try {
        return { state: await ctx.env.readFile(s.file) };
      } catch (err) {
        return {
          fail: `judge state \`${path}\`: cannot read "${s.file}" — ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    const out: { [k: string]: JudgeJson } = {};
    for (const [k, v] of Object.entries(s)) {
      const r = await walk(v as JudgeState, `${path}.${k}`);
      if (!("state" in r)) return r;
      out[k] = r.state;
    }
    return { state: out };
  };
  return walk(state, "state");
}

// ─────────────── answers → derived outputs ───────────────

function foldAnswers(
  questions: Record<string, JudgeQuestion>,
  answers: Record<string, JudgeAnswer>,
): { outputs: OutputsValue } | { error: string } {
  const outputs: OutputsValue = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (a === undefined) return { error: `no answer for question "${id}"` };
    if (a.type !== q.type) return { error: `question "${id}" asked ${q.type}, answered ${String(a.type)}` };
    if (a.type === "choice" && q.type === "choice") {
      if (!(a.choice in q.criteria)) return { error: `question "${id}" chose "${a.choice}", not one of its options` };
      const probabilities: { [k: string]: OutputStructValue } = {};
      for (const opt of Object.keys(q.criteria)) probabilities[opt] = num(a.probabilities[opt]);
      outputs[id] = { choice: a.choice, confidence: num(a.confidence), probabilities };
    } else if (a.type === "score" && q.type === "score") {
      const levels = q.criteria.length;
      const probabilities: number[] = [];
      for (let i = 0; i < levels; i++) probabilities.push(num(a.probabilities[String(i)]));
      let level = 0;
      for (let i = 1; i < levels; i++) if ((probabilities[i] ?? 0) > (probabilities[level] ?? 0)) level = i;
      outputs[id] = { score: num(a.score), level, confidence: num(a.confidence), probabilities };
    } else if (a.type === "noul") {
      outputs[id] = { noul: num(a.noul) };
    }
  }
  return { outputs };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ─────────────── decide ───────────────

type Decision =
  | { kind: "route"; route: string; belowThreshold: boolean }
  | { kind: "outcome"; status: "success" | "fail"; reason: string }
  | { error: string };

function applyDecide(decide: JudgeDecide | undefined, answers: Record<string, JudgeAnswer>): Decision | undefined {
  if (decide === undefined) return undefined;
  if ("route" in decide) {
    const a = answers[decide.route.question];
    if (a === undefined || a.type !== "choice") {
      return { error: `decide.route question "${decide.route.question}" has no choice answer` };
    }
    const below =
      decide.route.min_confidence !== undefined &&
      decide.route.below !== undefined &&
      a.confidence < decide.route.min_confidence;
    return { kind: "route", route: below ? (decide.route.below as string) : a.choice, belowThreshold: below };
  }
  const a = answers[decide.outcome.question];
  if (a === undefined || a.type !== "noul") {
    return { error: `decide.outcome question "${decide.outcome.question}" has no noul answer` };
  }
  const pass = a.noul >= decide.outcome.min;
  return {
    kind: "outcome",
    status: pass ? "success" : "fail",
    reason: `${decide.outcome.question}=${a.noul.toFixed(2)} ${pass ? "≥" : "<"} min ${decide.outcome.min}`,
  };
}

// ─────────────── result helpers ───────────────

function halt(detail: string): HandlerResult {
  return { kind: "halt", reason: "error", detail };
}

function fail(failureReason: string): HandlerResult {
  return { kind: "transition", outcomeStatus: "fail", failureReason, tokens: 0, costUsd: 0 };
}
