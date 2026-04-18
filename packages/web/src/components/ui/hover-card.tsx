"use client";

import { HoverCard as HoverCardPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

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
