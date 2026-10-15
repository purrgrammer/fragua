import { selectRunStateRow } from "./run-state-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { ClaimLostError, RunNotFoundError } from "./types.ts";

/** Reject a claim holder's write once its epoch is stale. Runs inside the
 * write txn, so the check and the write it guards see the same row. */
export function assertClaimEpoch(ctx: StoreCtx, runId: string, claimEpoch: number): void {
  const row = selectRunStateRow(ctx.db, runId);
  if (row == null) throw new RunNotFoundError(runId);
  if (row.claim_epoch !== claimEpoch) {
    throw new ClaimLostError(claimEpoch, row.claim_epoch, row.version, row.version);
  }
}
