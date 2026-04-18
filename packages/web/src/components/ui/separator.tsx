import { Separator as SeparatorPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

/*
 * Separator — Swarm design language.
 *
 * Skill citations (.agents/skills/design/SKILL.md):
 *   § Borders & elevation — "1px only, `border` token. Tone shifts by
 *                           theme, width never." A separator is a
 *                           hairline by definition — width pinned at 1px
 *                           via h-px / w-px, never thicker.
 *   § Color               — "Components reference theme tokens." Uses
 *                           --sw-border (the hairline tone) for both
 *                           themes; never the legacy shadcn --border.
 *   § Anti-pattern        — "Background shade for hierarchy → same
 *                           surface, hairline." The separator is the
 *                           hairline that replaces shade-based
 *                           separation.
 *
 * Behavioural API (orientation, decorative, props passthrough) preserved.
 */

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-[var(--sw-border)]",
        "data-horizontal:h-px data-horizontal:w-full",
        "data-vertical:w-px data-vertical:self-stretch",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
