import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn.ts";

const badgeVariants = cva(
  [
    // structure
    "inline-flex items-center whitespace-nowrap select-none",
    "border rounded-[var(--sw-radius-default)]",
    "px-[var(--sw-space-2)] py-[var(--sw-space-05)]",

    // typography: monospace voice, dense label size, UPPERCASE handled by
    // callers when used as a status label (skill leaves casing to context).
    "font-mono font-medium",
    "text-[length:var(--sw-text-xs)] leading-none",

    // motion: hover colour shift only; 120ms ease.
    "transition-[background-color,border-color,color]",
    "duration-[var(--sw-duration-hover)] ease-[ease]",

    // focus: instant, 1px ring.
    "outline-none focus-visible:ring-1 focus-visible:ring-ring",
  ].join(" "),
  {
    variants: {
      variant: {
        // default — neutral outlined chip; not a brand colour.
        default: "border-[var(--sw-border)] bg-[var(--sw-surface)] text-[var(--sw-text)]",

        // secondary — flatter, no border emphasis. Same visual weight as
        // default, used when sitting next to one for grouping.
        secondary: "border-transparent bg-[var(--sw-surface)] text-[var(--sw-muted)]",

        // outline — chromeless until interaction; for inline tags in copy.
        outline: "border-[var(--sw-border)] bg-transparent text-[var(--sw-text)]",

        // muted — quietest variant; metadata (paths, ids).
        muted: "border-transparent bg-[var(--sw-surface)] text-[var(--sw-muted)]",

        // ── state variants (skill: "Accents communicate state.") ─────────
        // Background is a low-chroma tint of the accent so the dot/label
        // colour stays the carrier of meaning. color-mix keeps both themes
        // in sync without auto-inversion.
        success: [
          "border-[color-mix(in_oklch,var(--sw-accent-success)_30%,transparent)]",
          "bg-[color-mix(in_oklch,var(--sw-accent-success)_12%,transparent)]",
          "text-[var(--sw-accent-success)]",
        ].join(" "),

        warning: [
          "border-[color-mix(in_oklch,var(--sw-accent-warn)_30%,transparent)]",
          "bg-[color-mix(in_oklch,var(--sw-accent-warn)_12%,transparent)]",
          "text-[var(--sw-accent-warn)]",
        ].join(" "),

        destructive: [
          "border-[color-mix(in_oklch,var(--sw-accent-error)_30%,transparent)]",
          "bg-[color-mix(in_oklch,var(--sw-accent-error)_12%,transparent)]",
          "text-[var(--sw-accent-error)]",
        ].join(" "),
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): JSX.Element {
  return (
    <span
      data-slot="badge"
      data-variant={variant ?? "default"}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { badgeVariants };
