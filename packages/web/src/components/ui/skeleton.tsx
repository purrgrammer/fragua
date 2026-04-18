// shadcn/ui — Skeleton.
//
// Minimal placeholder used while data loads (Home stats tiles, running
// strip). One-liner by design: any visual richness here would mean
// we're hand-crafting per-surface skeletons, which is a smell.
// Callers size it via className (`h-8 w-24`, etc.).
//
// Skill: .swarm/skills/design/SKILL.md
//   § Motion — "Processing / awaiting → Opacity pulse 1.0 → 0.55 → 1.0,
//     1800ms infinite, ease-in-out". The canonical `.sw-pulse` keyframe
//     defined in globals.css carries the cadence and the
//     `prefers-reduced-motion` fallback (static opacity 0.7). Tailwind's
//     `animate-pulse` is wrong duration (2000ms) and wrong easing.
//   § Color — surface token (one notch off bg, barely perceptible).
//     Skeletons are *absence of data*, not data; they belong on the
//     quietest surface tier, not the shadcn `--muted` foreground/bg pair.
//   § Borders & elevation — "Radius: 2px default". `rounded-md` (~6px)
//     is off-scale.

import type * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "sw-pulse rounded-[var(--sw-radius-default)] bg-[var(--sw-surface)]",
        className,
      )}
      {...props}
    />
  );
}
