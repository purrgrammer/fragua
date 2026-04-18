import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/*
 * ButtonGroup — Swarm design language.
 *
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Borders & elevation — "Radius: 2px default" — group corners snap
 *                           to --sw-radius-default to match Button, not
 *                           Tailwind's `rounded-lg` (8px).
 *   § Spacing              — "These steps only — no arbitrary px" —
 *                            inter-group gap and inset text padding use
 *                            --sw-space-* tokens (no `gap-2`/`px-2.5`).
 *   § Color                — "Components reference theme tokens" —
 *                            inline text label uses --sw-surface /
 *                            --sw-border / --sw-text; the separator
 *                            slot rides on --sw-border (the hairline
 *                            tone), never the legacy shadcn --input.
 *   § Typography           — monospace voice, 12px (--sw-text-sm) body;
 *                            no font-family override here.
 *
 * Behavioural API (orientation, asChild, props passthrough, slot
 * structure for adjacent-rounding overrides) preserved.
 */

const buttonGroupVariants = cva(
  [
    "group/button-group flex w-fit items-stretch",
    "*:focus-visible:relative *:focus-visible:z-10",
    // Nested groups separate by a single spacing token, not `gap-2`.
    "has-[>[data-slot=button-group]]:gap-[var(--sw-space-2)]",
    // Trailing select trigger keeps the group's right corner.
    "has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-[var(--sw-radius-default)]",
    "[&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit",
    "[&>input]:flex-1",
  ].join(" "),
  {
    variants: {
      orientation: {
        horizontal: [
          "[&>*:not(:first-child)]:rounded-l-none",
          "[&>*:not(:first-child)]:border-l-0",
          "[&>*:not(:last-child)]:rounded-r-none",
          // Last slot resets to the default 2px radius (button parity).
          "[&>[data-slot]:not(:has(~[data-slot]))]:rounded-r-[var(--sw-radius-default)]!",
        ].join(" "),
        vertical: [
          "flex-col",
          "[&>*:not(:first-child)]:rounded-t-none",
          "[&>*:not(:first-child)]:border-t-0",
          "[&>*:not(:last-child)]:rounded-b-none",
          "[&>[data-slot]:not(:has(~[data-slot]))]:rounded-b-[var(--sw-radius-default)]!",
        ].join(" "),
      },
    },
    defaultVariants: {
      orientation: "horizontal",
    },
  },
);

function ButtonGroup({
  className,
  orientation,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation }), className)}
      {...props}
    />
  );
}

function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "div";

  return (
    <Comp
      className={cn(
        // structure: hairline border, 2px corners, surface fill.
        "flex items-center gap-[var(--sw-space-1)]",
        "rounded-[var(--sw-radius-default)]",
        "border border-[var(--sw-border)]",
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        // spacing on the 4px scale.
        "px-[var(--sw-space-2)]",
        // typography: monospace inherited; 12px body, medium weight.
        "font-mono font-medium text-[length:var(--sw-text-sm)]",
        // icons
        "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        // 1px hairline that spans the group axis, on the --sw-border
        // tone — never the legacy `bg-input`.
        "relative self-stretch bg-[var(--sw-border)]",
        "data-horizontal:mx-px data-horizontal:w-auto",
        "data-vertical:my-px data-vertical:h-auto",
        className,
      )}
      {...props}
    />
  );
}

export { ButtonGroup, ButtonGroupSeparator, ButtonGroupText, buttonGroupVariants };
