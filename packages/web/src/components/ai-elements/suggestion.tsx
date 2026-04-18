"use client";

import type { ComponentProps } from "react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/*
 * Suggestion — Swarm design language.
 *
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Borders & elevation — "Radius: 2px default, 4px cards/drawers...
 *                            Pills only where the pill *is* the status
 *                            shape." A suggestion is an action, not a
 *                            status; defer to Button's 2px radius.
 *   § Spacing              — "These steps only — no arbitrary px." No
 *                            px-* overrides on top of the Button size
 *                            variant; padding is the size variant's job.
 *   § Anti-patterns        — "Default answer to 'should I add something'
 *                            is no." Wrapper adds no chrome of its own.
 */

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn("flex w-max flex-nowrap items-center gap-[var(--sw-space-2)]", className)}>{children}</div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(() => {
    onClick?.(suggestion);
  }, [onClick, suggestion]);

  return (
    <Button className={className} onClick={handleClick} size={size} type="button" variant={variant} {...props}>
      {children || suggestion}
    </Button>
  );
};
