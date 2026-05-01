// Graph preparation pipeline — attractor-spec §9.1.
//
// Runs after parse and before validate / dispatch. Each transform is a
// pure (graph) -> graph rewrite. The current set:
//
//   1. applyStylesheetToGraph — fills node.attrs from `model_stylesheet`
//                                where the node lacks the property
//                                explicitly (attractor §8).
//
// New transforms register here, in the order spec §9.1 lists them.

import type { Graph } from "../types/graph.ts";
import { applyStylesheetToGraph } from "./stylesheet.ts";

export interface PrepareResult {
  graph: Graph;
  /** Errors emitted by transforms. Stylesheet syntax errors land here.
   * Callers treat any non-empty entry as a hard preparation failure;
   * the daemon halts the run, the validator surfaces them as E-codes. */
  errors: Error[];
}

/** Apply every built-in transform to a graph in attractor §9.1 order.
 * Mutates in place and returns the same Graph reference for chaining.
 * Transforms that throw are caught and reported in `errors` so a single
 * malformed transform doesn't drop the entire pipeline. */
export function prepareGraph(graph: Graph): PrepareResult {
  const errors: Error[] = [];

  // Stylesheet (attractor §8) — fills llm_model / llm_provider /
  // reasoning_effort on nodes that lack them.
  const stylesheetResult = applyStylesheetToGraph(graph);
  errors.push(...stylesheetResult.errors);

  return { graph, errors };
}
