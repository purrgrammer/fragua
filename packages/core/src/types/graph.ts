// Graph model: Nodes, Edges, and the Graph itself. See docs/SPEC.md §3.1.

import type { FidelityMode } from "./fidelity.ts";

/** Attractor node shapes, each mapping to a handler. */
export type NodeShape =
  | "Mdiamond" // start
  | "Msquare" // exit
  | "box" // codergen (default)
  | "diamond" // conditional
  | "hexagon" // wait.human
  | "component" // parallel
  | "tripleoctagon" // parallel.fan_in
  | "parallelogram" // tool
  | "house" // stack.manager_loop
  | "trapezium"; // loop

export const HANDLER_BY_SHAPE = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  diamond: "conditional",
  hexagon: "wait.human",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
  trapezium: "loop",
} as const satisfies Record<NodeShape, string>;

export type HandlerType = (typeof HANDLER_BY_SHAPE)[NodeShape];

export type ContextMode = "fresh" | "shared";

/** Attribute values that survive DOT parsing + coercion. */
type AttrScalar = string | number | boolean | string[];

export interface NodeAttrs {
  label?: string;
  shape?: NodeShape;
  type?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  fidelity?: FidelityMode;
  thread_id?: string;
  goal_gate?: boolean;
  max_retries?: number;
  timeout?: string;
  idle_timeout?: number;
  reasoning_effort?: "low" | "medium" | "high";
  context?: ContextMode;
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Files read from the target project root and prepended to the agent's
   * system prompt as `<project-conventions>` blocks. Comma-separated in DOT. */
  context_files?: string[];
  class?: string;
  retry_target?: string;
  fallback_retry_target?: string;
  auto_status?: boolean;
  allow_partial?: boolean;
  /** Loop-node config (trapezium shape). */
  until?: string;
  max_iterations?: number;
  fresh_context?: boolean;
  /** Parallel-node config (component shape). */
  fan_in?: string;
  join_policy?: "wait_all" | "first_success";
  [extra: string]: AttrScalar | undefined;
}

export interface EdgeAttrs {
  label?: string;
  condition?: string;
  weight?: number;
  fidelity?: FidelityMode;
  thread_id?: string;
  loop_restart?: boolean;
  [extra: string]: AttrScalar | undefined;
}

export interface GraphAttrs {
  goal?: string;
  label?: string;
  default_fidelity?: FidelityMode;
  default_max_retries?: number;
  retry_target?: string;
  fallback_retry_target?: string;
  /** Cap how many times a failing goal gate routes back to `retry_target`.
   * Default 3. Prevents runaway retry loops when the retry target itself
   * keeps failing for the same reason. */
  max_goal_gate_retries?: number;
  model_stylesheet?: string;
  thread_id?: string;
  "tool_hooks.pre"?: string;
  "tool_hooks.post"?: string;
  [extra: string]: AttrScalar | undefined;
}

export interface Location {
  line: number;
  col: number;
}

export interface Node {
  id: string;
  shape: NodeShape;
  attrs: NodeAttrs;
  /** Class list derived from subgraph membership + explicit `class` attr. */
  classes: string[];
  /** Location in source for error reporting (1-indexed line/column). */
  loc?: Location;
}

export interface Edge {
  from: string;
  to: string;
  attrs: EdgeAttrs;
  loc?: Location;
}

export interface Subgraph {
  id: string;
  label?: string;
  /** CSS-like class derived from the label (e.g. `label="Loop A"` → `loop-a`). */
  derived_class?: string;
  node_ids: string[];
  node_defaults: NodeAttrs;
}

export interface Graph {
  id: string;
  /** "digraph" is the only supported graph kind. */
  directed: true;
  attrs: GraphAttrs;
  nodes: Record<string, Node>;
  edges: Edge[];
  subgraphs: Subgraph[];
}

export function handlerOf(node: Node): HandlerType {
  return HANDLER_BY_SHAPE[node.shape];
}

export function isTerminal(node: Node): boolean {
  return node.shape === "Mdiamond" || node.shape === "Msquare";
}
