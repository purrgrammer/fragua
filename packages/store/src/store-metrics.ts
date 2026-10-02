import { type JudgeAnswerRow, selectJudgeMessages } from "./message-queries.ts";
import type { MetricsSnapshot } from "./metrics.ts";
import type { StoreCtx } from "./store-ctx.ts";

export function metricsSnapshot(ctx: StoreCtx): MetricsSnapshot {
  return ctx.metrics.snapshot();
}

/** Every recorded `judge_node` message, optionally narrowed to one workflow
 * by display name. Read-only history for `fragua judge calibrate`. */
export function getJudgeMessages(ctx: StoreCtx, workflowName?: string): JudgeAnswerRow[] {
  return selectJudgeMessages(ctx.db, workflowName);
}
