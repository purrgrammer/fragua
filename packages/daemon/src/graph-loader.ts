// Graph-load boundary for dispatch.
//
// A workflow sha is content-addressed: its source — and the IR minted from it
// — are immutable, so the loaded `Graph` is too. That justifies a daemon-wide
// cache keyed by sha that never invalidates. The auto-dispatcher and the
// executor both consume the typed `Graph` it returns.
//
// The Graph comes from the persisted canonical IR (proposal workflow-ir,
// move A): parsing happens ONCE at mint (upload / schedule fire), and the
// loader only DESERIALIZES `workflow.ir` — it never parses source. The IR is
// the parse output with `loc` (validator-only) stripped, so it's
// executor-equivalent.

import { CURRENT_IR_VERSION, convertIr, type Graph } from "@fragua/core";
import type { IEventStore, WorkflowRow } from "@fragua/store";

export type GraphLoadResult =
  | { ok: true; graph: Graph }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "unparseable"; errorMessage: string };

export interface GraphLoader {
  load(workflowSha: string): GraphLoadResult;
}

/**
 * Build a sha-keyed graph loader over the store. Memoizes `ok` and
 * `unparseable` results forever (a sha's source can't change). A
 * `missing` row is NOT memoized — a workflow can be uploaded after a
 * loader is built (tests insert rows late), so each `missing` re-queries
 * the store. This preserves the executor's missing-vs-unparseable split:
 * a missing row routes the run to its `__end__` fallback without halting,
 * while an unparseable source halts.
 */
export function makeGraphLoader(store: Pick<IEventStore, "getWorkflow">): GraphLoader {
  const memo = new Map<
    string,
    { ok: true; graph: Graph } | { ok: false; reason: "unparseable"; errorMessage: string }
  >();

  return {
    load(workflowSha: string): GraphLoadResult {
      const cached = memo.get(workflowSha);
      if (cached != null) return cached;
      const workflow = store.getWorkflow(workflowSha);
      if (workflow == null) return { ok: false, reason: "missing" };
      try {
        const graph = graphFromRow(workflow);
        const result = { ok: true as const, graph };
        memo.set(workflowSha, result);
        return result;
      } catch (err) {
        const result = {
          ok: false as const,
          reason: "unparseable" as const,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        memo.set(workflowSha, result);
        return result;
      }
    },
  };
}

/** Deserialize the persisted IR. A future `ir_version` ahead of this runtime
 * is treated as unparseable (no down-conversion) rather than mis-executed.
 * An older IR version is up-converted via the converter chain before
 * deserialisation so the executor always sees a current-version Graph. */
function graphFromRow(workflow: WorkflowRow): Graph {
  if (workflow.irVersion > CURRENT_IR_VERSION) {
    throw new Error(`workflow ir_version ${workflow.irVersion} > supported ${CURRENT_IR_VERSION}`);
  }
  let irJson: unknown;
  if (workflow.irVersion < CURRENT_IR_VERSION) {
    const converted = convertIr(JSON.parse(workflow.ir) as unknown, workflow.irVersion);
    irJson = converted.json;
  } else {
    irJson = JSON.parse(workflow.ir) as unknown;
  }
  return irJson as Graph;
}
