"use client";

import { NodeToolbar, Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn("flex items-center gap-1 rounded-md border bg-card p-1 shadow-none!", className)}
    position={Position.Bottom}
    {...props}
  />
);
