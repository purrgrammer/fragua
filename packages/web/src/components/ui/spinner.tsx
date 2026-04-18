/*
 * Spinner — "thinking" indicator primitive.
 *
 * Uses the canonical opacity pulse (1.0 → 0.55 → 1.0, 1800ms infinite,
 * ease-in-out) for processing / awaiting state. The previous
 * implementation used `animate-spin` (continuous rotate, linear easing),
 * which violates two rules: (1) animations should touch only `transform`
 * and `opacity` *in service of state*, not as decorative motion, and
 * (2) linear easing on color/hover is wrong — pulse easing is
 * `ease-in-out`. The canonical pulse also has a `prefers-reduced-motion`
 * fallback (static dimmed state) provided by the `sw-pulse` utility in
 * globals.css.
 */
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return <Loader2Icon role="status" aria-label="Loading" className={cn("size-4 sw-pulse", className)} {...props} />;
}

export { Spinner };
