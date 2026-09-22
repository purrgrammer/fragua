// System One (TypeSafe) client behind `ctx.judge`. One endpoint, three
// question shapes — small enough that a hand-rolled fetch beats a dependency.
// 429 / 529 back off in-client (full jitter, `Retry-After` honoured); what
// survives the attempts surfaces as `JudgeProviderError` for the handler to
// map onto `pause_provider`.

import { JUDGE_DEFAULT_PROVIDER } from "../types/judge.ts";
import {
  JUDGE_USD_PER_INPUT_TOKEN,
  type JudgeClient,
  JudgeNotCredentialedError,
  JudgeProviderError,
  type JudgeRequest,
  type JudgeResponse,
} from "./judge-contract.ts";

export interface JudgeClientOpts {
  /** Resolved per call so a credential added after boot is picked up. */
  getApiKey: () => Promise<string | undefined>;
  provider?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxAttempts?: number;
  /** Test seam; production uses a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
const RETRYABLE = new Set([429, 529]);

export function makeJudgeClient(opts: JudgeClientOpts): JudgeClient {
  const provider = opts.provider ?? JUDGE_DEFAULT_PROVIDER;
  const baseUrl = (opts.baseUrl ?? TYPESAFE_BASE_URL).replace(/\/$/, "");
  const impl = opts.fetch ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;

  return {
    provider,
    async ask(req: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse> {
      const apiKey = await opts.getApiKey();
      if (apiKey === undefined || apiKey.length === 0) throw new JudgeNotCredentialedError(provider);
      const body = JSON.stringify(req);
      let lastRetryable: JudgeProviderError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let res: Response;
        try {
          res = await impl(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body,
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          lastRetryable = new JudgeProviderError(
            `network error: ${redactSecrets(errorMessage(err), apiKey)}`,
            provider,
            null,
          );
          if (attempt < maxAttempts) await sleep(backoffMs(attempt, undefined), signal);
          continue;
        }
        if (res.ok) return parseResponse(await res.text(), provider, apiKey);
        const text = await res.text().catch(() => "");
        if (RETRYABLE.has(res.status)) {
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          lastRetryable = new JudgeProviderError(
            `${res.status} ${statusLabel(res.status)}: ${redactSecrets(text, apiKey).slice(0, 300)}`,
            provider,
            res.status,
            retryAfterMs,
          );
          if (attempt < maxAttempts) await sleep(backoffMs(attempt, retryAfterMs), signal);
          continue;
        }
        throw new JudgeProviderError(
          `${res.status}: ${redactSecrets(text, apiKey).slice(0, 600)}`,
          provider,
          res.status,
        );
      }
      throw lastRetryable ?? new JudgeProviderError("exhausted retries", provider, null);
    },
  };
}

/** Strip anything credential-shaped from a provider response body before it
 * becomes a `JudgeProviderError` message. Those messages are persisted: a
 * non-retryable failure surfaces verbatim as `fact.run_terminated.detail`, and
 * a 429/529 as `pause_provider.errorMessage` on `fact.run_paused`. An auth
 * error that echoes the key back — a common enough API habit — would otherwise
 * land the key in SQLite, readable by anyone with dashboard access. Redacts the
 * live key itself first (the only exact match available), then anything
 * `Bearer`-shaped or carrying a known token prefix.
 *
 * The prefix list is deliberately narrow — real token prefixes only. An earlier
 * pass included `api|key|tok`, which ate ordinary diagnostics whole
 * (`api_key_expired_for_org` → `[redacted]`) and cost the operator the very
 * message this is meant to keep readable. */
function redactSecrets(text: string, apiKey: string): string {
  let out = text;
  if (apiKey.length >= 8) out = out.split(apiKey).join("[redacted]");
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]");
  out = out.replace(/\b(sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9._-]{12,}/gi, "[redacted]");
  return out;
}

function parseResponse(text: string, provider: string, apiKey: string): JudgeResponse {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new JudgeProviderError("response was not JSON", provider, 200);
  }
  if (typeof json !== "object" || json === null)
    throw new JudgeProviderError("response was not an object", provider, 200);
  const r = json as Record<string, unknown>;
  const answers = r["answers"];
  const usage = r["usage"] as Record<string, unknown> | undefined;
  if (typeof answers !== "object" || answers === null || typeof r["model"] !== "string") {
    throw new JudgeProviderError("response missing `model` / `answers`", provider, 200);
  }
  if (r["model"].length > MAX_MODEL_ID_CHARS) {
    throw new JudgeProviderError("response `model` id is implausibly long", provider, 200);
  }
  for (const [id, a] of Object.entries(answers as Record<string, unknown>)) {
    const problem = answerShapeProblem(a);
    if (problem !== undefined) {
      const safeId = redactSecrets(id, apiKey).slice(0, 80);
      throw new JudgeProviderError(`answer "${safeId}": ${problem}`, provider, 200);
    }
  }
  const inputTokens = typeof usage?.["input_tokens"] === "number" ? usage["input_tokens"] : 0;
  return {
    model: r["model"],
    answers: answers as JudgeResponse["answers"],
    usage: {
      input_tokens: inputTokens,
      output_tokens: typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : 0,
    },
    costUsd: inputTokens * JUDGE_USD_PER_INPUT_TOKEN,
  };
}

/** Bounds the resolved model id so a hostile response can't push the
 * `judge.answered` / `cost.recorded` payloads or the message row past caps. */
const MAX_MODEL_ID_CHARS = 128;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isProbabilityMap(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isFiniteNumber);
}

/** Structural check per answer — the shapes the API documents. Returns a
 * one-line problem or undefined when the answer is well-formed. */
function answerShapeProblem(a: unknown): string | undefined {
  if (typeof a !== "object" || a === null) return "not an object";
  const o = a as Record<string, unknown>;
  switch (o["type"]) {
    case "noul":
      return isFiniteNumber(o["noul"]) ? undefined : "`noul` is not a number";
    case "choice":
      if (typeof o["choice"] !== "string") return "`choice` is not a string";
      if (!isProbabilityMap(o["probabilities"])) return "`probabilities` is not a map of numbers";
      if (!isFiniteNumber(o["confidence"])) return "`confidence` is not a number";
      return undefined;
    case "score":
      if (!isFiniteNumber(o["score"])) return "`score` is not a number";
      if (!isProbabilityMap(o["probabilities"])) return "`probabilities` is not a map of numbers";
      if (!isFiniteNumber(o["confidence"])) return "`confidence` is not a number";
      return undefined;
    default:
      return `unknown answer type ${JSON.stringify(o["type"])}`;
  }
}

function statusLabel(status: number): string {
  return status === 429 ? "rate limited" : status === 529 ? "overloaded" : "error";
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function backoffMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  const cap = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return Math.floor(Math.random() * cap);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
