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
  describeThreshold,
  expandForEachQuestions,
  forEachQuestionId,
  isJudgeFileLeaf,
  JUDGE_DEFAULT_FOR_EACH_MAX_ITEMS,
  JUDGE_DEFAULT_MODEL,
  JUDGE_DEFAULT_STATE_MAX_BYTES,
  JUDGE_FOR_EACH_ITEMS_KEY,
  type JudgeAnswer,
  type JudgeDecide,
  type JudgeJson,
  type JudgeKeep,
  JudgeNotCredentialedError,
  JudgeProviderError,
  type JudgeQuestion,
  type JudgeState,
  judgeCostPayload,
  planForEachChunks,
  thresholdHolds,
} from "../../types/judge.ts";
import type { OutputStructValue, OutputsValue } from "../../types/outputs.ts";
import type { Handler, HandlerContext, HandlerResult, HandlerSpec } from "../types.ts";

export interface JudgeConfig {
  nodeId: string;
  /** Optional when `forEach` is set (the list is the state). */
  state?: JudgeState;
  questions: Record<string, JudgeQuestion>;
  decide?: JudgeDecide;
  /** `for-each:` — an `${{ outputs.X.f }}` reference to an array output. */
  forEach?: string;
  keep?: JudgeKeep;
  forEachMaxItems?: number;
  /** Test seams: the provider budgets the chunk planner sizes against. */
  requestTokenBudget?: number;
  stateTokenBudget?: number;
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

