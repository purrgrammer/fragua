// Parse + prepare a workflow's DOT source for client-side rendering.
//
// `parseWorkflow` alone returns the raw graph; the §8 model_stylesheet
// cascade lives in a separate `prepareGraph` pass that the daemon runs
// before dispatch. Without this helper, web callers see `node.attrs`
// missing every llm_model/llm_provider/reasoning_effort that came from a
// `* { … }` / `.class { … }` / `#id { … }` rule, and the GraphView model
// badge silently disappears for stylesheet-only workflows.
//
// Stylesheet parse errors are non-fatal here — the daemon still surfaces
// them as the source of truth via E015 / run halts. We only render.

import { type Graph, parseWorkflow, prepareGraph } from "@swarm/core";

export function parseAndPrepare(source: string): Graph {
  const graph = parseWorkflow(source);
  const { errors } = prepareGraph(graph);
  if (errors.length > 0) {
    console.warn(
      "[parseAndPrepare] model_stylesheet errors:",
      errors.map((e) => e.message),
    );
  }
  return graph;
}
