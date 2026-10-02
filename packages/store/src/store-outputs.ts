import {
  getLatestOutput as queryLatestOutput,
  getLatestOutputBatch as queryLatestOutputBatch,
  getOutputsForRun as queryOutputsForRun,
} from "./outputs-queries.ts";
import { materializeStructJson } from "./routing-blobs.ts";
import type { StoreCtx } from "./store-ctx.ts";

export function getOutputsForRun(
  ctx: StoreCtx,
  runId: string,
): Array<{ nodeId: string; iteration: number; struct: string }> {
  const out: Array<{ nodeId: string; iteration: number; struct: string }> = [];
  for (const r of queryOutputsForRun(ctx.db, runId)) {
    try {
      out.push({ ...r, struct: materializeStructJson(r.struct, (sha) => ctx.blobs.get(sha)) });
    } catch {
      // A spilled output whose blob is missing/corrupt: drop the row rather
      // than throw. A downstream `${{ outputs.X.f }}` read then fails closed
      // (a clean node failure) instead of crashing the dispatch, and the UI
      // simply omits the unreadable output.
    }
  }
  return out;
}

export function getLatestOutput(ctx: StoreCtx, runId: string, nodeId: string): string | null {
  const struct = queryLatestOutput(ctx.db, runId, nodeId);
  if (struct === null) return null;
  try {
    return materializeStructJson(struct, (sha) => ctx.blobs.get(sha));
  } catch {
    // Missing/corrupt spilled blob — surface as "no output" so the caller
    // fails closed rather than throwing.
    return null;
  }
}

export function getLatestOutputBatch(ctx: StoreCtx, runId: string, nodeIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { nodeId, struct } of queryLatestOutputBatch(ctx.db, runId, nodeIds)) {
    try {
      out.set(
        nodeId,
        materializeStructJson(struct, (sha) => ctx.blobs.get(sha)),
      );
    } catch {
      // Missing/corrupt spilled blob — omit the node so the caller treats it
      // as "no output" (fails closed), matching `getLatestOutput`.
    }
  }
  return out;
}
