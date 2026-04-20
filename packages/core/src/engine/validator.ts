// Graph linter. Catches structural and semantic issues before execution.
// See docs/SPEC.md §4.1 (validation phase).

import type { Edge, Graph } from "../types/graph.ts";

function isEmptyCondition(cond: string | undefined): boolean {
  return !cond || cond.trim() === "";
}

const NODE_OUTPUT_RE = /\$([A-Za-z_][A-Za-z0-9_-]*)\.output(?:\.|\b)/g;

function collectReferences(template: string): { nodeIds: string[] } {
  const nodeIds: string[] = [];
  for (const m of template.matchAll(NODE_OUTPUT_RE)) {
    const id = m[1];
    if (id && !nodeIds.includes(id)) nodeIds.push(id);
  }
  return { nodeIds };
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** Optional node or edge reference for UI highlighting. */
  nodeId?: string;
  edge?: { from: string; to: string };
  loc?: { line: number; col: number };
}

export interface ValidateOptions {
  /** Treat warnings as errors (useful for CI). */
  strict?: boolean;
}

export class ValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(`graph validation failed: ${diagnostics.length} issues`);
    this.name = "ValidationError";
  }
}

export function validate(graph: Graph, opts: ValidateOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];

  const nodes = Object.values(graph.nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const starts = nodes.filter((n) => n.shape === "Mdiamond");
  const exits = nodes.filter((n) => n.shape === "Msquare");

  // E001: start node required
  if (starts.length === 0) {
    diags.push({ severity: "error", code: "E001", message: "graph has no start node (Mdiamond)" });
  }
  if (starts.length > 1) {
    diags.push({
      severity: "error",
      code: "E002",
      message: `graph has multiple start nodes: ${starts.map((s) => s.id).join(", ")}`,
    });
  }

  // E003: exit node required
  if (exits.length === 0) {
    diags.push({ severity: "error", code: "E003", message: "graph has no exit node (Msquare)" });
  }

  // E004: edge references undefined node
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined source node "${e.from}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
    if (!nodeIds.has(e.to)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined target node "${e.to}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // W001: orphan node (no in-edges, not start)
  const inDegrees = new Map<string, number>();
  for (const n of nodes) inDegrees.set(n.id, 0);
  for (const e of graph.edges) {
    inDegrees.set(e.to, (inDegrees.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.shape === "Mdiamond") continue;
    if ((inDegrees.get(n.id) ?? 0) === 0) {
      diags.push({
        severity: "warning",
        code: "W001",
        message: `node "${n.id}" has no incoming edges (orphan)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W002: unreachable from start
  if (starts.length === 1) {
    const reachable = reachableSet(graph, starts[0]!.id);
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        diags.push({
          severity: "warning",
          code: "W002",
          message: `node "${n.id}" is not reachable from start`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // W003: no fail-edge (or unconditional fallback) from codergen/tool nodes
  // with only conditional edges. A run can silently terminate otherwise.
  for (const n of nodes) {
    if (n.shape === "Mdiamond" || n.shape === "Msquare") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) continue; // terminal behaviour ok; engine handles
    const anyUnconditional = out.some((e) => isEmptyCondition(e.attrs.condition));
    const anyFailCondition = out.some((e) => (e.attrs.condition ?? "").includes("outcome=fail"));
    if (!anyUnconditional && !anyFailCondition) {
      diags.push({
        severity: "warning",
        code: "W003",
        message: `node "${n.id}" has only conditional edges and no "outcome=fail" catch-all; run may silently terminate on failure`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W004: unresolved $nodeId.output references
  for (const n of nodes) {
    const prompt = n.attrs.prompt;
    if (typeof prompt !== "string") continue;
    const refs = collectReferences(prompt);
    for (const id of refs.nodeIds) {
      if (!nodeIds.has(id)) {
        diags.push({
          severity: "error",
          code: "E005",
          message: `node "${n.id}" references unknown node "$${id}.output"`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E007: parallel node (component) must have a valid fan_in (explicit or inferable)
  for (const n of nodes) {
    if (n.shape !== "component") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) {
      diags.push({
        severity: "error",
        code: "E007",
        message: `parallel node "${n.id}" has no outgoing branches`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
      continue;
    }
    const fanInAttr = n.attrs.fan_in;
    if (typeof fanInAttr === "string") {
      const fi = graph.nodes[fanInAttr];
      if (!fi) {
        diags.push({
          severity: "error",
          code: "E007",
          message: `parallel "${n.id}" fan_in="${fanInAttr}" not found`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      } else if (fi.shape !== "tripleoctagon") {
        diags.push({
          severity: "error",
          code: "E007",
          message: `parallel "${n.id}" fan_in="${fanInAttr}" must be tripleoctagon (got ${fi.shape})`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E008: tool node (parallelogram) must carry a non-empty `tool_command`.
  // Without it the executor has nothing to spawn and halts at dispatch.
  for (const n of nodes) {
    if (n.shape !== "parallelogram") continue;
    const cmd = n.attrs.tool_command;
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      diags.push({
        severity: "error",
        code: "E008",
        message: `tool node "${n.id}" must define a non-empty \`tool_command\` attribute`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W005: duplicate edges (same from/to pair with identical attributes)
  const seen = new Map<string, Edge>();
  for (const e of graph.edges) {
    const key = `${e.from}→${e.to}:${JSON.stringify(e.attrs)}`;
    if (seen.has(key)) {
      diags.push({
        severity: "warning",
        code: "W005",
        message: `duplicate edge "${e.from}" → "${e.to}" with identical attributes`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    } else {
      seen.set(key, e);
    }
  }

  // W006: cycles without an exit reachable from the cycle
  const exitIds = new Set(exits.map((e) => e.id));
  for (const sccNodes of stronglyConnectedComponents(graph)) {
    if (sccNodes.length < 2 && !hasSelfLoop(graph, sccNodes[0]!)) continue; // not a cycle
    const reachable = reachableFromSet(graph, sccNodes);
    const hasExit = [...reachable].some((id) => exitIds.has(id));
    if (!hasExit) {
      diags.push({
        severity: "error",
        code: "E006",
        message: `cycle ${sccNodes.join(" → ")} has no reachable exit node`,
      });
    }
  }

  if (opts.strict) {
    return diags.map((d) => (d.severity === "warning" ? { ...d, severity: "error" as const } : d));
  }
  return diags;
}

/** Throw if any `error`-severity diagnostics exist. */
export function validateOrThrow(graph: Graph, opts: ValidateOptions = {}): void {
  const diags = validate(graph, opts);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new ValidationError(diags);
}

function reachableSet(graph: Graph, startId: string): Set<string> {
  return reachableFromSet(graph, [startId]);
}

function reachableFromSet(graph: Graph, startIds: string[]): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of graph.edges) {
      if (e.from === id && !visited.has(e.to)) stack.push(e.to);
    }
  }
  return visited;
}

function hasSelfLoop(graph: Graph, nodeId: string): boolean {
  return graph.edges.some((e) => e.from === nodeId && e.to === nodeId);
}

/** Tarjan's algorithm for strongly connected components. */
function stronglyConnectedComponents(graph: Graph): string[][] {
  const nodes = Object.keys(graph.nodes);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const out: string[][] = [];

  const neighbors = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);

  function strongConnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of neighbors(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  }

  for (const v of nodes) if (!index.has(v)) strongConnect(v);
  return out;
}
