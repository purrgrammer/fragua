// Parse a workflow source string for client-side rendering. Thin wrapper
// around `@swarm/core`'s `parseWorkflow` — exists as a stable seam in
// case future transforms (variable expansion, schema migrations) need
// to layer in before the GraphView consumes the IR.

import { type Graph, parseWorkflow } from "@swarm/core";

export function parseAndPrepare(source: string): Graph {
  return parseWorkflow(source);
}
