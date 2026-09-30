// Provider-error classification for the LLM backend: turn a terminal assistant
// message into a resumable pause / hard fail, normalise an overloaded / transient
// transport envelope to its canonical auto-retryable status, and parse
// `Retry-After`. Split out of backend.ts.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Outcome } from "@fragua/core";
import { ANTHROPIC_OVERLOADED_STATUS, fail, failProvider, isAutoRetryableStatus } from "@fragua/core";
import { findAbortToolCall, summarizeMessage } from "./exit-tools.ts";

/** Classify the terminal assistant message into a resumable pause / hard fail,
 * or `null` to fall through to exit resolution. Handles no-response, provider
 * transport errors (4xx/5xx), signal-driven abort (rethrown as AbortError so the
 * executor's `wasAborted` path runs), a trailing abort tool call, unclassified
 * failure envelopes (fail open to a resumable pause), and empty responses. */
export function classifyTerminalMessage(args: {
  messages: readonly AgentMessage[];
  provider: string;
  lastHttpStatus: number | null;
  lastRetryAfterMs: number | undefined;
  hydratedCount: number;
  signalAborted: boolean;
}): Outcome | null {
  const { messages, provider, lastHttpStatus, lastRetryAfterMs, hydratedCount, signalAborted } = args;
  const last = messages[messages.length - 1];
  if (!last) {
    // No messages at all is the strongest signal that the very first call failed
    // transport-level. Pause-not-halt so the run can resume after a fix.
    return failProvider("provider returned no response", {
      httpStatus: lastHttpStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }

  if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    if (last.stopReason === "error") {
      // pi-ai's `onResponse` only fires once a stream begins; a pre-stream reject
      // (e.g. Anthropic 400 on a malformed history) never invokes it, so recover
      // the status from the leading token of `errorMessage`.
      const extracted = effectiveProviderHttpStatus(
        lastHttpStatus ?? (last.errorMessage ? extractHttpStatusFromErrorMessage(last.errorMessage) : null),
        last.errorMessage,
      );
      const httpIs4xx5xx = extracted !== null && extracted >= 400 && extracted < 600;
      const noContent = !Array.isArray(last.content) || last.content.length === 0;
      if (httpIs4xx5xx || noContent) {
        return failProvider(last.errorMessage ?? `provider stream error (HTTP ${extracted ?? "n/a"})`, {
          httpStatus: extracted,
          provider,
          ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
        });
      }
    }
    // Signal-driven abort (operator pause/cancel, supervisor timeout, shutdown
    // drain): rethrow so the executor's `wasAborted` path emits
    // `fact.node_aborted` instead of halting with `aborted_exit`.
    if (last.stopReason === "aborted" && signalAborted) {
      const err = new Error(last.errorMessage ?? "stream aborted");
      err.name = "AbortError";
      throw err;
    }
    // A deliberate self-abort can leave a trailing error envelope; the abort
    // still wins over a provider pause.
    const abortedEarlier = findAbortToolCall(messages.slice(hydratedCount));
    if (abortedEarlier && !abortedEarlier.isolated) {
      return fail(
        "abort shared an assistant response with other tool calls — call it alone, with no other tools in the same turn",
        { non_retryable: true },
      );
    }
    if (abortedEarlier) {
      return fail(abortedEarlier.reason, { notes: summarizeMessage(last), non_retryable: true });
    }
    // Unclassified failure envelope: FAIL OPEN to a resumable pause rather than
    // route a transient transport failure into the no-fail-edge terminal halt.
    const unclassifiedStatus = effectiveProviderHttpStatus(
      lastHttpStatus ?? (last.errorMessage ? extractHttpStatusFromErrorMessage(last.errorMessage) : null),
      last.errorMessage,
    );
    return failProvider(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
      httpStatus: unclassifiedStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }

  // Empty assistant turn without an explicit error — the stream ended cleanly but
  // produced nothing (observed against real provider 402s). Pause-not-halt.
  if (last.role === "assistant" && (!Array.isArray(last.content) || last.content.length === 0)) {
    return failProvider("provider returned an empty response", {
      httpStatus: lastHttpStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }
  return null;
}

/** Parse `Retry-After` from a response-headers map. RFC 7231 allows two
 * formats: integer seconds OR an HTTP-date. We honour seconds (the
 * common provider convention) and ignore HTTP-date (rare in LLM APIs).
 * Returns `undefined` when absent or malformed so the daemon falls back
 * to its equal-jitter exponential schedule. */
export function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  // Header names are case-insensitive per RFC 9110; pi-ai surfaces them
  // verbatim. Probe the common spellings first, then fall back to a
  // case-insensitive scan so a provider that capitalises differently
  // still works.
  const direct = headers["retry-after"] ?? headers["Retry-After"] ?? headers["RETRY-AFTER"];
  let raw = direct;
  if (raw === undefined) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "retry-after") {
        raw = v;
        break;
      }
    }
  }
  if (raw === undefined) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds * 1000);
}

