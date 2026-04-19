// Layered DAG layout used by `GraphView`. Kept tiny and dep-free: the
// workflows we render are small (< 20 nodes) so a naive longest-path
// layering beats pulling in Dagre/Elk for the bundle cost.
//
// Algorithm:
//   1. Start with the node set from `nodes` plus any node ids appearing
//      in `edges` that weren't in `nodes` (defensive — the DOT source
//      and the event stream can disagree for aborted runs).
//   2. For each node, compute depth = 1 + max(depth(predecessors)) with
//      depth = 0 for sources. Memoised so cycles degrade gracefully.
//   3. Bucket by depth to produce layers; sort each layer by id so
//      layout is stable across renders (React-Flow is position-driven
//      and shifts look like "animations" if we let the order jitter).
//   4. Project depth onto the primary axis and index-within-layer onto
//      the secondary axis. `orientation: "TB"` (default) puts the
//      longest path vertically so workflows read top-to-bottom —
//      matches how humans read a DAG and how DOT is usually drawn.
//
// Output matches `@xyflow/react`'s `Node`/`Edge` shape closely enough
// to hand straight to `<Canvas nodes={...} edges={...} />`.

export interface LayoutInput {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
}

export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

export type LayoutOrientation = "TB" | "LR";

export interface LayoutOptions {
  /** Spacing along the flow direction (row height for TB, column width for LR). */
  layerSize?: number;
  /** Spacing perpendicular to the flow (column width for TB, row height for LR). */
  crossSize?: number;
  /**
   * Flow direction. `"TB"` (top → bottom, the default) mirrors the way
   * swarm DOT workflows read on paper; `"LR"` is kept for the few
   * places a horizontal strip is more useful. Left-to-right is the
   * legacy default — new views should stay on `"TB"`.
   */
  orientation?: LayoutOrientation;
}

export function layoutDag(input: LayoutInput, opts: LayoutOptions = {}): PositionedNode[] {
  const orientation: LayoutOrientation = opts.orientation ?? "TB";
  // Defaults tuned for TB: layer spacing (vertical) tighter than cross
  // spacing (horizontal) so siblings fan out without burying the flow.
  // LR defaults keep the older values so existing callers don't shift.
  const layerSize = opts.layerSize ?? (orientation === "TB" ? 140 : 260);
  const crossSize = opts.crossSize ?? (orientation === "TB" ? 280 : 120);

  const ids = new Set<string>();
  for (const n of input.nodes) ids.add(n.id);
  for (const e of input.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }

  const predecessors = new Map<string, string[]>();
  for (const id of ids) predecessors.set(id, []);
  for (const e of input.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    predecessors.get(e.to)?.push(e.from);
  }

  const depthCache = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      // Cycle: break by returning 0 for this re-entry. The outer walk
      // will memoise a non-zero answer for the first path through.
      return 0;
    }
    visiting.add(id);
    const preds = predecessors.get(id) ?? [];
    let d = 0;
    for (const p of preds) {
      d = Math.max(d, depthOf(p) + 1);
    }
    visiting.delete(id);
    depthCache.set(id, d);
    return d;
  };

  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = depthOf(id);
    const bucket = byDepth.get(d) ?? [];
    bucket.push(id);
    byDepth.set(d, bucket);
  }

  const out: PositionedNode[] = [];
  for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...bucket].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    sorted.forEach((id, i) => {
      const along = depth * layerSize;
      // Centre each layer around the perpendicular axis origin so short
      // layers don't pile up to one side.
      const across = (i - (sorted.length - 1) / 2) * crossSize;
      const position = orientation === "TB" ? { x: across, y: along } : { x: along, y: across };
      out.push({ id, position });
    });
  }
  return out;
}
