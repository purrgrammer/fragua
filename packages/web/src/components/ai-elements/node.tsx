import { Handle, Position } from "@xyflow/react";
import type { ComponentProps } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/*
 * Node — Swarm design language.
 *
 * A graph node is a Card placed on a canvas; it re-uses Card's tokens
 * verbatim and adds only what a flow-node needs: xyflow handles and the
 * flush header/footer layout (no inter-slot gap so the hairline carries
 * the separation).
 *
 * Behavioural API (slots, xyflow Handles, props passthrough) preserved.
 */

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean;
    source: boolean;
    /**
     * Flow direction this node sits in. `"TB"` routes handles through
     * Top/Bottom (workflow reads top-to-bottom), `"LR"` through
     * Left/Right. Defaults to `"TB"` — the canonical orientation for
     * swarm workflows. xyflow needs this to know which edge port each
     * Handle binds to.
     */
    orientation?: "TB" | "LR";
  };
};

export const Node = ({ handles, className, ...props }: NodeProps) => {
  const orientation = handles.orientation ?? "TB";
  const targetPos = orientation === "TB" ? Position.Top : Position.Left;
  const sourcePos = orientation === "TB" ? Position.Bottom : Position.Right;
  return (
    <Card
      // gap-0: header/content/footer are flush; hairline is the separation.
      // h-auto + relative: required for xyflow handle anchoring.
      // No local radius — Card owns --sw-radius-card.
      className={cn("relative h-auto w-sm gap-0 p-0", className)}
      {...props}
    >
      {handles.target && <Handle position={targetPos} type="target" />}
      {handles.source && <Handle position={sourcePos} type="source" />}
      {props.children}
    </Card>
  );
};

export type NodeHeaderProps = ComponentProps<typeof CardHeader>;

export const NodeHeader = ({ className, ...props }: NodeHeaderProps) => (
  <CardHeader
    // Same surface as the card body (no bg-secondary hierarchy).
    // Bottom hairline carries the separation. Padding y matches x,
    // both sourced from the spacing scale (--sw-space-3).
    className={cn("gap-[var(--sw-space-05)] border-b border-[var(--sw-border)]", "py-[var(--sw-space-3)]", className)}
    {...props}
  />
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = (props: NodeTitleProps) => <CardTitle {...props} />;

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = (props: NodeDescriptionProps) => <CardDescription {...props} />;

export type NodeActionProps = ComponentProps<typeof CardAction>;

export const NodeAction = (props: NodeActionProps) => <CardAction {...props} />;

export type NodeContentProps = ComponentProps<typeof CardContent>;

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  // Card's CardContent already pads on x via --sw-space-3; add matching y
  // so flow-node bodies read as a properly enclosed cell.
  <CardContent className={cn("py-[var(--sw-space-3)]", className)} {...props} />
);

export type NodeFooterProps = ComponentProps<typeof CardFooter>;

export const NodeFooter = ({ className, ...props }: NodeFooterProps) => (
  // CardFooter already owns the top hairline and tokenised padding on
  // the same surface as the body — no bg-secondary, no radius override.
  <CardFooter className={cn(className)} {...props} />
);
