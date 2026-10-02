// A System One backend, as data. The wire is one endpoint with three question
// shapes, so a second backend is not a second client — it is a record the one
// client is parameterised by.
//
// Budgets live per model, not only per provider: Ollaya's context windows span
// 512 (`laya:en`) to 32768 (`qwen3guard`) tokens, a 64x spread, where TypeSafe
// serves one 64k/32k pair for every model it hosts. Bytes-per-token is per
// record for the same reason — it is a property of one tokenizer over one kind
// of text, and the two measured here differ by more than 2x.

import {
  JUDGE_BYTES_PER_TOKEN,
  JUDGE_DEFAULT_MODEL,
  JUDGE_DEFAULT_PROVIDER,
  JUDGE_DEFAULT_STATE_MAX_BYTES,
  JUDGE_REQUEST_TOKEN_BUDGET,
  JUDGE_STATE_TOKEN_BUDGET,
} from "../types/judge.ts";

/** Per-model overrides. A model differs from its provider's defaults in two
 * independent ways: how much it can hold (the budgets) and how its tokenizer
 * cuts text (`bytesPerToken`). One provider can serve several tokenizers —
 * `laya:en` is ModernBERT, `laya:multilingual` is mmBERT — so the ratio is not
 * a provider-wide constant any more than the window is.
 *
 * The ratio is an approximation even per model: `kev:0.8b` measures 3.56
 * bytes/token on diff text and 6.00 on English prose. Judge states are mostly
 * diffs and file excerpts, so entries here carry the lower, code-shaped figure
 * — the planner must under-estimate the window, never over-estimate it. */
export interface JudgeModelLimits {
  requestTokenBudget?: number;
  stateTokenBudget?: number;
  stateMaxBytes?: number;
  bytesPerToken?: number;
}

export interface JudgeProviderRecord {
  id: string;
  baseUrl: string;
  /** `optional` → an absent credential is not an error; the client sends a
   * placeholder bearer, and a server that does enforce a key answers 401 onto
   * the ordinary auth-failure path. */
  auth: "required" | "optional";
  usdPerInputToken: number;
  /** Absent → a step must name `model:`; there is no cross-provider default. */
  defaultModel?: string;
  requestTokenBudget: number;
  stateTokenBudget: number;
  /** A measured property of one tokenizer, so it belongs to the record. */
  bytesPerToken: number;
  stateMaxBytes: number;
  models?: Record<string, JudgeModelLimits>;
}

export const JUDGE_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
export const JUDGE_OLLAYA_BASE_URL = "http://127.0.0.1:11435";

/** Jev's input-token price; output tokens are free. Kept as a named export
 * because tests and the cost fold price against this exact rate. */
export const JUDGE_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const TYPESAFE: JudgeProviderRecord = {
  id: JUDGE_DEFAULT_PROVIDER,
  baseUrl: JUDGE_TYPESAFE_BASE_URL,
  auth: "required",
  usdPerInputToken: JUDGE_USD_PER_INPUT_TOKEN,
  defaultModel: JUDGE_DEFAULT_MODEL,
  requestTokenBudget: JUDGE_REQUEST_TOKEN_BUDGET,
  stateTokenBudget: JUDGE_STATE_TOKEN_BUDGET,
  bytesPerToken: JUDGE_BYTES_PER_TOKEN,
  stateMaxBytes: JUDGE_DEFAULT_STATE_MAX_BYTES,
};

/** Ollaya serves open decision models locally behind a `/v1/systemone` that is
 * wire-identical to TypeSafe's. The numbers below are MEASURED against 0.7.5 on
 * `laya`, not documented: prose tokenises at ~4.9 bytes/token where Jev's diff
 * text measured 2.2, and `laya:en` refuses a state over ~480 tokens outright
 * rather than truncating it. The provider defaults are sized for the smallest
 * window in the library, since a model with no entry could be that one; a
 * `judge:ollaya` config row adds entries for the rest. */
const OLLAYA: JudgeProviderRecord = {
  id: "ollaya",
  baseUrl: JUDGE_OLLAYA_BASE_URL,
  auth: "optional",
  usdPerInputToken: 0,
  requestTokenBudget: 400,
  stateTokenBudget: 200,
  // Below the measured 4.9 so the estimate errs toward smaller chunks.
  bytesPerToken: 4.0,
  stateMaxBytes: 2 * 1024,
  models: {
    // ModernBERT, 512-token window: 479 tokens answered at 2200 bytes of
    // English prose, 2400 was refused. Slope 4.89 bytes/token.
    "laya:en": { requestTokenBudget: 460, stateTokenBudget: 440, stateMaxBytes: 2 * 1024, bytesPerToken: 4.4 },
    // mmBERT, 1024-token window: 1011 tokens at 4800 bytes. Slope 4.88 on
    // English — a different tokenizer that happens to agree here, and would
    // not on CJK, which is the reason the ratio is per model at all.
    "laya:multilingual": {
      requestTokenBudget: 960,
      stateTokenBudget: 900,
      stateMaxBytes: 4 * 1024,
      bytesPerToken: 4.4,
    },
    // 8192-token window, measured: 8161 tokens accepted, refused above 29 KB of
    // diff text. The ratio is 3.56 on diff/code and 6.00 on English prose — the
    // same tokenizer, 1.7x apart by KIND of text. Judge states are mostly diffs
    // and file excerpts, so the lower number is the one that binds; using the
    // prose figure would plan a chunk 68% over what the model accepts.
    "kev:0.8b": { requestTokenBudget: 7800, stateTokenBudget: 7400, stateMaxBytes: 26 * 1024, bytesPerToken: 3.4 },
    // Advertises 8192 but refuses above ~5950 in practice, and cuts code more
    // finely (2.91 bytes/token on diff, 6.00 on prose) — so despite being ten
    // times kev's size on disk it holds 17 KB of diff where kev holds 29 KB.
    // Bigger is not wider: measure before choosing.
    "winnow:e4b": { requestTokenBudget: 5700, stateTokenBudget: 5400, stateMaxBytes: 15 * 1024, bytesPerToken: 2.8 },
  },
};

export const JUDGE_BUILTIN_PROVIDERS: Readonly<Record<string, JudgeProviderRecord>> = {
  [TYPESAFE.id]: TYPESAFE,
  [OLLAYA.id]: OLLAYA,
};

/** The budgets and the tokenizer ratio that apply to one model of one
 * provider. A model with no entry takes the provider's defaults, which are
 * sized for the least capable model it serves. */
export function judgeLimitsFor(record: JudgeProviderRecord, model: string): Required<JudgeModelLimits> {
  const over = record.models?.[model];
  return {
    requestTokenBudget: over?.requestTokenBudget ?? record.requestTokenBudget,
    stateTokenBudget: over?.stateTokenBudget ?? record.stateTokenBudget,
    stateMaxBytes: over?.stateMaxBytes ?? record.stateMaxBytes,
    bytesPerToken: over?.bytesPerToken ?? record.bytesPerToken,
  };
}
