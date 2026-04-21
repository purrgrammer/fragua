// Fidelity and thread_id resolution chains. See docs/SPEC.md §3.3.

import { DEFAULT_FIDELITY, type FidelityMode } from "../types/fidelity.ts";
import type { Edge, Graph, Node } from "../types/graph.ts";

export interface FidelityContext {
  graph: Graph;
  edge: Edge | undefined;
  targetNode: Node;
  /** Source node (used for prev-id thread fallback). */
  sourceNode?: Node;
}

/** Resolve fidelity per Attractor precedence:
 *   edge attr → target node attr → graph.default_fidelity → "compact". */
export function resolveFidelity(ctx: FidelityContext): FidelityMode {
  if (ctx.edge?.attrs.fidelity) return ctx.edge.attrs.fidelity;
  if (ctx.targetNode.attrs.fidelity) return ctx.targetNode.attrs.fidelity;
  if (ctx.graph.attrs.default_fidelity) return ctx.graph.attrs.default_fidelity;
  return DEFAULT_FIDELITY;
}

/** Resolve thread_id per Attractor precedence:
 *   target node → edge → graph → subgraph-derived class → previous node id. */
export function resolveThreadId(ctx: FidelityContext): string | undefined {
  const tn = ctx.targetNode;
  if (tn.attrs.thread_id) return tn.attrs.thread_id;
  if (ctx.edge?.attrs.thread_id) return ctx.edge.attrs.thread_id;
  if (ctx.graph.attrs.thread_id) return ctx.graph.attrs.thread_id;
  const firstClass = tn.classes[0];
  if (firstClass) return firstClass;
  return ctx.sourceNode?.id;
}
