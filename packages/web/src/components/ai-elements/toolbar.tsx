"use client";

import { NodeToolbar, Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

// SKILL.md § Color — drawers/panels sit on `surface` (one notch off bg),
// separated by a hairline rather than a shade shift.
// SKILL.md § Borders & elevation — 4px radius for drawer-class surfaces;
// no `box-shadow` (neutralize any library default).
// SKILL.md § Spacing — 4px (`p-1`) padding; first drafts should feel
// slightly too tight.
export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn("flex items-center gap-1 rounded-md border bg-card p-1 shadow-none!", className)}
    position={Position.Bottom}
    {...props}
  />
);
