"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Tooltip — Swarm design language.
 *
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Color               — only --sw-* tokens. Tooltip inverts surface/text
 *                           (sw-text bg, sw-bg fg) to read as a transient
 *                           overlay rather than a card; the hairline is
 *                           omitted because the inversion is the edge.
 *   § Typography          — monospace inherited; xs (11px) is the "dense
 *                           metadata" tier, which is exactly what tooltips
 *                           carry. tabular-nums comes from globals.
 *   § Spacing             — --sw-space-2 / --sw-space-1 (8/4px). The
 *                           previous 12/6/6px values were off-scale.
 *   § Borders & elevation — radius default (2px). No box-shadow; the
 *                           inversion provides separation.
 *   § Motion              — "Drawer / panel enter-exit → Slide + fade,
 *                           200ms ease-out". Tooltip is a paired hover
 *                           overlay; same easing/duration. Zoom removed:
 *                           it was decorative and losing it loses no
 *                           information. Slide-from-side stays — it
 *                           signals which side opened, which IS info.
 *
 * Behavioural API (Provider, Root, Trigger, Content + sideOffset, kbd
 * slot support) preserved.
 */

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
