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

export type Radius = [number, number, number, number];

export const STACK_RADIUS_PX = 4;

export function visibleSegmentRadius<K extends string>(
  payload: Readonly<Record<K, number>>,
  keys: readonly K[],
  dataKey: K,
): Radius {
  const visible = keys.filter((k) => (payload[k] ?? 0) > 0);
  if (visible.length === 0) return [0, 0, 0, 0];
  const isBottom = visible[0] === dataKey;
  const isTop = visible[visible.length - 1] === dataKey;
  const r = STACK_RADIUS_PX;
  if (isBottom && isTop) return [r, r, r, r];
  if (isBottom) return [0, 0, r, r];
  if (isTop) return [r, r, 0, 0];
  return [0, 0, 0, 0];
}
