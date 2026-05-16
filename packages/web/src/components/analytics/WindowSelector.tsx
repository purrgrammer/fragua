// Time-window dropdown for /analytics. Single Select for every
// viewport — keeps the chrome quiet in the page header and avoids the
// segmented bar growing wider than the title slot at narrow widths.
//
// Options are filtered by `firstRunMs`: "Today" and "All time" always
// render; lastN options (last7, last30, last90) appear only when the
// available data span (Date.now() - firstRunMs) is >= N days. When
// `firstRunMs` is null/undefined (no data), only today + all render.

import { WINDOWS, type WindowDefinition, type WindowKey } from "@/lib/analytics";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";

const DAY_MS = 86_400_000;

const LASTN_DAYS: Partial<Record<WindowKey, number>> = {
  last7: 7,
  last30: 30,
  last90: 90,
};

/** Pure helper: returns the subset of WINDOWS that should be rendered
 *  given the earliest known run timestamp and the current time.
 *  Always includes "today" and "all"; includes lastN only when the
 *  data span (nowMs - firstRunMs) >= N * DAY_MS. */
export function filterWindowOptions(firstRunMs: number | null | undefined, nowMs: number): readonly WindowDefinition[] {
  return WINDOWS.filter((w) => {
    if (w.key === "today" || w.key === "all") return true;
    if (firstRunMs == null) return false;
    const days = LASTN_DAYS[w.key];
    if (days === undefined) return true;
    return days * DAY_MS <= nowMs - firstRunMs;
  });
}

export interface WindowSelectorProps {
  value: WindowKey;
  onChange: (next: WindowKey) => void;
  /** Earliest run enqueue time (unix ms) in the current analytics
   *  window. `null`/`undefined` = no data — render only today + all. */
  firstRunMs?: number | null;
}

export function WindowSelector({ value, onChange, firstRunMs }: WindowSelectorProps): JSX.Element {
  const options = filterWindowOptions(firstRunMs, Date.now());
  return (
    <Select value={value} onValueChange={(v) => onChange(v as WindowKey)}>
      <SelectTrigger className="w-[10rem]" aria-label="Time window" data-testid="window-selector">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((w) => (
          <SelectItem key={w.key} value={w.key} data-testid={`window-${w.key}`}>
            {w.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
