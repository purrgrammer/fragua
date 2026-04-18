"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function TooltipProvider({ delayDuration = 0, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          [
            // structure
            "z-50 inline-flex w-fit max-w-xs items-center",
            "gap-[var(--sw-space-1)]",
            "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
            "rounded-[var(--sw-radius-default)]",

            // surface: inverted overlay (no border, no shadow)
            "bg-[var(--sw-text)] text-[var(--sw-bg)]",

            // typography: dense metadata tier
            "text-[length:var(--sw-text-xs)] leading-none",

            // kbd slot: align trailing pad to scale, keep stacking context
            "has-data-[slot=kbd]:pr-[var(--sw-space-1)]",
            "**:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate",
            "**:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-[var(--sw-radius-default)]",

            // motion: paired enter/exit — slide-from-side (informational)
            // + fade. Only transform + opacity. Zoom removed (decorative).
            "origin-(--radix-tooltip-content-transform-origin)",
            "duration-[var(--sw-duration-enter)] ease-out",
            "data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
            "data-[side=bottom]:slide-in-from-top-1",
            "data-[side=left]:slide-in-from-right-1",
            "data-[side=right]:slide-in-from-left-1",
            "data-[side=top]:slide-in-from-bottom-1",
          ].join(" "),
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={cn(
            // Geometric square rotated 45° to make the arrow. Size kept
            // small (10px) to match xs-tier visual weight; color tracks
            // the inverted surface so the seam is invisible.
            "z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45",
            "rounded-[var(--sw-radius-default)]",
            "bg-[var(--sw-text)] fill-[var(--sw-text)]",
          )}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
