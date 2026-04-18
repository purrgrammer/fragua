import type { ConnectionLineComponent } from "@xyflow/react";

const HALF = 0.5;

/**
 * Connection-in-progress preview rendered while the user drags from a handle.
 * Structural scaffolding, not state — uses the hairline `--sw-border` token,
 * with the target dot filled in `--sw-bg` so it reads as an open ring on both
 * themes. No decorative animation: the line already follows the cursor.
 */
export const Connection: ConnectionLineComponent = ({ fromX, fromY, toX, toY }) => (
  <g>
    <path
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke="var(--sw-border)"
      strokeWidth={1}
    />
    <circle cx={toX} cy={toY} fill="var(--sw-bg)" r={3} stroke="var(--sw-border)" strokeWidth={1} />
  </g>
);
