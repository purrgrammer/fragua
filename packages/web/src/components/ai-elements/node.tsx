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
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Borders & elevation — "1px only", "Radius … 4px cards/drawers",
 *                           "Elevation: none". Radius comes from Card's
 *                           --sw-radius-card; no local rounded-md.
 *   § Anti-patterns       — "Background shade for hierarchy → same
 *                           surface, hairline." Header and footer sit on
 *                           the same surface as the body; separation is
 *                           a single hairline (border-b / border-t).
 *                           No bg-secondary layer.
 *   § Layout              — "Consistent padding inside every cell —
 *                           spacing.3 … Don't vary by 'importance.'"
 *                           All slots land on --sw-space-3 by default
 *                           (Card's own header/content/footer padding).
 *                           We do NOT re-declare padding here — that
 *                           avoids `p-3!` overrides and lets Card own
 *                           the token.
 *   § Color               — "only --sw-* tokens". Explicit border token.
 *   § Principle 1 (calm)  — gap-0 between slots so the node reads as
 *                           three flush bands, not a stack of padded
 *                           boxes; the hairline is the only rhythm.
 *
 * Behavioural API (slots, xyflow Handles, props passthrough) preserved.
 */

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean;
    source: boolean;
  };
};

export const Node = ({ handles, className, ...props }: NodeProps) => (
  <Card
    // gap-0: header/content/footer are flush; hairline is the separation.
    // h-auto + relative: required for xyflow handle anchoring.
    // No local radius — Card owns --sw-radius-card.
    className={cn("relative h-auto w-sm gap-0 p-0", className)}
    {...props}
  >
    {handles.target && <Handle position={Position.Left} type="target" />}
    {handles.source && <Handle position={Position.Right} type="source" />}
    {props.children}
  </Card>
);

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
