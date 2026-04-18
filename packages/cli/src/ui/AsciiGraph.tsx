// ASCII rendering of a workflow graph for the Ink TUI. Top pane of
// `swarm dashboard`. The layout is a naive top-down layered DAG with
// boxed node labels and simple `|` risers on the edges — zero ambition
// at graphviz-quality routing, full ambition at determinism and
// legibility. Small workflows (< 20 nodes) look fine; anything bigger
// the user should reach for the web UI.
//
// Split into:
//   - `renderAsciiGraph(graph, nodeStates, activeId): string[]`
//       Pure — takes the same `Graph` the web parses + a node-state map
//       and returns one terminal line per array entry. No ANSI codes;
//       the Ink wrapper applies colour. Tested with a snapshot.
//   - `<AsciiGraph>` — Ink wrapper. Renders each line in a <Text> and
//       colours the active/running/failed nodes via the status map.
//
// The `status` map returned alongside the lines tells the component which
// cells correspond to which node so highlighting doesn't need to re-parse
// the ASCII. We key highlights by (row, box-start-col, box-end-col) and
// rewrite just those box lines with colour.

import type { Graph } from "@swarm/core";
import { Text } from "ink";
import type { JSX } from "react";
import type { NodeLifecycleState, NodeStateRecord } from "./node-state.ts";

export interface RenderedGraph {
  /** Plain-text lines — one per terminal row. No ANSI codes. */
  lines: string[];
  /**
   * Per-node placement: which rows contain which boxes and at what
   * horizontal span. The Ink wrapper uses this to paint colour without
   * re-parsing the ASCII.
   */
  nodeBoxes: NodeBox[];
}

export interface NodeBox {
  nodeId: string;
  /** Top-line row index (the `┌──┐` line). */
  topRow: number;
  /** Inclusive range of columns occupied by the box (0-based). */
  startCol: number;
  endCol: number;
  /** How many rows the box occupies (typically 3: top, label, bottom). */
  height: number;
}

const BOX_H_PAD = 2;

/**
 * Render a `Graph` to ASCII lines. Pure; deterministic in node id order.
 *
 * Layout algorithm (matches `packages/web/src/lib/graph-layout.ts` —
 * longest-path layering with in-layer sorting by id):
 *   1. depth(n) = 1 + max(depth(preds(n))), 0 for sources.
 *   2. Group nodes by depth; sort each layer by id for stability.
 *   3. Each layer becomes a horizontal row of boxes, 3-4 terminal rows
 *      tall (top border / label / optional status / bottom border).
 *   4. Between layers we draw a thin row of `|` risers — one per edge,
 *      positioned above the target node's column. Crossings are tolerated
 *      (we don't try to minimise them).
 */
