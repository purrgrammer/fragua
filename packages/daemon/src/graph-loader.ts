// Parse-once boundary for dispatch.
//
// A workflow sha is content-addressed: its source is immutable, so the
// parsed `Graph` is too. That justifies a daemon-wide cache keyed by sha
// that never invalidates — every run on the same workflow reuses one
// parse. This loader is the ONLY place `parseWorkflow` runs on the
// dispatch path; the auto-dispatcher and the executor both consume the
// typed `Graph` it returns instead of re-parsing source.

import { type Graph, parseWorkflow } from "@fragua/core";
import type { IEventStore } from "@fragua/store";

export type GraphLoadResult = { ok: true; graph: Graph } | { ok: false; reason: "missing" | "unparseable" };

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
  const memo = new Map<string, { ok: true; graph: Graph } | { ok: false; reason: "unparseable" }>();

  return {
    load(workflowSha: string): GraphLoadResult {
      const cached = memo.get(workflowSha);
      if (cached != null) return cached;
      const workflow = store.getWorkflow(workflowSha);
      if (workflow == null) return { ok: false, reason: "missing" };
      try {
        const graph = parseWorkflow(workflow.source);
        const result = { ok: true as const, graph };
        memo.set(workflowSha, result);
        return result;
      } catch {
        const result = { ok: false as const, reason: "unparseable" as const };
        memo.set(workflowSha, result);
        return result;
      }
    },
  };
}
