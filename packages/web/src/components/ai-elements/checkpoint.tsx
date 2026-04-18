"use client";

import type { LucideProps } from "lucide-react";
import { BookmarkIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Checkpoint — inline marker + optional action for a saved point in a run.
 *
 * Styling notes (see .agents/skills/design/SKILL.md):
 *   - Token-only colour and spacing, no shadcn aliases (`text-muted-foreground`
 *     → `text-[var(--sw-muted)]`). § Color: "Components reference theme tokens".
 *   - Gap snaps to the 4px scale via `--sw-space-05` (2px icon-to-label).
 *     § Spacing: "These steps only — no arbitrary px".
 *   - Icon sized off the type scale, not Tailwind's `size-4`. The checkpoint
 *     mark sits next to body text, so it tracks `--sw-text-base` (13px).
 *     § Typography: hierarchy via tokens.
 *   - Trigger inherits Button's already-revamped tokens; tooltip carries
 *     secondary copy off the row. § Calm control: "secondary actions live
 *     behind hover, tooltip, or drawer".
 */

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;

export const Checkpoint = ({ className, children, ...props }: CheckpointProps) => (
  <div
    className={cn("flex items-center overflow-hidden", "gap-[var(--sw-space-05)]", "text-[var(--sw-muted)]", className)}
    {...props}
  >
    {children}
    <Separator />
  </div>
);

export type CheckpointIconProps = LucideProps;

export const CheckpointIcon = ({ className, children, ...props }: CheckpointIconProps) =>
  children ?? <BookmarkIcon className={cn("size-[var(--sw-text-base)] shrink-0", className)} {...props} />;

export type CheckpointTriggerProps = ComponentProps<typeof Button> & {
  tooltip?: string;
};

export const CheckpointTrigger = ({
  children,
  variant = "ghost",
  size = "sm",
  tooltip,
  ...props
}: CheckpointTriggerProps) =>
  tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size={size} type="button" variant={variant} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent align="start" side="bottom">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  ) : (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
    </Button>
  );
