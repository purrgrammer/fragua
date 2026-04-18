import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/*
 * Panel — Swarm design language.
 *
 * Floating overlay anchored to a ReactFlow canvas (zoom controls,
 * minimap frames, contextual toolbars). Visually a small bento cell
 * sitting above the canvas surface — same hairline + radius rules as
 * Card; no shadow.
 *
 * Behavioural API (ReactFlow Panel passthrough) preserved.
 */

type PanelProps = ComponentProps<typeof PanelPrimitive>;

export const Panel = ({ className, ...props }: PanelProps) => (
  <PanelPrimitive
    className={cn(
      // float: panel margin from canvas edge (token scale)
      "m-[var(--sw-space-4)] overflow-hidden",
      // surface + hairline (no shadow, no ring)
      "bg-[var(--sw-surface)] text-[var(--sw-text)]",
      "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
      // inner padding hugs the framed control
      "p-[var(--sw-space-2)]",
      className,
    )}
    {...props}
  />
);
