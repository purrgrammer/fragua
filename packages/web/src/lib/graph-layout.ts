// Left-to-right DAG layout used by `GraphView`. Kept tiny and dep-free:
// the workflows we render are small (< 20 nodes) so a naive layered layout
// beats pulling in Dagre/Elk for the bundle cost.
//
// Algorithm (classic "longest-path" layering):
//   1. Start with the node set from `nodes` plus any node ids appearing in
//      `edges` that weren't in `nodes` (defensive — the DOT source and the
//      event stream can disagree for aborted runs).
//   2. For each node, compute depth = 1 + max(depth(predecessors)) with
//      depth = 0 for sources. Memoised so cycles degrade gracefully (the
//      memo short-circuits on re-entry and the cycle closer keeps its
//      earliest depth).
//   3. Bucket by depth to produce columns; sort each column by id so
//      layout is stable across renders (React-Flow is position-driven and
//      shifts look like "animations" if we let the order jitter).
//
// Output matches `@xyflow/react`'s `Node`/`Edge` shape closely enough to
// hand straight to `<Canvas nodes={...} edges={...} />`.

export interface LayoutInput {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string }>;
}

export interface PositionedNode {
  id: string;
  position: { x: number; y: number };
}

export interface LayoutOptions {
  /** Horizontal spacing between layers, px. */
  colWidth?: number;
  /** Vertical spacing between nodes within a layer, px. */
  rowHeight?: number;
}

/**
 * Deterministic left-to-right layered layout.
 *
 * Returns positions in `@xyflow/react`'s coordinate system (origin
 * top-left, y-down). Callers merge these with their own node/edge
 * metadata — this module is intentionally ignorant of node state, colour,
 * etc. so it can be unit-tested without DOM/React.
 */
export function layoutDag(input: LayoutInput, opts: LayoutOptions = {}): PositionedNode[] {
  const colWidth = opts.colWidth ?? 260;
  const rowHeight = opts.rowHeight ?? 120;

  // Collect every id we'll need to position.
  const ids = new Set<string>();
  for (const n of input.nodes) ids.add(n.id);
  for (const e of input.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }

  // Predecessor map for the depth walk.
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

  // Bucket by depth.
  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = depthOf(id);
    const bucket = byDepth.get(d) ?? [];
    bucket.push(id);
    byDepth.set(d, bucket);
  }

  const out: PositionedNode[] = [];
  for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    // Stable, id-sorted ordering within each layer.
    const sorted = [...bucket].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    sorted.forEach((id, i) => {
      out.push({
        id,
        position: {
          x: depth * colWidth,
          // Centre each column vertically around y=0 so short layers
          // don't pile up at the top.
          y: (i - (sorted.length - 1) / 2) * rowHeight,
        },
      });
    });
  }
  return out;
}
