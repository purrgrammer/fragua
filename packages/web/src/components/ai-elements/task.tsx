"use client";

import { ChevronDownIcon, SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * Task — disclosure block for an in-flight or completed agent task.
 *
 * Styling notes (see .swarm/skills/design/SKILL.md):
 *   - Token-only colour, spacing, radius (no shadcn aliases, no hex,
 *     no off-scale px). § Authoring checklist.
 *   - File chips render as quiet 2px-radius surface pills, hairline
 *     border, no shadow. § Borders: "1px only", "Radius: 2px default".
 *   - Disclosure motion is transform/opacity only, paired easing with
 *     the chevron rotation, `--sw-duration-enter`, `ease-out`.
 *     § Motion: "Drawer / panel enter-exit … 200ms ease-out";
 *     "paired elements share easing and duration".
 *   - Indent rail is a 1px hairline, not a 2px bar. § Borders.
 */

export type TaskItemFileProps = ComponentProps<"div">;

export const TaskItemFile = ({ children, className, ...props }: TaskItemFileProps) => (
  <div
    className={cn(
      // Hairline pill, surface tone, tabular numerics inherited from body.
      "inline-flex items-center",
      "gap-[var(--sw-space-1)]",
      "px-[var(--sw-space-2)] py-[var(--sw-space-05)]",
      "rounded-[var(--sw-radius-default)]",
      "border border-[var(--sw-border)] bg-[var(--sw-surface)]",
      "text-[length:var(--sw-text-xs)] leading-none text-[var(--sw-text)]",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type TaskItemProps = ComponentProps<"div">;

export const TaskItem = ({ children, className, ...props }: TaskItemProps) => (
  <div
    className={cn("text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]", className)}
    {...props}
  >
    {children}
  </div>
);

export type TaskProps = ComponentProps<typeof Collapsible>;

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
};

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  <CollapsibleTrigger asChild className={cn("group", className)} {...props}>
    {children ?? (
      <div
        className={cn(
          "flex w-full cursor-pointer items-center",
          "gap-[var(--sw-space-2)]",
          "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",
          // Hover: colour shift only, 120ms ease (§ Motion: "Hover … 120ms ease").
          "transition-colors duration-[var(--sw-duration-hover)] ease",
          "hover:text-[var(--sw-text)]",
        )}
      >
        <SearchIcon className="size-[var(--sw-text-md)]" />
        <p className="flex-1">{title}</p>
        <ChevronDownIcon
          className={cn(
            "size-[var(--sw-text-md)]",
            // Status-flip motion: transform only, paired with content
            // open/close. § Motion: status transition 160ms ease.
            "transition-transform duration-[var(--sw-duration-status)] ease",
            "group-data-[state=open]:rotate-180",
          )}
        />
      </div>
    )}
  </CollapsibleTrigger>
);

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>;

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      // Enter/exit on transform + opacity only, paired easing with the
      // chevron. § Motion: "Only animate transform and opacity";
      // "Drawer / panel enter-exit … 200ms ease-out".
      "overflow-hidden outline-none",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
      "data-[state=open]:slide-in-from-top-1 data-[state=closed]:slide-out-to-top-1",
      "duration-[var(--sw-duration-enter)] ease-out",
      "text-[var(--sw-text)]",
      className,
    )}
    {...props}
  >
    <div
      className={cn(
        "mt-[var(--sw-space-3)] pl-[var(--sw-space-3)]",
        "space-y-[var(--sw-space-2)]",
        // Hairline indent rail, not a 2px bar. § Borders: "1px only".
        "border-l border-[var(--sw-border)]",
      )}
    >
      {children}
    </div>
  </CollapsibleContent>
);
