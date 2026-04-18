"use client";

import { Controls as ControlsPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ControlsProps = ComponentProps<typeof ControlsPrimitive>;

// SKILL.md § Color — floating control panels sit on `card`/`surface`,
// separated from the canvas by a hairline rather than a shade shift.
// SKILL.md § Borders & elevation — "Elevation: none. No box-shadow."
// (`shadow-none!` neutralizes the @xyflow/react default).
// SKILL.md § Spacing — 4px (`p-1`) container padding; gap-px keeps the
// button cluster reading as a single divided control, not separate chips.
// SKILL.md § Motion — "Hover, color shift … 120ms ease". Buttons get
// an explicit transition so hover state animates rather than snapping.
export const Controls = ({ className, ...props }: ControlsProps) => (
  <ControlsPrimitive
    className={cn(
      "gap-px overflow-hidden rounded-md border bg-card p-1 shadow-none!",
      "[&>button]:rounded-md [&>button]:border-none! [&>button]:bg-transparent!",
      "[&>button]:transition-colors [&>button]:duration-[120ms] [&>button]:ease-[ease]",
      "[&>button]:hover:bg-secondary!",
      className,
    )}
    {...props}
  />
);
