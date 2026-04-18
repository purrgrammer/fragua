import type { EdgeProps, InternalNode, Node } from "@xyflow/react";
import { BaseEdge, getBezierPath, getSimpleBezierPath, Position, useInternalNode } from "@xyflow/react";

const Temporary = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }: EdgeProps) => {
  const [edgePath] = getSimpleBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });

  // Hairline (1px) in the Swarm border tone — quiet, structural, never ≥2px.
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: "var(--sw-border)",
        strokeDasharray: "5, 5",
        strokeWidth: 1,
      }}
    />
  );
};

const getHandleCoordsByPosition = (node: InternalNode<Node>, handlePosition: Position) => {
  // Choose the handle type based on position - Left is for target, Right is for source
  const handleType = handlePosition === Position.Left ? "target" : "source";

  const handle = node.internals.handleBounds?.[handleType]?.find((h) => h.position === handlePosition);

  if (!handle) {
    return [0, 0] as const;
  }

  let offsetX = handle.width / 2;
  let offsetY = handle.height / 2;

  // this is a tiny detail to make the markerEnd of an edge visible.
  // The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
  // when the handlePosition is Position.Right for example, we need to add an offset as big as the handle itself in order to get the correct position
  switch (handlePosition) {
    case Position.Left: {
      offsetX = 0;
      break;
    }
    case Position.Right: {
      offsetX = handle.width;
      break;
    }
    case Position.Top: {
      offsetY = 0;
      break;
    }
    case Position.Bottom: {
      offsetY = handle.height;
      break;
    }
    default: {
      throw new Error(`Invalid handle position: ${handlePosition}`);
    }
  }

  const x = node.internals.positionAbsolute.x + handle.x + offsetX;
  const y = node.internals.positionAbsolute.y + handle.y + offsetY;

  return [x, y] as const;
};

const getEdgeParams = (source: InternalNode<Node>, target: InternalNode<Node>) => {
  const sourcePos = Position.Right;
  const [sx, sy] = getHandleCoordsByPosition(source, sourcePos);
  const targetPos = Position.Left;
  const [tx, ty] = getHandleCoordsByPosition(target, targetPos);

  return {
    sourcePos,
    sx,
    sy,
    targetPos,
    tx,
    ty,
  };
};

const Animated = ({ id, source, target, markerEnd, style }: EdgeProps) => {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!(sourceNode && targetNode)) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);

  const [edgePath] = getBezierPath({
    sourcePosition: sourcePos,
    sourceX: sx,
    sourceY: sy,
    targetPosition: targetPos,
    targetX: tx,
    targetY: ty,
  });

  // "Active stream" state — pulse the edge itself in the thinking accent.
  // Uses the shared `.sw-pulse` keyframe (1800ms ease-in-out, opacity-only,
  // honors prefers-reduced-motion). No traveling ornament.
  return (
    <BaseEdge
      className="sw-pulse"
      id={id}
      markerEnd={markerEnd}
      path={edgePath}
      style={{
        stroke: "var(--sw-accent-thinking)",
        strokeWidth: 1,
        ...style,
      }}
    />
  );
};

export const Edge = {
  Animated,
  Temporary,
};
