import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // structure — field-sizing keeps the auto-grow behaviour.
        "flex field-sizing-content min-h-16 w-full",
        "rounded-[var(--sw-radius-default)]",
        "border border-[var(--sw-border)] bg-transparent",
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",

        // typography: monospace inherited from <html>; default body size,
        // no responsive size-jump.
        "text-[length:var(--sw-text-sm)]",

        // placeholder uses the muted token.
        "placeholder:text-[var(--sw-muted)]",

        // motion: 120ms ease, only colour-class properties animate.
        "transition-[background-color,border-color,color]",
        "duration-[var(--sw-duration-hover)] ease-[ease]",

        // focus: instant, 1px ring (matches Input).
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

export { Textarea };
