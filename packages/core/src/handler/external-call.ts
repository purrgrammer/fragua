import { sha256Hex } from "@swarm/store";
import { canonicalStringify } from "./canonical-stringify.ts";
import type { ExternalCall, ExternalCallParams, SideEffectRecorder } from "./types.ts";

export interface MakeExternalCallOpts {
  runId: string;
  nodeId: string;
  iteration: number;
  recorder: SideEffectRecorder;
}

/**
 * Build the canonical externalCall helper for a single node execution.
 *
 *   argsHash       = sha256(canonicalStringify(params.args))
 *   idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)
 *
 * Canonicalisation lives inside the framework so two handlers that build
 * structurally-equal args via different code paths still produce the
 * same idempotency key. Handlers never compute `argsHash` themselves —
 * they pass `args: unknown` and trust the framework.
 *
 * The sequence is:
 *   1. recorder.recordIntent commits fact.side_effect_intent in its own
 *      short transaction BEFORE fn runs. A SIGKILL/OOM/panic during fn
 *      therefore leaves the intent durably on disk; the next daemon
 *      startup-sweep finds the orphan and quarantines the run. (The
 *      recorder's pre-commit semantics are what backs ARCHITECTURE.md
 *      §1.1's at-most-once guarantee for non-idempotent providers — a
 *      buffered recorder would lose the intent on hard crash and the
 *      sweep would have nothing to find.)
 *   2. Invoke fn(idempotencyKey); the handler is expected to pass the key
 *      to the provider via Idempotency-Key (or equivalent).
 *   3. On success: recorder.recordDone commits fact.side_effect_done and
 *      we return the result.
 *   4. On clean failure: recorder.recordFailed commits
 *      fact.side_effect_failed and we rethrow.
 *   5. On AbortError: do NOT record done/failed — the intent stays on
 *      disk without a matching terminator, so the next sweep quarantines.
 */
export function makeExternalCall(opts: MakeExternalCallOpts): ExternalCall {
  return async function externalCall<T>(
    params: ExternalCallParams,
    fn: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const attempt = params.attempt ?? 1;
    const argsHash = sha256Hex(canonicalStringify(params.args));
    const idempotencyKey = sha256Hex(
      `${opts.runId}\x00${opts.nodeId}\x00${opts.iteration}\x00${argsHash}\x00${attempt}`,
    );

    opts.recorder.recordIntent({
      toolName: params.toolName,
      argsHash,
      attempt,
      idempotencyKey,
    });

    let result: T;
    try {
      result = await fn(idempotencyKey);
    } catch (err) {
      if (isAbortError(err)) throw err;
      opts.recorder.recordFailed({
        idempotencyKey,
        errorCode: errorCodeOf(err),
        retriable: isRetriable(err),
      });
      throw err;
    }

    // Caller is responsible for invoking artifacts.put() to produce an
    // artifactKey and then calling recorder.recordDone() themselves if they
    // need custom accounting. The default path is a simple "no artifact"
    // DONE record.
    opts.recorder.recordDone({
      idempotencyKey,
      artifactKey: `${opts.nodeId}:${params.toolName}`,
    });
    return result;
  };
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}

function errorCodeOf(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return "Unknown";
}

function isRetriable(err: unknown): boolean {
  // Conservative default. Executors may upgrade with provider knowledge later.
  if (err instanceof Error && /network|timeout|ETIMEDOUT|ECONNRESET/i.test(err.message)) {
    return true;
  }
  return false;
}
