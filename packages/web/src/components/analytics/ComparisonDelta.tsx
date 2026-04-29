// Inline comparison delta — sits next to the KPI's main number.
//
// Renders only the directional arrow + tone-coloured percentage. The
// "vs <caption>" wording is intentionally absent: the window selector
// already names the comparison context, so repeating it on every tile
// just clutters the strip. When there's nothing meaningful to show
// (no comparison window, no prior data, or zero movement) the
// component returns null so the row collapses cleanly.
//
// Arrow vs colour: the arrow follows the SIGN of the change (up if the
// metric grew, down if it shrank). The colour follows the TONE — good or
// bad — which depends on the metric's `direction`. So a spend tile that
// dropped renders DownArrow + green; one that grew renders UpArrow + red.
// Binding the arrow to tone instead made inverse-direction tiles
// (spend, tokens) point opposite of reality.

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { percentFormatOptions } from "@/lib/format";
import { computeDelta, type DeltaDirection } from "@/lib/humanize";
import { AnimatedNumber } from "../ui/animated-number.tsx";

export interface ComparisonDeltaProps {
  /** `null` while the first payload is loading — collapses the badge. */
  current: number | null | undefined;
  previous: number | null | undefined;
  direction?: DeltaDirection;
}

export function ComparisonDelta({ current, previous, direction = "normal" }: ComparisonDeltaProps): JSX.Element | null {
  if (current == null || previous == null) return null;
  const delta = computeDelta(current, previous, direction);
  if (delta.ratio == null || delta.ratio === 0) return null;

  const Icon = delta.ratio > 0 ? ArrowUpRight : ArrowDownRight;
  const colorClass = delta.tone === "positive" ? "text-sw-accent-success" : "text-sw-accent-error";

  return (
    <span className={`inline-flex items-center gap-0.5 text-sw-sm tabular-nums ${colorClass}`} data-tone={delta.tone}>
      <Icon className="size-3.5" aria-hidden />
      <AnimatedNumber value={Math.abs(delta.ratio)} format={percentFormatOptions()} />
    </span>
  );
}
