// thread_id resolution chain. See docs/SPEC.md §3.3.

import type { Edge, Graph, Node } from "../types/graph.ts";

export interface ThreadContext {
  graph: Graph;
  edge: Edge | undefined;
  targetNode: Node;
  /** Source node (used for prev-id thread fallback). */
  sourceNode?: Node;
}

/** Resolve thread_id per precedence:
 *   target node → edge → graph → previous node id.
 *
 * Threads are the only context-sharing primitive: a node with a resolved
 * thread_id hydrates the prior transcript for that thread (full history);
 * a node without one runs against a fresh context. `summary=low|medium|high`
 * on the receiving node opts that node into summariser compression. */
export function resolveThreadId(ctx: ThreadContext): string | undefined {
  const tn = ctx.targetNode;
  if (tn.attrs.thread_id) return tn.attrs.thread_id;
  if (ctx.edge?.attrs.thread_id) return ctx.edge.attrs.thread_id;
  if (ctx.graph.attrs.thread_id) return ctx.graph.attrs.thread_id;
  return ctx.sourceNode?.id;
}
