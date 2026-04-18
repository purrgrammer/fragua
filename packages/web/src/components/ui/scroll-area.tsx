"use client";

import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * ScrollArea — Swarm design pass.
 *
 * Skill citations:
 *  - Motion §"Only animate `transform` and `opacity`": dropped
 *    `transition-[color,box-shadow]` on the viewport and `transition-colors`
 *    on the scrollbar track. Scrollbar chrome is passive, not state — no
 *    transition belongs on it.
 *  - Motion §Focus ring "Instant — 0ms": focus-visible uses a 1px hairline
 *    ring with no transition.
 *  - Borders §"1px only": replaced `ring-[3px]` with `ring-1`.
 *  - Borders §"Pills only where the pill *is* the status shape": thumb
 *    radius drops from `rounded-full` to `rounded-[2px]` (default token).
 *  - Spacing §"4px base. These steps only — no arbitrary px": removed
 *    `p-px` track padding; snapped scrollbar thickness from 2.5 (10px,
 *    off-scale) to `2` (8px).
 *  - Color §`border` "Hairline, visible but quiet": thumb retains
 *    `bg-border` — the calmest visible token, no accent (scrollbar is not
 *    state).
 */
function ScrollArea({ className, children, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn("relative", className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none data-horizontal:h-2 data-horizontal:flex-col data-vertical:h-full data-vertical:w-2",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-[2px] bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
