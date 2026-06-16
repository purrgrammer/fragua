// The terminal result envelope `fragua ci --json` emits as its final line, and
// the same object written into the `--export` bundle (`runs/<id>/result.json`).
// It is the one wire surface the Ernesto `kind: 'fragua'` handler reads
// (docs/proposals/ernesto-interop.md §5.4): the handler keys on `status` for
// its `HandlerResult` and binds `outputs` into the DAG.
//
// Distinguishable from the per-event JSONL lines by construction: every event
// line is a `StoredEvent` carrying a numeric `seq` and a string `type`; the
// result line carries neither and is tagged `kind: "fragua.run_result"`.

import type { ReadPlane } from "@fragua/core/read-plane";
import { isTerminal, type RunStatus } from "@fragua/types";

/** The converged terminal status (fact-taxonomy.md §3.1). fragua's three
 *  terminal facts map onto it: `run_completed` → `completed`, `run_halted` →
 *  `errored`, `run_cancelled` → `aborted`. */
export type CiTerminalStatus = "completed" | "errored" | "aborted";

/** Run-total cost — the same totals `fragua runs status` reports. */
export interface CiUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CiRunResult {
  /** Discriminator: marks this line as the terminal envelope, never an event. */
  kind: "fragua.run_result";
  runId: string;
  status: CiTerminalStatus;
  /** The run-level typed-partial output envelope (structured-outputs §11).
   *  Absent keys stay omitted; the whole field is omitted when the workflow
   *  declares no run-level `outputs:` (or none populated on the taken path). */
  outputs?: Record<string, unknown>;
  usage: CiUsage;
}

/** Map a fragua terminal `RunStatus` to the converged wire status. Returns
 *  `undefined` for the non-terminal statuses (paused / halted-mid-retry never
 *  reach here; the only terminals are completed / cancelled / halted). */
function terminalStatus(status: RunStatus): CiTerminalStatus | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "halted":
      return "errored";
    case "cancelled":
      return "aborted";
    default:
      return undefined;
  }
}

/** Build the terminal result envelope for `runId` from the read plane, or
 *  `undefined` when the run has NOT reached a terminal state (the envelope is
 *  terminal-only — a paused / quarantined run keeps its existing exit code and
 *  emits no line). `outputs` reuses the read-plane projection
 *  (`RunDetail.outputs` / `projectRunOutputs`); `usage` reuses the same SQL
 *  cost rollup `runs status` reads off `RunDetail`. */
export function buildCiResult(readPlane: ReadPlane, runId: string, status: RunStatus): CiRunResult | undefined {
  if (!isTerminal(status)) return undefined;
  const wire = terminalStatus(status);
  if (wire === undefined) return undefined;
  const detail = readPlane.runDetail(runId);
  if (detail == null) return undefined;
  const result: CiRunResult = {
    kind: "fragua.run_result",
    runId,
    status: wire,
    usage: {
      inputTokens: detail.inputTokens,
      outputTokens: detail.outputTokens,
      costUsd: detail.costUsd,
    },
  };
  if (detail.outputs !== undefined) result.outputs = detail.outputs;
  return result;
}