/** Extract a leading HTTP status code from a pi-ai error message.
 *
 * pi-ai's stream surfaces a provider transport rejection (e.g. an
 * Anthropic 400 `invalid_request_error`) as a `stopReason="error"`
 * AssistantMessage whose `errorMessage` starts with the bare HTTP
 * status followed by the JSON body — for example:
 *
 *   `400 {"type":"error","error":{"type":"invalid_request_error",...}}`
 *
 * The response-header capture (`onResponse`) does not fire for this
 * class — pi-ai rejects pre-stream, so `lastHttpStatus` stays `null`
 * and the `pause_provider` outcome reaches the daemon without a
 * status. The provider-retry classifier then treats `null` as a
 * pre-response network failure (auto-retryable) and burns the full
 * chain budget against a deterministically-failing request before
 * halting with `provider_exhausted`, instead of pausing immediately
 * as `provider_error` for the operator.
 *
 * Recognise a 1xx–5xx leading token (whitespace-bounded) and return
 * it; otherwise return `null`. Conservative on purpose — a bare
 * 3-digit number inside the body must not be confused with a status
 * code. */
export function extractHttpStatusFromErrorMessage(message: string): number | null {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = /^(\d{3})(?:\s|$)/.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  if (!Number.isFinite(status) || status < 100 || status > 599) return null;
  return status;
}

/** Re-exported from `@fragua/core` so existing `@fragua/agent` importers
 * keep their import site. The single source of truth is core. */
export { ANTHROPIC_OVERLOADED_STATUS };

/** Detect an Anthropic `overloaded_error` envelope.
 *
 * Anthropic's overload can arrive mid-stream: the HTTP response already
 * returned 200 (so `onResponse` captures `lastHttpStatus = 200`) and the
 * overload then surfaces as an `error` event in the stream body whose
 * envelope is `{"type":"error","error":{"type":"overloaded_error",...}}`.
 * The `error.type` is the signal — the captured status (200) is not.
 *
 * Anchored on the envelope STRUCTURE, not a bare substring: a coincidental
 * `"type":"overloaded_error"` embedded in some other error body (an echoed
 * prior error, an upstream log) must not upgrade a manual-class failure to
 * auto-retry and burn the retry budget. So we parse and require top-level
 * `type:"error"` AND inner `error.type:"overloaded_error"`. The envelope may
 * be prefixed by a bare HTTP status (the `extractHttpStatusFromErrorMessage`
 * shape), so we parse from the first brace; a non-JSON / mismatched body
 * fails closed to `false` (manual classification, the conservative default). */
export function isOverloadedErrorMessage(message: string | undefined | null): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const brace = message.indexOf("{");
  if (brace === -1) return false;
  try {
    const parsed = JSON.parse(message.slice(brace)) as { type?: unknown; error?: { type?: unknown } };
    return parsed?.type === "error" && parsed?.error?.type === "overloaded_error";
  } catch {
    return false;
  }
}

/** Canonical auto-retryable status for a recognised transient transport
 * failure (408 Request Timeout). The provider-retry classifier already
 * treats 408 as auto-retryable. */
export const TRANSIENT_TRANSPORT_STATUS = 408;

