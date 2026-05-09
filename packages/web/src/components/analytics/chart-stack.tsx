// Stacked bar rounding via clip-path. Each segment renders as a flat
// rectangle clipped by the bar's overall rounded outer shape, so thin
// slivers naturally taper into the corner curves instead of fighting
// them. No per-segment radius math, no thin-segment thresholds — the
// silhouette is always a clean pill, regardless of how the stack
// distributes (single segment, thin top, thin bottom, mixed).
//
// `barOuterBounds` reconstructs the bar's full rect from any one
// segment's geometry (x, y, width, height) plus the payload + stack
// order. The current segment's `(height / value)` gives px-per-value;
// values above and below scale to pixel offsets above and below the
// segment's box. Stack order matches the source declaration order:
// `keys[0]` renders at the bottom, `keys[length - 1]` at the top.

import type { ComponentProps, ReactElement } from "react";
import { Rectangle } from "recharts";

export const STACK_RADIUS_PX = 4;

export interface BarBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function barOuterBounds<K extends string>(
  payload: Readonly<Record<K, number>>,
  keys: readonly K[],
  dataKey: K,
  segmentX: number | undefined,
  segmentY: number | undefined,
  segmentWidth: number | undefined,
  segmentHeight: number | undefined,
): BarBounds | null {
  if (
    segmentX === undefined ||
    segmentY === undefined ||
    segmentWidth === undefined ||
    segmentHeight === undefined ||
    segmentHeight <= 0 ||
    segmentWidth <= 0
  ) {
    return null;
  }
  const v = payload[dataKey] ?? 0;
  if (v <= 0) return null;
  const idx = keys.indexOf(dataKey);
  if (idx < 0) return null;
  const pxPerValue = segmentHeight / v;
  const sane = (n: number | undefined): number => (Number.isFinite(n) && (n as number) > 0 ? (n as number) : 0);
  const valuesAbove = keys.slice(idx + 1).reduce((s, k) => s + sane(payload[k]), 0);
  const valuesBelow = keys.slice(0, idx).reduce((s, k) => s + sane(payload[k]), 0);
  return {
    x: segmentX,
    y: segmentY - valuesAbove * pxPerValue,
    width: segmentWidth,
    height: segmentHeight + (valuesAbove + valuesBelow) * pxPerValue,
  };
}

export function renderStackSegment<K extends string>(
  barProps: unknown,
  keys: readonly K[],
  dataKey: K,
): ReactElement {
  const p = barProps as {
    payload: Readonly<Record<K, number>>;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  const bounds = barOuterBounds(p.payload, keys, dataKey, p.x, p.y, p.width, p.height);
  if (!bounds) {
    return <Rectangle {...(barProps as ComponentProps<typeof Rectangle>)} />;
  }
  const r = STACK_RADIUS_PX;
  // Bounds + dataKey disambiguate clipPaths in the same SVG document:
  // segments in one bar share x/y/w/h but differ on dataKey; bars in
  // different columns differ on x; charts on the same page differ on
  // y/height because their y-scales differ.
  const clipId = `sw-stack-${Math.round(bounds.x)}-${Math.round(bounds.y)}-${Math.round(bounds.height)}-${String(dataKey)}`;
  return (
    <g>
      <defs>
        <clipPath id={clipId}>
          <rect x={bounds.x} y={bounds.y} width={bounds.width} height={bounds.height} rx={r} ry={r} />
        </clipPath>
      </defs>
      <Rectangle {...(barProps as ComponentProps<typeof Rectangle>)} clipPath={`url(#${clipId})`} />
    </g>
  );
}
