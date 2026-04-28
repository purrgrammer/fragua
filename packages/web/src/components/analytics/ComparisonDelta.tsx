// Inline comparison delta — sits next to the KPI's main number.
//
// Renders only the directional arrow + tone-coloured percentage. The
// "vs <caption>" wording is intentionally absent: the window selector
// already names the comparison context, so repeating it on every tile
// just clutters the strip. When there's nothing meaningful to show
// (no comparison window, no prior data, or zero movement) the
// component returns null so the row collapses cleanly.

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { percentFormatOptions } from "@/lib/format";
import { computeDelta, type DeltaDirection } from "@/lib/humanize";
import { AnimatedNumber } from "../ui/animated-number.tsx";

export interface ComparisonDeltaProps {
  current: number;
  previous: number | null | undefined;
  direction?: DeltaDirection;
}

export function ComparisonDelta({ current, previous, direction = "normal" }: ComparisonDeltaProps): JSX.Element | null {
  if (previous == null) return null;
  const delta = computeDelta(current, previous, direction);
  if (delta.ratio == null || delta.ratio === 0) return null;

  const Icon = delta.tone === "negative" ? ArrowDownRight : ArrowUpRight;
  const colorClass = delta.tone === "positive" ? "text-sw-accent-success" : "text-sw-accent-error";

  return (
    <span className={`inline-flex items-center gap-0.5 text-sw-xs tabular-nums ${colorClass}`} data-tone={delta.tone}>
      <Icon className="size-3" aria-hidden />
      <AnimatedNumber value={Math.abs(delta.ratio)} format={percentFormatOptions()} />
    </span>
  );
}
