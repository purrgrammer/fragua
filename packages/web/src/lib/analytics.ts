// /analytics page — window definitions, bucket math, and the
// comparison-window helpers the route consumes.
//
// Time-zone discipline: every boundary computed here uses the browser's
// LOCAL midnight (via JS `Date` mutators) so "Today" matches what the
// user would call today. The server is dumb — it takes `from`, `to`,
// `bucket`, and `tzOffsetMinutes` and bucket-aligns server-side using
// the same TZ offset.
//
// Comparison windows (totals.previous on the wire):
//   Today      → the same elapsed-fraction of yesterday (00:00 yesterday
//                → 00:00 yesterday + (now - 00:00 today)). Without this
//                partial-window correction, partial-today always reads
//                as a negative delta.
//   Last 7 d   → previous 7 days
//   Last 30 d  → previous 30 days
//   Last 90 d  → previous 90 days
//   All time   → no comparison; tiles render absolute only

import type { BucketKind } from "../types/analytics.ts";

export type WindowKey = "today" | "last7" | "last30" | "last90" | "all";

export interface WindowDefinition {
  key: WindowKey;
  /** Short label shown in the selector and as the comparison-line caption. */
  label: string;
  /** Caption used after "vs" on the delta line. `null` when no comparison. */
  comparisonCaption: string | null;
  bucket: BucketKind;
}

export const WINDOWS: readonly WindowDefinition[] = [
  { key: "today", label: "Today", comparisonCaption: "yesterday", bucket: "hour" },
  { key: "last7", label: "Last 7 days", comparisonCaption: "previous 7 days", bucket: "day" },
  { key: "last30", label: "Last 30 days", comparisonCaption: "previous 30 days", bucket: "day" },
  { key: "last90", label: "Last 90 days", comparisonCaption: "previous 90 days", bucket: "day" },
  { key: "all", label: "All time", comparisonCaption: null, bucket: "month" },
];

export interface ResolvedWindow {
  key: WindowKey;
  label: string;
  bucket: BucketKind;
  fromMs: number;
  toMs: number;
  /** When non-null, server returns totals.previous over this range. */
  compareFromMs: number | null;
  compareToMs: number | null;
  /** Browser TZ offset in `Date.getTimezoneOffset()` shape. */
  tzOffsetMinutes: number;
}

/** Resolve a window key into concrete unix-ms boundaries anchored to
 *  the user's local time at `now`. `now` is injectable for tests. */
export function resolveWindow(key: WindowKey, now: Date = new Date()): ResolvedWindow {
  const def = WINDOWS.find((w) => w.key === key) ?? WINDOWS[0]!;
  const tzOffsetMinutes = now.getTimezoneOffset();
  const nowMs = now.getTime();

  switch (def.key) {
    case "today": {
      const todayStart = startOfLocalDay(now);
      const yesterdayStart = todayStart - DAY_MS;
      const elapsed = nowMs - todayStart;
      return {
        key: def.key,
        label: def.label,
        bucket: def.bucket,
        fromMs: todayStart,
        toMs: nowMs,
        compareFromMs: yesterdayStart,
        compareToMs: yesterdayStart + elapsed,
        tzOffsetMinutes,
      };
    }
    case "last7":
    case "last30":
    case "last90": {
      const days = def.key === "last7" ? 7 : def.key === "last30" ? 30 : 90;
      const span = days * DAY_MS;
      return {
        key: def.key,
        label: def.label,
        bucket: def.bucket,
        fromMs: nowMs - span,
        toMs: nowMs,
        compareFromMs: nowMs - 2 * span,
        compareToMs: nowMs - span,
        tzOffsetMinutes,
      };
    }
    default: {
      return {
        key: def.key,
        label: def.label,
        bucket: def.bucket,
        fromMs: 0,
        toMs: nowMs,
        compareFromMs: null,
        compareToMs: null,
        tzOffsetMinutes,
      };
    }
  }
}

const DAY_MS = 86_400_000;

/** Local midnight at the start of the calendar day containing `d`. */
function startOfLocalDay(d: Date): number {
  const copy = new Date(d.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy.getTime();
}

// Bucket gap-filling lives on the server now: see `bucketsInRange` +
// `zeroFill` in analytics-routes.ts. Doing it server-side guarantees
// the bucket values match what SQL emits — the previous client-side
// approach used DST-aware Date math while SQL used fixed-offset math,
// so windows crossing a DST boundary returned rows the client couldn't
// merge and every bucket fell through to "no data".
