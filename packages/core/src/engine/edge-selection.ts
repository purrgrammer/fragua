// Edge selection: the deterministic 5-step priority.
// See docs/SPEC.md §3.8.
//
//   1. Condition-matched edges — edges whose `condition` evaluates true
//   2. Preferred label match   — outcome.preferred_label matches an
//                                unconditional edge's normalized label
//   3. Suggested next IDs      — outcome.suggested_next_ids hits an
//                                unconditional edge's target
//   4. Highest weight          — among remaining unconditional edges
//   5. Lexical tiebreak        — by target node id, ascending

import type { Edge, Graph, Node } from "../types/graph.ts";
import type { Outcome } from "../types/outcome.ts";
import { type ConditionEnv, evaluateConditionSource, isEmptyCondition } from "./condition.ts";

export type EdgeSelectionRule = "route" | "condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical";

export interface EdgeSelection {
  edge: Edge;
  rule: EdgeSelectionRule;
  /** When `rule` is "condition" or "preferred_label", the matched key. */
  matched?: string;
}

export interface EdgeSelectionInput {
  graph: Graph;
  source: Node;
  outcome: Outcome;
  context: Record<string, unknown>;
}

/** Outgoing edges of `source` in the order they appear in graph.edges. */
export function outgoingEdges(graph: Graph, sourceId: string): Edge[] {
  return graph.edges.filter((e) => e.from === sourceId);
}

/** Normalize a label for comparison: lowercase, trim, strip accelerator
 * prefixes like "[Y] ", "Y) ", "Y - ". */
export function normalizeLabel(label: string): string {
  let s = label.trim();
  // Strip accelerator prefixes
  s = s.replace(/^\[[A-Za-z0-9]\]\s*/, ""); // [Y]
  s = s.replace(/^[A-Za-z0-9]\)\s*/, ""); // Y)
  s = s.replace(/^[A-Za-z0-9]\s*-\s*/, ""); // Y -
  return s.toLowerCase();
}

/** Best edge by highest weight (descending) then lexical target id (ascending). */
function pickBestByWeightThenLexical(edges: Edge[]): Edge | undefined {
  if (edges.length === 0) return undefined;
  const sorted = [...edges].sort((a, b) => {
    const wa = a.attrs.weight ?? 0;
    const wb = b.attrs.weight ?? 0;
    if (wa !== wb) return wb - wa;
    return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
  });
  return sorted[0];
}

export function selectEdge(input: EdgeSelectionInput): EdgeSelection | undefined {
  const edges = outgoingEdges(input.graph, input.source.id);
  if (edges.length === 0) return undefined;

  // Step 0 (route): when the source is a routing node (declares
  // `routes=`) and the outcome carries a chosen route, find the edge
  // keyed `route=<name>`. Routing nodes are an exclusive surface —
  // unmatched route is a structural failure, not a fall-through to
  // outcome / condition edges. See docs/proposals/llm-routing.md D10.
  const sourceRoutes = input.source.attrs.routes;
  if (
    Array.isArray(sourceRoutes) &&
    sourceRoutes.length > 0 &&
    typeof input.outcome.route === "string" &&
    input.outcome.route.length > 0
  ) {
    const chosen = input.outcome.route;
    const match = edges.find((e) => e.attrs.route === chosen);
    if (match) return { edge: match, rule: "route", matched: chosen };
    return undefined;
  }

  const env: ConditionEnv = {
    outcome: input.outcome.status,
    context: { ...input.context } as ConditionEnv["context"],
  };

  // Step 1: condition matching. Two surfaces pool together:
  //   (a) `condition="outcome=X && …"` DSL edges — the legacy authoring
  //       form; `matched` carries the literal condition string.
  //   (b) `outcome=<success|fail>` attribute edges (Phase 1 of
  //       llm-routing.md) — implicit condition match on outcome status;
  //       `matched` left undefined since there is no source expression.
  // Both share the same `pickBestByWeightThenLexical` tiebreak so a
  // mixed graph still routes deterministically.
  const conditional: { edge: Edge; matched: string | undefined }[] = [];
  for (const e of edges) {
    const cond = e.attrs.condition;
    if (!isEmptyCondition(cond)) {
      if (evaluateConditionSource(cond!, env)) conditional.push({ edge: e, matched: cond! });
      continue;
    }
    const outcomeAttr = e.attrs.outcome;
    if (typeof outcomeAttr === "string" && outcomeAttr === input.outcome.status) {
      conditional.push({ edge: e, matched: undefined });
    }
  }
  if (conditional.length > 0) {
    const best = pickBestByWeightThenLexical(conditional.map((c) => c.edge))!;
    const matchedEntry = conditional.find((c) => c.edge === best)!;
    const selection: EdgeSelection = { edge: best, rule: "condition" };
    if (matchedEntry.matched !== undefined) selection.matched = matchedEntry.matched;
    return selection;
  }

  // `outcome=fail` must NOT silently fall through to unconditional success
  // edges. If no condition-matched edge claimed the fail outcome, return
  // undefined so the executor halts (fact.run_halted via the
  // outcomeStatus="fail" + terminal-nextNode branch in result-to-facts).
  // Authors recovering from failure declare an explicit
  // `condition="outcome=fail"` edge; absence of one is the halt signal.
  if (input.outcome.status === "fail") return undefined;

  // Candidate pool for remaining steps: edges with neither a condition
  // nor an `outcome=` attribute. Outcome-attr edges that didn't match
  // the status are exclusive (like condition edges) — they don't fall
  // through to the weight/lexical tiebreak.
  const unconditional = edges.filter((e) => isEmptyCondition(e.attrs.condition) && e.attrs.outcome === undefined);

  // Step 2: preferred_label match (first match wins in graph source order)
  if (input.outcome.preferred_label) {
    const want = normalizeLabel(input.outcome.preferred_label);
    for (const e of unconditional) {
      const lbl = e.attrs.label;
      if (lbl && normalizeLabel(lbl) === want) {
        return { edge: e, rule: "preferred_label", matched: lbl };
      }
    }
  }

  // Step 3: suggested_next_ids (first id that matches an unconditional edge target)
  if (input.outcome.suggested_next_ids.length > 0) {
    for (const id of input.outcome.suggested_next_ids) {
      for (const e of unconditional) {
        if (e.to === id) return { edge: e, rule: "suggested_next_ids", matched: id };
      }
    }
  }

  // Step 4 + 5: highest weight, lexical tiebreak
  const best = pickBestByWeightThenLexical(unconditional);
  if (!best) return undefined;

  // Decide the rule label: lexical only if there's a tie on weight among at
  // least two unconditional edges; otherwise weight decided it.
  const weights = unconditional.map((e) => e.attrs.weight ?? 0);
  const maxWeight = Math.max(...weights);
  const tied = unconditional.filter((e) => (e.attrs.weight ?? 0) === maxWeight);
  const rule: EdgeSelectionRule = tied.length > 1 ? "lexical" : "weight";
  return { edge: best, rule };
}
