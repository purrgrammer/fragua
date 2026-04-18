import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Button — Swarm design language.
 *
 * Skill citations (.agents/skills/design/SKILL.md):
 *   § Borders & elevation — "1px only", "Radius: 2px default"; no shadow.
 *   § Typography           — monospace voice, hierarchy via weight + case,
 *                            not size; size variants here only adjust the
 *                            hit-area footprint, never the type scale.
 *   § Spacing              — 4px base, fixed steps only (--sw-space-*).
 *   § Color                — accents = state only. `destructive` maps to
 *                            --sw-accent-error; `link` is text + underline,
 *                            no brand colour.
 *   § Motion               — only transform + opacity animate. Hover is a
 *                            120ms colour shift (ease); press is a 80ms
 *                            scale(0.97) (ease-out). Focus ring is instant
 *                            and 1px.
 *
 * Behavioural API (variants, sizes, asChild, data-slot) is preserved so
 * downstream consumers (button-group, sidebar, etc.) keep working.
 */

const buttonVariants = cva(
  [
    // structure
    "group/button inline-flex shrink-0 items-center justify-center",
    "border border-transparent bg-clip-padding select-none whitespace-nowrap",
    "rounded-[var(--sw-radius-default)]",

    // typography: monospace inherited from <html>; default body size,
    // hierarchy via weight only.
    "font-mono font-medium",
    "text-[length:var(--sw-text-sm)]",

    // motion: only background/border/color/transform animate; hover is
    // 120ms ease, press is 80ms ease-out scale(0.97).
    "transition-[background-color,border-color,color,transform]",
    "duration-[var(--sw-duration-hover)] ease-[ease]",
    "active:not-aria-[haspopup]:scale-[0.97] active:duration-[var(--sw-duration-press)] active:ease-out",

    // focus: instant, 1px ring.
    "outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring",

    // disabled / invalid
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-invalid:border-[var(--sw-accent-error)] aria-invalid:ring-1 aria-invalid:ring-[var(--sw-accent-error)]",

    // icons
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        // default — solid foreground/background; no brand colour, only
        // ink-on-paper inversion. Light + dark both designed via tokens.
        default: "bg-primary text-primary-foreground hover:bg-primary/80",

        // outline — surface + hairline. Same treatment in both themes;
        // theme tokens supply the values.
        outline:
          "border-[var(--sw-border)] bg-[var(--sw-surface)] text-[var(--sw-text)] hover:bg-[var(--sw-surface)]/60 aria-expanded:bg-[var(--sw-surface)]/60",

        // secondary — quieter than default, never brand-coloured.
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary",

        // ghost — chromeless until interaction.
        ghost: "text-[var(--sw-text)] hover:bg-[var(--sw-surface)] aria-expanded:bg-[var(--sw-surface)]",

        // destructive — accent.error state token.
        destructive: [
          "bg-transparent text-[var(--sw-accent-error)]",
          "hover:bg-[color-mix(in_oklch,var(--sw-accent-error)_12%,transparent)]",
          "focus-visible:ring-[var(--sw-accent-error)] focus-visible:border-[var(--sw-accent-error)]",
        ].join(" "),

        // link — text + underline, no colour shift. Inherits text colour.
        link: "text-[var(--sw-text)] underline-offset-4 hover:underline",
      },
      size: {
        // Footprint only — type scale is fixed by the base class above.
        // Heights snap to 4px grid; padding uses --sw-space-* tokens.
        default:
          "h-8 gap-1 px-[var(--sw-space-2)] has-data-[icon=inline-end]:pr-[var(--sw-space-2)] has-data-[icon=inline-start]:pl-[var(--sw-space-2)]",
        xs: "h-6 gap-1 px-[var(--sw-space-1)] text-[length:var(--sw-text-xs)] has-data-[icon=inline-end]:pr-[var(--sw-space-1)] has-data-[icon=inline-start]:pl-[var(--sw-space-1)] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-[var(--sw-space-2)] has-data-[icon=inline-end]:pr-[var(--sw-space-1)] has-data-[icon=inline-start]:pl-[var(--sw-space-1)] [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1 px-[var(--sw-space-3)] has-data-[icon=inline-end]:pr-[var(--sw-space-2)] has-data-[icon=inline-start]:pl-[var(--sw-space-2)]",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
