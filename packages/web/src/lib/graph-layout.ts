// Layered DAG layout used by `GraphView`. Kept tiny and dep-free: the
// workflows we render are small (< 20 nodes) so a naive longest-path
// layering beats pulling in Dagre/Elk for the bundle cost.
//
// Algorithm:
//   1. Start with the node set from `nodes` plus any node ids appearing
//      in `edges` that weren't in `nodes` (defensive — the workflow source
//      and the event stream can disagree for aborted runs).
//   2. DFS-classify edges into "tree/forward" vs "back" (target is an
//      ancestor in the DFS stack). Back-edges are structural cycle
//      returns and must be ignored by the depth computation — otherwise
//      the cycle target inherits depth from its post-cycle successor
//      and forward siblings end up at the same layer (the bug that
//      collapsed `draft` and `review` onto one row).
//   3. For each node, compute depth = 1 + max(depth(predecessors)) using
//      forward edges only (the DAG that remains after stripping back-
//      edges). Memoised on the acyclic subgraph — no cycles possible.
//   4. Bucket by depth to produce layers; order each layer by the edge
//      through which each node is first reached, so fan-out branches read
//      left-to-right in the author's declared order (`quick` before `full`)
//      rather than alphabetically. Edge order is fixed (parsed from source),
//      so this stays stable across renders — no jitter — while matching the
//      YAML. Ties (e.g. a node reached only via the same parent) break by id.
//   5. Project depth onto the primary axis and index-within-layer onto
//      the secondary axis. `orientation: "TB"` (default) puts the
//      longest path vertically so workflows read top-to-bottom —
//      matches how humans read a DAG and how a DAG is usually drawn.
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
   * swarm workflows read on paper; `"LR"` is kept for the few
   * places a horizontal strip is more useful. Left-to-right is the
   * legacy default — new views should stay on `"TB"`.
   */
  orientation?: LayoutOrientation;
}

/** Stable key for an edge's (from, to) pair. Shared between back-edge
 *  classification and edge routing in GraphView so the two agree on
 *  what counts as a cycle return. */
export const edgeKey = (from: string, to: string): string => `${from}->${to}`;

export interface ClassifiedGraph {
  ids: Set<string>;
  /** Back-edges keyed by `edgeKey(from, to)`. A back-edge's target is
   *  an ancestor in the DFS tree — the structural cycle return. */
  backEdgeKeys: Set<string>;
  /** Longest-path depth on the DAG remaining after back-edges are
   *  stripped. Used both to lay out nodes and to spot skip-edges
   *  (forward edges whose target depth jumps past intermediate layers). */
  depthOf: Map<string, number>;
}

/**
 * DFS-classify a graph into back-edges + forward-edge depths.
 *
 * Why this is shared: if GraphView classified back-edges on a different
 * walk from layoutDag, the two could disagree — and the user would see
 * a forward-looking edge that the layout treated as a cycle return
 * (layer collapse) while the edge renderer still drew it straight.
 */
export function classifyGraph(input: LayoutInput): ClassifiedGraph {
  const ids = new Set<string>();
  for (const n of input.nodes) ids.add(n.id);
  for (const e of input.edges) {
    ids.add(e.from);
    ids.add(e.to);
  }

  // Insertion-order iteration makes classification deterministic —
  // workflow source order reflects the author's intended flow direction.
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of input.edges) {
    if (ids.has(e.from) && ids.has(e.to)) adj.get(e.from)?.push(e.to);
  }
  const backEdgeKeys = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray (on stack), 2=black
  for (const id of ids) color.set(id, 0);
  const dfs = (u: string): void => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v);
      if (c === 1) backEdgeKeys.add(edgeKey(u, v));
      else if (c === 0) dfs(v);
    }
    color.set(u, 2);
  };
  for (const id of ids) if (color.get(id) === 0) dfs(id);

  // Longest-path depth on the back-edge-stripped DAG. Acyclic by
  // construction, so a plain memoised walk is enough.
  const predecessors = new Map<string, string[]>();
  for (const id of ids) predecessors.set(id, []);
  for (const e of input.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    if (backEdgeKeys.has(edgeKey(e.from, e.to))) continue;
    predecessors.get(e.to)?.push(e.from);
  }
  const cache = new Map<string, number>();
  const walk = (id: string): number => {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    let d = 0;
    for (const p of predecessors.get(id) ?? []) d = Math.max(d, walk(p) + 1);
    cache.set(id, d);
    return d;
  };
  const depthOf = new Map<string, number>();
  for (const id of ids) depthOf.set(id, walk(id));

  return { ids, backEdgeKeys, depthOf };
}

export function layoutDag(input: LayoutInput, opts: LayoutOptions = {}): PositionedNode[] {
  const orientation: LayoutOrientation = opts.orientation ?? "TB";
  // Defaults tuned for TB: layer spacing (vertical) tighter than cross
  // spacing (horizontal) so siblings fan out without burying the flow.
  // 180 keeps single-edge labels (e.g. `route=…` route names) inside the
  // gap between cards — at 140 a 5-row llm card and the next node
  // left only ~20px for the label pill, so labels grazed the next card's
  // header. LR defaults keep the older values so existing callers don't shift.
  const layerSize = opts.layerSize ?? (orientation === "TB" ? 180 : 260);
  const crossSize = opts.crossSize ?? (orientation === "TB" ? 280 : 120);

  const { ids, depthOf } = classifyGraph(input);

  const byDepth = new Map<number, string[]>();
  for (const id of ids) {
    const d = depthOf.get(id) ?? 0;
    const bucket = byDepth.get(d) ?? [];
    bucket.push(id);
    byDepth.set(d, bucket);
  }

  // Within-layer order follows the edge through which each node is first
  // reached (declaration order), so sibling branches read left-to-right the
  // way the source lists them. Deterministic: input.edges is fixed.
  const firstEdgeIndex = new Map<string, number>();
  input.edges.forEach((e, i) => {
    if (!firstEdgeIndex.has(e.to)) firstEdgeIndex.set(e.to, i);
  });
  const orderKey = (id: string): number => firstEdgeIndex.get(id) ?? -1;

  const out: PositionedNode[] = [];
  for (const [depth, bucket] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...bucket].sort((a, b) => orderKey(a) - orderKey(b) || (a < b ? -1 : a > b ? 1 : 0));
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
