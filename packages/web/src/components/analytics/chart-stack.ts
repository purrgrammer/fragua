// Per-bucket radius for stacked bar charts. Recharts' static `radius`
// prop on a Bar applies to every bucket — fine when the bottom and top
// layers always carry data, awkward when they don't (a bucket showing
// only one mid-stack status renders a flat-cornered bar that should
// have been a single rounded pill).
//
// `visibleSegmentRadius` walks the row's stack keys in their declared
// order, finds the first and last non-zero entries, and returns a
// recharts `[topLeft, topRight, bottomRight, bottomLeft]` tuple with
// rounding only on the visible extremes — so a one-segment bar
// rounds all four corners, a partial stack rounds only its real top
// and bottom, and an empty bucket renders nothing.
//
// Promotion: when the topmost visible segment is too thin to carry a
// rounded corner without clipping (segment-share < PROMOTION_THRESHOLD
// of the bar's total), we walk down to the next non-thin segment and
// round its top instead. The thin segment renders flat. This avoids
// the "tiny Output sliver clipped weird" failure mode where a $0.50
// Output stripe on a $130 bar renders as a 1-px-tall rectangle with
// 4-px corner radii.
//
// `clampRadius` is the pixel-side safety net: if the chosen rounded
// segment is itself short in absolute pixels (e.g. a low-volume bucket
// next to a tall bucket), we cap each corner at half the segment's
// rendered height so the corner radii never overlap each other.

export type Radius = [number, number, number, number];

export const STACK_RADIUS_PX = 4;

// 5% of the bar — under this share, a segment renders flat-topped and
// we promote the rounded corner down to the next-larger segment. Tuned
// against the Spend chart's worst case (Output ≈ 0.4% of a cache-heavy
// day) where 4-px rounding on a sub-pixel segment was clipping ugly.
export const PROMOTION_THRESHOLD = 0.05;

export function visibleSegmentRadius<K extends string>(
  payload: Readonly<Record<K, number>>,
  keys: readonly K[],
  dataKey: K,
): Radius {
  const visible = keys.filter((k) => (payload[k] ?? 0) > 0);
  if (visible.length === 0) return [0, 0, 0, 0];

  const total = visible.reduce((s, k) => s + (payload[k] ?? 0), 0);
  // Walk down from the topmost visible segment until we find one large
  // enough to carry a rounded corner. If every visible segment is thin
  // (rare — the whole bar is small), fall back to the topmost so we
  // don't render a fully flat bar; clampRadius handles the pixel side.
  let topIdx = visible.length - 1;
  while (topIdx > 0) {
    const k = visible[topIdx]!;
    const share = total > 0 ? (payload[k] ?? 0) / total : 0;
    if (share >= PROMOTION_THRESHOLD) break;
    topIdx--;
  }
  const roundedTop = visible[topIdx]!;
  const isBottom = visible[0] === dataKey;
  const isTop = roundedTop === dataKey;
  const r = STACK_RADIUS_PX;
  if (isBottom && isTop) return [r, r, r, r];
  if (isBottom) return [0, 0, r, r];
  if (isTop) return [r, r, 0, 0];
  return [0, 0, 0, 0];
}

// Cap each corner at half the segment's rendered height so the corner
// arcs never overlap. Recharts doesn't clamp internally — passing
// radius=4 for a 2-px-tall rect produces a malformed path.
export function clampRadius(r: Radius, height: number): Radius {
  const cap = Math.max(0, height / 2);
  return [Math.min(r[0], cap), Math.min(r[1], cap), Math.min(r[2], cap), Math.min(r[3], cap)];
}
