// Headline value rendered in a ChartCard's right-aligned header slot.
// Mirrors the StatTile numeric voice (font-heading, 2xl, tabular-nums)
// and groups the ComparisonDelta + AnimatedNumber inside a single
// NumberFlowGroup so digit transitions tick in lockstep.
//
// Tone is metric-agnostic: upward movement is always green, downward
// always red. Spend/tokens going up isn't visually framed as "bad" —
// the chart already carries that semantic via the metric label.

import { NumberFlowGroup } from "@number-flow/react";
import { AnimatedNumber } from "../ui/animated-number.tsx";
import { ComparisonDelta } from "./ComparisonDelta.tsx";

export interface ChartTotalProps {
  current: number | undefined;
  previous: number | null;
  format: Intl.NumberFormatOptions;
}

export function ChartTotal({ current, previous, format }: ChartTotalProps): JSX.Element {
  return (
    <NumberFlowGroup>
      <span className="inline-flex items-baseline gap-2">
        <ComparisonDelta current={current} previous={previous} />
        <AnimatedNumber value={current} format={format} className="font-heading text-2xl leading-none tabular-nums" />
      </span>
    </NumberFlowGroup>
  );
}
