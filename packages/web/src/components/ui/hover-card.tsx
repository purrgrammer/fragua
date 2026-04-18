"use client";

import { HoverCard as HoverCardPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * HoverCard — Swarm design language.
 *
 * Skill citations (.agents/skills/design/SKILL.md):
 *   § Color               — only --sw-* tokens. Unlike Tooltip (which
 *                           inverts to read as a transient label), the
 *                           hover-card is a richer disclosure surface,
 *                           so it stays on --sw-surface with a hairline
 *                           — matching the "drawers separate via …
 *                           hairline" rule.
 *   § Typography          — monospace inherited; sm (12px) is the
 *                           default body tier, appropriate for a
 *                           multi-line preview popover. tabular-nums
 *                           comes from globals.
 *   § Spacing             — --sw-space-3 (12px) card padding-y. The
 *                           previous p-2.5 (10px) was off-scale.
 *   § Borders & elevation — radius-card (4px) per "4px cards/drawers".
 *                           1px hairline on --sw-border. shadow-md and
 *                           the ring-1 ring-foreground/10 (a faux
 *                           border) deleted: "Elevation: none. No
 *                           box-shadow … 1px only, border token."
 *   § Motion              — "Drawer / panel enter-exit → Slide + fade,
 *                           200ms ease-out". Zoom removed: decorative
 *                           and losing it loses no information (mirrors
 *                           the precedent set in tooltip.tsx). Slide-
 *                           from-side stays — it signals which side
 *                           opened, which IS information.
 *
 * Behavioural API (Root, Trigger, Content + align/sideOffset)
 * preserved.
 */

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

function HoverCardContent({
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          [
            // structure
            "z-50 w-64 outline-hidden",
            "p-[var(--sw-space-3)]",
            "rounded-[var(--sw-radius-card)]",

            // surface: same value as page, separated by hairline
            "bg-[var(--sw-surface)] text-[var(--sw-text)]",
            "border border-[var(--sw-border)]",

            // typography: default body tier
            "text-[length:var(--sw-text-sm)]",

            // motion: paired enter/exit — slide-from-side (informational)
            // + fade. Only transform + opacity. Zoom removed (decorative).
            "origin-(--radix-hover-card-content-transform-origin)",
            "duration-[var(--sw-duration-enter)] ease-out",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
            "data-[side=bottom]:slide-in-from-top-2",
            "data-[side=left]:slide-in-from-right-2",
            "data-[side=right]:slide-in-from-left-2",
            "data-[side=top]:slide-in-from-bottom-2",
          ].join(" "),
          className,
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