    // One request for a plain judge; for a list, one request per chunk that
    // fits the provider's budgets. Every request shares the model and the
    // authored questions; answers merge under global ids.
    interface Planned {
      state: JudgeJson;
      questions: Record<string, JudgeQuestion>;
    }
    const plan: Planned[] = [];
    let items: JudgeJson[] | undefined;
    if (cfg.forEach !== undefined) {
      const list = resolveList(cfg.forEach, ctx);
      if ("fail" in list) return fail(list.fail);
      items = list.items;
      const max = cfg.forEachMaxItems ?? JUDGE_DEFAULT_FOR_EACH_MAX_ITEMS;
      if (items.length > max) {
        return fail(`judge for-each list has ${items.length} items, over the ${max}-item cap (for-each-max-items)`);
      }
      if (items.length === 0) {
        // Nothing to judge: no call, no cost. The outputs are the empty lists
        // a consumer expects, so `${{ outputs.X.kept }}` reads as `[]`.
        const empty: OutputsValue = { answers: [] };
        if (cfg.keep !== undefined) {
          empty["kept"] = [];
          empty["dropped"] = [];
        }
        return { kind: "transition", tokens: 0, costUsd: 0, outputs: empty };
      }
      let shared: { [k: string]: JudgeJson } = {};
      if (cfg.state !== undefined) {
        const resolved = await resolveState(cfg.state, ctx, cfg.nodeId);
        if ("fail" in resolved) return fail(resolved.fail);
        if ("halt" in resolved) return halt(resolved.halt);
        shared =
          typeof resolved.state === "object" && resolved.state !== null && !Array.isArray(resolved.state)
            ? resolved.state
            : { context: resolved.state };
      }
      const bytesOf = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).byteLength;
      const questionSizes = Object.values(cfg.questions).map(bytesOf);
      const chunks = planForEachChunks({
        sharedBytes: bytesOf(shared),
        itemBytes: items.map(bytesOf),
        questionBytesPerItem: questionSizes.reduce((a, b) => a + b, 0),
        longestQuestionBytes: Math.max(...questionSizes),
        ...(cfg.requestTokenBudget !== undefined ? { requestTokenBudget: cfg.requestTokenBudget } : {}),
        ...(cfg.stateTokenBudget !== undefined ? { stateTokenBudget: cfg.stateTokenBudget } : {}),
      });
      if (!Array.isArray(chunks)) {
        return fail(
          chunks.tooLarge === "shared"
            ? `judge for-each shared state does not fit the provider's request budget on its own`
            : `judge for-each item ${chunks.tooLarge} does not fit the provider's request budget on its own`,
        );
      }
      for (const indices of chunks) {
        plan.push({
          state: { ...shared, [JUDGE_FOR_EACH_ITEMS_KEY]: indices.map((i) => (items as JudgeJson[])[i] as JudgeJson) },
          questions: expandForEachQuestions(cfg.questions, indices),
        });
      }
    } else {
      if (cfg.state === undefined) return halt(`judge step "${cfg.nodeId}": neither state nor for-each configured`);
      const resolved = await resolveState(cfg.state, ctx, cfg.nodeId);
      if ("fail" in resolved) return fail(resolved.fail);
      if ("halt" in resolved) return halt(resolved.halt);
      plan.push({ state: resolved.state, questions: cfg.questions });
    }
    const stateTexts = plan.map((p) => JSON.stringify(p.state));
    const stateText = stateTexts[0] ?? "";
    let stateBytes = 0;
    for (const t of stateTexts) {
      const b = new TextEncoder().encode(t).byteLength;
      if (b > stateMaxBytes) {
        return fail(`judge state is ${b} bytes, over the ${stateMaxBytes}-byte cap (state-max-bytes)`);
      }
      stateBytes += b;
    }

    // The authored ids, not the N×Q expansion: at 50 items the expanded list
    // alone would push the event past the 4 KiB cap and truncate away the
    // provider / model fields the read plane opens the step with.
    const questionIds = Object.keys(cfg.questions);
    ctx.emit("judge.requested", {
      provider: judge.provider,
      model,
      questionIds,
      stateBytes,
      ...(items !== undefined ? { forEachCount: items.length, chunks: plan.length } : {}),
    });

    const startedAt = Date.now();
    const answers: Record<string, JudgeAnswer> = {};
    const usage = { input_tokens: 0, output_tokens: 0 };
    let costUsd = 0;
    let resolvedModel = model;
    const costPayloads: Record<string, unknown>[] = [];
    for (const req of plan) {
      let response: Awaited<ReturnType<typeof judge.ask>>;
      try {
        response = await judge.ask({ model, state: req.state, questions: req.questions }, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) return halt("judge aborted");
        if (err instanceof JudgeNotCredentialedError) return halt(err.message);
        if (err instanceof JudgeProviderError) {
          if (err.httpStatus === 401 || err.httpStatus === 403) {
            // A rotated / expired key is routine; like an llm boundary auth
            // failure it is a node `fail` an `on: {fail}` edge can route, not a halt.
            return fail(
              `judge provider "${err.provider}" rejected the credential (${err.httpStatus}) — ${err.message}`,
            );
          }
          if (err.httpStatus === 400) {
            // Data-dependent rejection (measured: the provider's input ceiling is
            // ~32k tokens ≈ 64 KB of diff text) — a node fail an `on: {fail}`
            // edge or a smaller `state-max-bytes` can address, not a halt.
            return fail(`judge state rejected by "${err.provider}" (400) — ${err.message}`);
          }
          if (err.httpStatus === 422) {
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
      Object.assign(answers, response.answers);
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      costUsd += response.costUsd;
      resolvedModel = response.model;
      costPayloads.push(judgeCostPayload(judge.provider, response));
    }
    const durationMs = Date.now() - startedAt;
    const response = { model: resolvedModel, answers, usage, costUsd };

    let outputs: OutputsValue;
    let forEachMeta: JudgeNodeMessage["forEach"];
    if (items !== undefined) {
      const folded = foldForEach(cfg.questions, response.answers, items, cfg.keep);
      if ("error" in folded) return halt(`judge provider returned malformed answers — ${folded.error}`);
      outputs = folded.outputs;
      forEachMeta = {
        count: items.length,
        chunks: plan.length,
        ...(folded.kept !== undefined ? { kept: folded.kept } : {}),
      };
    } else {
      const folded = foldAnswers(cfg.questions, response.answers);
      if ("error" in folded) return halt(`judge provider returned malformed answers — ${folded.error}`);
      outputs = folded.outputs;
    }

    const decision = applyDecide(cfg.decide, response.answers);
    if (decision !== undefined && "error" in decision) return halt(decision.error);

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
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
      ...(forEachMeta !== undefined ? { forEach: forEachMeta } : {}),
      durationMs,
      timestamp: Date.now(),
    };
    ctx.messages.append(message);

    ctx.emit("judge.answered", {
      provider: judge.provider,
      model: response.model,
      durationMs,
      answers: capAnswersForEvent(response.answers),
      ...(recordedDecision !== undefined ? { decision: recordedDecision } : {}),
      ...(forEachMeta !== undefined ? { forEach: forEachMeta } : {}),
    });
    for (const payload of costPayloads) ctx.emit("cost.recorded", payload);

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
    if (isJudgeFileLeaf(s)) {
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

/** The `for-each` list: the reference substitutes to the array's JSON (an
 * output read, so an unpopulated producer fails closed like any other). */
function resolveList(ref: string, ctx: HandlerContext): { items: JudgeJson[] } | { fail: string } {
  let text: string;
  try {
    text = substitute(ref, { args: ctx.args });
  } catch (err) {
    if (err instanceof UnpopulatedOutputError) return { fail: err.message };
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { fail: `judge for-each \`${ref}\` did not resolve to a JSON array` };
  }
  if (!Array.isArray(value)) return { fail: `judge for-each \`${ref}\` resolved to a ${typeof value}, not an array` };
  return { items: value as JudgeJson[] };
}

// ─────────────── observability ───────────────

/** Widest `probabilities` map kept on the `judge.answered` event. A 255-option
 * choice would push the payload past the 4 KiB observability cap and be
 * replaced by a truncation marker; the `judge_node` message row keeps the
 * full distribution. */
export const JUDGE_EVENT_MAX_OPTIONS = 32;

function capAnswersForEvent(answers: Record<string, JudgeAnswer>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, a] of Object.entries(answers)) {
    if (a.type !== "choice" || Object.keys(a.probabilities).length <= JUDGE_EVENT_MAX_OPTIONS) {
      out[id] = a;
      continue;
    }
    const top = Object.entries(a.probabilities)
      .sort((x, y) => y[1] - x[1])
      .slice(0, JUDGE_EVENT_MAX_OPTIONS);
    out[id] = { ...a, probabilities: Object.fromEntries(top), truncated: true };
  }
  return out;
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

/** Per-item fold of a `for-each` response: `answers[i]` is the fold of item
 * `i`'s expanded questions; with `keep`, items split into `kept` / `dropped`,
 * each carrying its own fields (or `item` for a non-record) plus `judge`. */
function foldForEach(
  questions: Record<string, JudgeQuestion>,
  answers: Record<string, JudgeAnswer>,
  items: readonly JudgeJson[],
  keep: JudgeKeep | undefined,
): { outputs: OutputsValue; kept?: number[] } | { error: string } {
  const perItem: OutputStructValue[] = [];
  const kept: OutputStructValue[] = [];
  const dropped: OutputStructValue[] = [];
  const keptIdx: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const own: Record<string, JudgeAnswer> = {};
    for (const id of Object.keys(questions)) {
      const a = answers[forEachQuestionId(id, i)];
      if (a !== undefined) own[id] = a;
    }
    const folded = foldAnswers(questions, own);
    if ("error" in folded) return { error: `item ${i}: ${folded.error}` };
    perItem.push(folded.outputs);
    if (keep === undefined) continue;
    let pass = true;
    for (const rule of keep.rules) {
      const verdict = own[rule.question];
      if (verdict === undefined || verdict.type !== "noul") {
        return { error: `item ${i}: keep question "${rule.question}" has no noul answer` };
      }
      if (!thresholdHolds(rule, verdict.noul)) pass = false;
    }
    const item = items[i] as OutputStructValue;
    const fields: { [k: string]: OutputStructValue } =
      typeof item === "object" && item !== null && !Array.isArray(item) ? { ...item } : { item };
    fields["judge"] = folded.outputs;
    if (pass) {
      kept.push(fields);
      keptIdx.push(i);
    } else {
      dropped.push(fields);
    }
  }
  const outputs: OutputsValue = { answers: perItem };
  if (keep === undefined) return { outputs };
  outputs["kept"] = kept;
  outputs["dropped"] = dropped;
  return { outputs, kept: keptIdx };
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
  const held: string[] = [];
  const failed: string[] = [];
  for (const rule of decide.outcome.rules) {
    const a = answers[rule.question];
    if (a === undefined || a.type !== "noul") {
      return { error: `decide.outcome question "${rule.question}" has no noul answer` };
    }
    const shown = `${rule.question}=${a.noul.toFixed(2)}`;
    (thresholdHolds(rule, a.noul) ? held : failed).push(`${shown} (${describeThreshold(rule)})`);
  }
  const pass = failed.length === 0;
  return {
    kind: "outcome",
    status: pass ? "success" : "fail",
    reason: pass ? `${held.join(", ")} all within bounds` : `${failed.join(", ")} out of bounds`,
  };
}

// ─────────────── result helpers ───────────────

function halt(detail: string): HandlerResult {
  return { kind: "halt", reason: "error", detail };
}

function fail(failureReason: string): HandlerResult {
  return { kind: "transition", outcomeStatus: "fail", failureReason, tokens: 0, costUsd: 0 };
}
