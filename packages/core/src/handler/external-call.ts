import { sha256Hex } from "@swarm/store";
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
 *   idempotencyKey = sha256(runId + nodeId + iteration + argsHash + attempt)
 *
 * The sequence is:
 *   1. Record fact.side_effect_intent (executor commits before fn runs).
 *   2. Invoke fn(idempotencyKey); the handler is expected to pass the key
 *      to the provider via Idempotency-Key (or equivalent).
 *   3. On success: record fact.side_effect_done and return the result.
 *   4. On clean failure: record fact.side_effect_failed and rethrow.
 *   5. On AbortError: do NOT record done/failed — the executor emits
 *      fact.node_aborted; startup sweep will quarantine on replay if the
 *      crash-window orphaned the intent.
 */
export function makeExternalCall(opts: MakeExternalCallOpts): ExternalCall {
  return async function externalCall<T>(
    params: ExternalCallParams,
    fn: (idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const attempt = params.attempt ?? 1;
    const idempotencyKey = sha256Hex(
      `${opts.runId}\x00${opts.nodeId}\x00${opts.iteration}\x00${params.argsHash}\x00${attempt}`,
    );

    opts.recorder.recordIntent({
      toolName: params.toolName,
      argsHash: params.argsHash,
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
