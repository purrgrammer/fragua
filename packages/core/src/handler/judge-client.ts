// System One client behind `ctx.judge`. One endpoint, three question shapes —
// small enough that a hand-rolled fetch beats a dependency. Retryable statuses
// back off in-client (full jitter, `Retry-After` honoured); what survives the
// attempts surfaces as `JudgeProviderError` for the handler to map onto
// `pause_provider`.
//
// It is a ROUTER: every provider-specific fact (base URL, whether a credential
// is required, the input-token rate, the budgets) lives on a
// `JudgeProviderRecord`, and one request loop is parameterised by whichever
// record the request selects.

import { isAutoRetryableStatus } from "../provider-classification.ts";
import { JUDGE_DEFAULT_PROVIDER } from "../types/judge.ts";
import {
  type JudgeClient,
  JudgeNotCredentialedError,
  JudgeProviderError,
  type JudgeRequest,
  type JudgeResponse,
} from "./judge-contract.ts";
import { JUDGE_BUILTIN_PROVIDERS, JUDGE_TYPESAFE_BASE_URL, type JudgeProviderRecord } from "./judge-provider.ts";

export interface JudgeClientOpts {
  /** Resolved per call and per provider so a credential added after boot is
   * picked up, and so one router can serve several backends. */
  getApiKey: (provider: string) => Promise<string | undefined>;
  /** The provider a request that names none resolves to. */
  defaultProvider?: string;
  /** Records by id. Defaults to the built-ins; a registry supplies user rows. */
  providers?: Readonly<Record<string, JudgeProviderRecord>>;
  fetch?: typeof fetch;
  maxAttempts?: number;
  /** Test seam; production uses a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const TYPESAFE_BASE_URL = JUDGE_TYPESAFE_BASE_URL;

/** A provider whose record says a credential is optional still needs a bearer
 * on the wire — Ollaya accepts any non-empty key and rejects an empty one. A
 * server that *does* enforce a key answers 401, which lands on the ordinary
 * auth-failure path with the `fragua providers add <id>` hint. */
const PLACEHOLDER_KEY = "fragua-local";

export function makeJudgeClient(opts: JudgeClientOpts): JudgeClient {
  const providers = opts.providers ?? JUDGE_BUILTIN_PROVIDERS;
  const defaultProvider = opts.defaultProvider ?? JUDGE_DEFAULT_PROVIDER;
  const impl = opts.fetch ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? defaultSleep;

  const resolve = (id?: string): JudgeProviderRecord | undefined => providers[id ?? defaultProvider];

  return {
    defaultProvider,
    resolve,
    async ask(req: JudgeRequest, signal: AbortSignal): Promise<JudgeResponse> {
      const provider = req.provider ?? defaultProvider;
      const record = resolve(provider);
      if (record === undefined) {
        throw new JudgeProviderError(
          `unknown judge provider "${provider}" — configured: ${Object.keys(providers).sort().join(", ")}`,
          provider,
          null,
        );
      }
      const baseUrl = record.baseUrl.replace(/\/$/, "");
      const resolved = await opts.getApiKey(provider);
      const apiKey = resolved !== undefined && resolved.length > 0 ? resolved : undefined;
      if (apiKey === undefined && record.auth === "required") throw new JudgeNotCredentialedError(provider);
      const bearer = apiKey ?? PLACEHOLDER_KEY;
      // `provider` is ours, not the wire's — the API takes `{model, state,
      // questions}` and rejects unknown fields on some backends.
      const { provider: _routed, ...wire } = req;
      const body = JSON.stringify(wire);
      let lastRetryable: JudgeProviderError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let res: Response;
        try {
          res = await impl(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body,
            signal,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          lastRetryable = new JudgeProviderError(
            `network error: ${redactSecrets(errorMessage(err), bearer)}`,
            provider,
            null,
          );
          if (attempt < maxAttempts) await sleep(backoffMs(attempt, undefined), signal);
          continue;
        }
        if (res.ok) return parseResponse(await res.text(), record, bearer);
        const text = await res.text().catch(() => "");
        if (isAutoRetryableStatus(res.status)) {
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          lastRetryable = new JudgeProviderError(
            `${res.status} ${statusLabel(res.status)}: ${redactSecrets(text, bearer).slice(0, 300)}`,
            provider,
            res.status,
            retryAfterMs,
          );
          if (attempt < maxAttempts) await sleep(backoffMs(attempt, retryAfterMs), signal);
          continue;
        }
        throw new JudgeProviderError(
          `${res.status}: ${redactSecrets(text, bearer).slice(0, 600)}`,
          provider,
          res.status,
          undefined,
          providerErrorCode(text),
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
/** Below this, an exact substring replace does more harm than good — see the
 * `api_key_expired_for_org` case in the note above. Short keys are still
 * redacted, at word boundaries. */
const SUBSTRING_SAFE_KEY_CHARS = 8;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecrets(text: string, apiKey: string): string {
  let out = text;
  if (apiKey.length >= SUBSTRING_SAFE_KEY_CHARS) {
    out = out.split(apiKey).join("[redacted]");
  } else if (apiKey.length > 0) {
    // A key too short to substring-match safely still has to go. Anchor it at
    // word boundaries instead: a bare `x` in the provider's message is
    // redacted, while `x` inside `max_tokens_exceeded` is left alone. Optional
    // auth made this reachable — a local backend accepts any non-empty key, so
    // an operator can set one of two characters where no hosted provider would.
    out = out.replace(new RegExp(`\\b${escapeRegExp(apiKey)}\\b`, "g"), "[redacted]");
  }
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [redacted]");
  out = out.replace(/\b(sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9._-]{12,}/gi, "[redacted]");
  return out;
}

/** Lift a provider's machine-readable error code out of its body, so the
 * handler can branch on `STATE_TRUNCATED` / `MODEL_NOT_FOUND` instead of
 * pattern-matching prose. Absent on backends that carry none. */
function providerErrorCode(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text);
    if (typeof json !== "object" || json === null) return undefined;
    const o = json as Record<string, unknown>;
    const direct = o["code"];
    if (typeof direct === "string" && direct.length > 0 && direct.length <= 64) return direct;
    const err = o["error"];
    if (typeof err === "object" && err !== null) {
      const nested = (err as Record<string, unknown>)["code"];
      if (typeof nested === "string" && nested.length > 0 && nested.length <= 64) return nested;
    }
  } catch {
    // Not JSON, or not shaped that way — no code to lift.
  }
  return undefined;
}

function parseResponse(text: string, record: JudgeProviderRecord, apiKey: string): JudgeResponse {
  const provider = record.id;
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
  // `Infinity` and `NaN` are `number`s; a provider sending either would
  // otherwise land a non-finite cost in the event log and every rollup over it.
  const inputTokens = isFiniteNumber(usage?.["input_tokens"]) ? Math.max(0, usage["input_tokens"]) : 0;
  return {
    provider,
    model: r["model"],
    answers: answers as JudgeResponse["answers"],
    usage: {
      input_tokens: inputTokens,
      output_tokens: isFiniteNumber(usage?.["output_tokens"]) ? Math.max(0, usage["output_tokens"]) : 0,
    },
    costUsd: inputTokens * record.usdPerInputToken,
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
  if (status === 429) return "rate limited";
  if (status === 529) return "overloaded";
  if (status === 503) return "unavailable";
  return "error";
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
  // Equal jitter, as the llm retry path uses: every attempt waits at least
  // half its exponential, so three retries cannot all fire near-zero and burn
  // the chain without spanning a rate-limit window.
  const cap = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
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
