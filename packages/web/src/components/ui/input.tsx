import type * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // structure
        "flex h-8 w-full min-w-0",
        "rounded-[var(--sw-radius-default)]",
        "border border-[var(--sw-border)] bg-transparent",
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",

        // typography: monospace inherited from <html>; default body size,
        // no responsive size-jump.
        "text-[length:var(--sw-text-sm)]",

        // file input affordance — same scale as body, medium weight only.
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent",
        "file:text-[length:var(--sw-text-sm)] file:font-medium",
        "file:text-[var(--sw-text)]",

        // placeholder uses the muted token.
        "placeholder:text-[var(--sw-muted)]",

        // motion: 120ms ease, only colour-class properties animate.
        "transition-[background-color,border-color,color]",
        "duration-[var(--sw-duration-hover)] ease-[ease]",

        // focus: instant, 1px ring (matches Button).
        "outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",

        // disabled
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "disabled:bg-[var(--sw-surface)]",

        // invalid — accent.error state token, 1px only.
        "aria-invalid:border-[var(--sw-accent-error)]",
        "aria-invalid:ring-1 aria-invalid:ring-[var(--sw-accent-error)]",

        className,
      )}
      {...props}
    />
  );
}

export { Input };