/** A conservative, explicit set of known-transient transport-failure
 * signatures. These are bare `Error.message` strings (no JSON envelope to
 * anchor on), so we match case-insensitive substrings — but kept TIGHT and
 * specific: the failure mode this guards is a permanent error that
 * coincidentally contains a transient word, which would burn the retry
 * budget. A genuinely unknown message must NOT match (it fails open to a
 * manual, resumable pause). Grounded in what the Anthropic/OpenAI SDKs and
 * the underlying node networking stack surface. */
const TRANSIENT_TRANSPORT_SIGNATURES = [
  // request / operation timeouts. Specific phrases only — a bare
  // "timeout" matches permanent failures ("TLS handshake timeout",
  // "auth token timeout expired") and would burn the retry budget.
  "operation timed out",
  "request timed out",
  "etimedout",
  // connection drops / resets. A bare "network" matched permanent
  // failures ("network access blocked", "invalid network credentials")
  // — keep the specific "network error" phrase. ECONNREFUSED is dropped:
  // a refused connection is typically a permanent wrong-port / removed-
  // service / ACL condition, and the null-status pre-stream case is
  // already covered by `isAutoRetryableStatus(null)`.
  "socket hang up",
  "econnreset",
  "epipe",
  "network error",
  // A bare "connection error" is dropped: it matches PERMANENT failures
  // arriving mid-stream — "SSL connection error", "Proxy connection error:
  // 407", and the Anthropic SDK's APIConnectionError wrapper "Connection
  // error." over ECONNREFUSED (which must NOT auto-retry). The specific
  // "connection reset" phrase below covers the genuinely-transient drop.
  "connection reset",
] as const;

/** Detect a transient transport failure from a bare error message.
 *
 * A request/operation timeout or a dropped/reset connection can arrive
 * MID-STREAM: the HTTP response already returned 200 (so `onResponse`
 * captured `lastHttpStatus = 200`) and the transport then died. The
 * status-only classifier would route that captured 200 to a manual pause;
 * a timeout is transient and auto-retryable, so we normalise it instead.
 *
 * Only the explicitly-listed signatures match — an unknown message
 * (e.g. "An unknown error occurred") returns `false` and stays manual. */
export function isTransientTransportErrorMessage(message: string | undefined | null): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const lower = message.toLowerCase();
  return TRANSIENT_TRANSPORT_SIGNATURES.some((sig) => lower.includes(sig));
}

/** Effective HTTP status for the `pause_provider` outcome.
 *
 * An `overloaded_error` envelope normalises to the canonical 529 regardless
 * of the captured status (mid-stream overload returns 200), so the
 * status-only provider-retry classifier auto-retries it. A recognised
 * transient transport failure (timeout / connection drop) likewise
 * normalises to the auto-retryable 408 when the captured status is not
 * already auto-retryable. Otherwise the captured/extracted status passes
 * through unchanged — an unknown error keeps its captured status and stays
 * manual (the conservative, fail-open-to-resumable default). */
export function effectiveProviderHttpStatus(
  httpStatus: number | null,
  errorMessage: string | undefined | null,
): number | null {
  if (isOverloadedErrorMessage(errorMessage)) return ANTHROPIC_OVERLOADED_STATUS;
  // Already auto-retryable (null / 408 / 429 / 500–504 / 529) — leave as-is.
  if (isAutoRetryableStatus(httpStatus)) return httpStatus;
  // Any non-auto-retryable status ≥ 400 is a definitive provider rejection
  // carrying its own error envelope — keep its manual classification even
  // if the message coincidentally contains a transient-looking word. This
  // covers explicit 4xx AND the non-auto-retryable 5xx codes (505–528,
  // 530–599), matching the daemon's manual-pause classification. The
  // transient path only rescues the MID-STREAM shape (captured 2xx/3xx)
  // where the transport died after the response began. Auto-retryable
  // statuses already returned at the guard above, so a bare `>= 400`
  // here is necessarily non-auto-retryable.
  if (httpStatus !== null && httpStatus >= 400) return httpStatus;
  if (isTransientTransportErrorMessage(errorMessage)) return TRANSIENT_TRANSPORT_STATUS;
  return httpStatus;
}
