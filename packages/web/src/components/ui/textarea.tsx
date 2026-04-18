import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Textarea — Swarm design language.
 *
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Borders & elevation — "1px only", "Radius: 2px default"; no shadow;
 *                           focus ring is instant and 1px (matches Input).
 *   § Typography           — monospace voice (inherited), default body
 *                            12px (--sw-text-sm). No size-jump hierarchy
 *                            between mobile/desktop.
 *   § Spacing              — input padding-x = --sw-space-2 (8px),
 *                            padding-y = --sw-space-1 (4px). All values
 *                            land on the 4px grid.
 *   § Color                — accents = state. aria-invalid maps to
 *                            --sw-accent-error; border/text use --sw-*
 *                            tokens. Dark theme is the peer; tokens carry
 *                            the values, no auto-inverted dark overrides.
 *   § Motion               — hover/focus colour shift is 120ms ease;
 *                            only background/border/color animate.
 *
 * Behavioural API is preserved — every prop spreads through unchanged.
 */
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
