// Standard shadcn/ui classname helper: `clsx` handles conditional class
// composition, `tailwind-merge` dedupes Tailwind utility collisions so the
// *last* class of a given property family wins (e.g. `px-2 px-4` → `px-4`).
//
// Every shadcn primitive in `src/components/ui/*` calls `cn(...)` to merge
// a base variant class with user-supplied overrides. Keeping the helper in
// its own file lets those primitives import from a stable path.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
