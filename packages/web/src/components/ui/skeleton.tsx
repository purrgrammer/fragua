// shadcn/ui — Skeleton.
//
// Minimal pulsing placeholder used while data loads (Home stats tiles,
// running strip). One-liner by design: any visual richness here would
// mean we're hand-crafting per-surface skeletons, which is a smell.
// Callers size it via className (`h-8 w-24`, etc.).

import type * as React from "react";
import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
