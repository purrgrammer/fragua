/**
 * Canvas — `@xyflow/react` host for graph views.
 *
 * Design rules applied:
 *   - § Principle 2 (Data as decor): "Ornament gets deleted." The default
 *     xyflow dot/line `<Background />` is decorative — nodes and edges already
 *     carry the rhythm — so it is omitted.
 *   - § Color: "Components reference theme tokens." The canvas surface is the
 *     page surface (`--sw-bg`); separation from siblings is via hairline at
 *     the parent, never via a different shade here.
 *   - § Principle 5 (Restrained semantic color): no accents at the canvas
 *     layer — color is reserved for node/edge state.
 */
import type { ReactFlowProps } from "@xyflow/react";
import { ReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";

import "@xyflow/react/dist/style.css";

type CanvasProps = ReactFlowProps & {
  children?: ReactNode;
};

const deleteKeyCode = ["Backspace", "Delete"];

export const Canvas = ({ children, style, ...props }: CanvasProps) => (
  <ReactFlow
    deleteKeyCode={deleteKeyCode}
    fitView
    panOnDrag={false}
    panOnScroll
    selectionOnDrag={true}
    style={{ background: "var(--sw-bg)", ...style }}
    zoomOnDoubleClick={false}
    {...props}
  >
    {children}
  </ReactFlow>
);
