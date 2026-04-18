// shadcn/ui — Skeleton.
//
// Minimal placeholder used while data loads (Home stats tiles, running
// strip). One-liner by design: any visual richness here would mean
// we're hand-crafting per-surface skeletons, which is a smell.
// Callers size it via className (`h-8 w-24`, etc.).
//
// Uses the canonical `.sw-pulse` keyframe (opacity 1.0 → 0.55 → 1.0,
// 1800ms infinite, ease-in-out) defined in globals.css, which carries
// the cadence and the `prefers-reduced-motion` fallback (static opacity
// 0.7). Tailwind's `animate-pulse` is wrong duration (2000ms) and wrong
// easing. Sits on the surface token (one notch off bg) — skeletons are
// *absence of data*, not data, so they belong on the quietest surface
// tier. Uses the default 2px radius token.

import type * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="skeleton"
      className={cn("sw-pulse rounded-[var(--sw-radius-default)] bg-[var(--sw-surface)]", className)}
      {...props}
    />
  );
}