export function renderAsciiGraph(
  graph: Graph,
  nodeStates: ReadonlyMap<string, NodeStateRecord>,
  activeId: string | null | undefined,
): RenderedGraph {
  // 1. Depth walk.
  const nodeIds = Object.keys(graph.nodes).sort();
  const preds = new Map<string, string[]>();
  for (const id of nodeIds) preds.set(id, []);
  for (const e of graph.edges) {
    if (!preds.has(e.to)) preds.set(e.to, []);
    if (!preds.has(e.from)) preds.set(e.from, []);
    preds.get(e.to)!.push(e.from);
  }
  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    let d = 0;
    for (const p of preds.get(id) ?? []) d = Math.max(d, depthOf(p) + 1);
    visiting.delete(id);
    depthCache.set(id, d);
    return d;
  };

  const layers: string[][] = [];
  // Every id — topology + any stray ids referenced only by edges.
  const allIds = new Set<string>(nodeIds);
  for (const e of graph.edges) {
    allIds.add(e.from);
    allIds.add(e.to);
  }
  for (const id of allIds) {
    const d = depthOf(id);
    while (layers.length <= d) layers.push([]);
    layers[d]!.push(id);
  }
  for (const layer of layers) layer.sort();

  // 2. Compute column positions per node. Each node box is
  //    BOX_H_PAD + max(label len, nodeId len) + BOX_H_PAD wide.
  //    Boxes within a layer are laid out left-to-right, gutter of 3.
  const GUTTER = 3;
  const boxPos = new Map<string, { col: number; width: number; row: number }>();
  const layerRowOf = (li: number): number => li * 4; // each layer occupies 4 rows (top,label,bottom,riser)
  for (let li = 0; li < layers.length; li++) {
    let col = 0;
    const layer = layers[li]!;
    const row = layerRowOf(li);
    for (const id of layer) {
      const label = nodeLabel(graph, id);
      const inner = Math.max(label.length, id.length);
      const width = BOX_H_PAD * 2 + inner;
      boxPos.set(id, { col, width, row });
      col += width + GUTTER;
    }
  }
  const totalRows = layers.length > 0 ? layerRowOf(layers.length - 1) + 3 : 0;
  const totalCols = Math.max(1, ...[...boxPos.values()].map((p) => p.col + p.width));

  // 3. Initialise char grid with spaces.
  const grid: string[][] = Array.from({ length: totalRows }, () => Array.from({ length: totalCols }, () => " "));

  // 4. Draw boxes.
  const nodeBoxes: NodeBox[] = [];
  for (const [id, pos] of boxPos) {
    const label = nodeLabel(graph, id);
    const inner = Math.max(label.length, id.length);
    const w = pos.width;
    const r = pos.row;
    // Top border: ┌──────┐
    grid[r]![pos.col] = "┌";
    grid[r]![pos.col + w - 1] = "┐";
    for (let c = pos.col + 1; c < pos.col + w - 1; c++) grid[r]![c] = "─";
    // Label row: │  label  │
    grid[r + 1]![pos.col] = "│";
    grid[r + 1]![pos.col + w - 1] = "│";
    const textStart = pos.col + BOX_H_PAD + Math.floor((inner - label.length) / 2);
    for (let i = 0; i < label.length; i++) grid[r + 1]![textStart + i] = label[i]!;
    // Bottom border.
    grid[r + 2]![pos.col] = "└";
    grid[r + 2]![pos.col + w - 1] = "┘";
    for (let c = pos.col + 1; c < pos.col + w - 1; c++) grid[r + 2]![c] = "─";
    nodeBoxes.push({ nodeId: id, topRow: r, startCol: pos.col, endCol: pos.col + w - 1, height: 3 });
  }

  // 5. Draw edges as vertical risers in the "riser" row between layers
  //    (row = layerRowOf(li) + 3). We draw from the source's bottom-
  //    centre down to the target's top-centre. For multi-layer spans we
  //    just drop a `│` at the target column in every riser row between;
  //    it reads clearly enough in a terminal.
  for (const e of graph.edges) {
    const from = boxPos.get(e.from);
    const to = boxPos.get(e.to);
    if (!from || !to) continue;
    const fromMidCol = from.col + Math.floor(from.width / 2);
    const toMidCol = to.col + Math.floor(to.width / 2);
    const fromBottom = from.row + 2;
    const toTop = to.row;
    // Draw a single `│` in each riser row between fromBottom and toTop.
    for (let r = fromBottom + 1; r < toTop; r++) {
      // Pick the source-column on the first riser, target-column on the last;
      // for a single-row gap draw both if they differ (creates a ʼ┐ or ʼ┘
      // visual shift). We keep it simple: draw at the target column.
      const col = r === fromBottom + 1 ? fromMidCol : toMidCol;
      if (grid[r]![col] === " ") grid[r]![col] = "│";
    }
  }

  // 6. Serialise, trimming trailing whitespace for cleaner snapshots.
  const lines = grid.map((row) => row.join("").replace(/\s+$/u, ""));

  // Annotate the node box objects with state for the renderer. Callers
  // don't need this in the snapshot, but we expose via map lookup so
  // colouring stays O(1).
  void activeId; // activeId is used by the Ink wrapper, not the plain renderer
  void nodeStates;

  return { lines, nodeBoxes };
}

function nodeLabel(graph: Graph, id: string): string {
  const n = graph.nodes[id];
  const lbl = n?.attrs?.label;
  if (typeof lbl === "string" && lbl.length > 0) return lbl;
  return id;
}

// ─────────────────────────────────────────────────────────────────────────
// Ink wrapper
// ─────────────────────────────────────────────────────────────────────────

export interface AsciiGraphProps {
  graph: Graph;
  nodeStates: ReadonlyMap<string, NodeStateRecord>;
  activeNodeId?: string | null;
}

/**
 * Render the graph inside Ink. Each terminal row becomes a `<Text>` so
 * line-wrapping never corrupts the ASCII (Ink's default wrap is "wrap",
 * which would break our carefully-aligned boxes).
 *
 * Highlight rule: if a row intersects a node's box span, colour the
 * whole row according to that node's state. State → colour mapping
 * matches the web StateBadge tone choices (running=magenta,
 * completed=green, failed=red, retrying=yellow, skipped=gray, pending=
 * default). Active node gets an additional bold weight.
 */
export function AsciiGraph(props: AsciiGraphProps): JSX.Element {
  const { graph, nodeStates, activeNodeId } = props;
  const { lines, nodeBoxes } = renderAsciiGraph(graph, nodeStates, activeNodeId);

  // Row → (nodeId, state) for colour lookup.
  const rowColour = new Map<number, { nodeId: string; state: NodeLifecycleState; active: boolean }>();
  for (const box of nodeBoxes) {
    const state = nodeStates.get(box.nodeId)?.state ?? "pending";
    const active = activeNodeId === box.nodeId;
    for (let r = box.topRow; r < box.topRow + box.height; r++) {
      rowColour.set(r, { nodeId: box.nodeId, state, active });
    }
  }

  return (
    <>
      {lines.map((line, i) => {
        const hit = rowColour.get(i);
        const colour = hit ? colourFor(hit.state) : undefined;
        const bold = hit?.active === true;
        const textProps: { color?: string; bold?: boolean } = {};
        if (colour !== undefined) textProps.color = colour;
        if (bold) textProps.bold = true;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines array is stable for a given render and drives row layout.
          <Text key={i} {...textProps}>
            {line}
          </Text>
        );
      })}
    </>
  );
}

function colourFor(state: NodeLifecycleState): string | undefined {
  switch (state) {
    case "running":
      return "magenta";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "retrying":
      return "yellow";
    case "skipped":
      return "gray";
    default:
      return undefined;
  }
}
