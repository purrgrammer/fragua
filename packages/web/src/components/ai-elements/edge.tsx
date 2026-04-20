import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSimpleBezierPath } from "@xyflow/react";

type EdgeTone = "muted" | "warn" | "thinking" | "success" | "error";

type EdgeLabelProps = {
  labelX: number;
  labelY: number;
  label: string;
  /** Edge variant — switches the pill tone. */
  tone?: EdgeTone;
};

/**
 * Build a wide arc path for skip/back edges whose handles live on the
 * node's right side. Control points sit well to the right of the widest
 * handle x so the curve — and the edge label at its midpoint — clears
 * the node column instead of cutting through it. Returns the SVG path
 * and the (labelX, labelY) midpoint used to anchor the edge pill.
 */
const wideArcPath = (sx: number, sy: number, tx: number, ty: number): [string, number, number] => {
  const rightmost = Math.max(sx, tx);
  // Arc depth scales with the vertical span so short loops get a gentle
  // arc and long skip-edges push further out. 120 min keeps the label
  // visibly outside a 240-wide node.
  const span = Math.abs(ty - sy);
  const offset = Math.max(100, Math.min(180, 60 + span * 0.25));
  const cx = rightmost + offset;
  const path = `M ${sx},${sy} C ${cx},${sy} ${cx},${ty} ${tx},${ty}`;
  const labelX = cx - 8; // pull the label slightly inside the arc peak
  const labelY = (sy + ty) / 2;
  return [path, labelX, labelY];
};

// Small inline pill rendered at the edge's midpoint. Shows DOT edge
// `condition` / `label` attrs ("outcome=success", etc.) so readers can
// tell branching edges apart without opening the inspector.
const EdgeLabel = ({ labelX, labelY, label, tone = "muted" }: EdgeLabelProps) => {
  const toneClass =
    tone === "warn"
      ? "bg-sw-surface text-sw-accent-warn border-sw-accent-warn/40"
      : tone === "thinking"
        ? "bg-sw-surface text-sw-accent-thinking border-sw-accent-thinking/40"
        : tone === "success"
          ? "bg-sw-surface text-sw-accent-success border-sw-accent-success/40"
          : tone === "error"
            ? "bg-sw-surface text-sw-accent-error border-sw-accent-error/40"
            : "bg-sw-surface text-sw-muted border-sw-border";
  return (
    <EdgeLabelRenderer>
      <div
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          pointerEvents: "all",
        }}
        className={`pointer-events-auto rounded-sw-default border px-1 py-0.5 text-sw-xs uppercase tracking-[0.06em] ${toneClass}`}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  );
};

type TemporaryData = { label?: string };

/** Outcome coloring — when set, the stroke + label pill track the
 *  outcome accent regardless of the structural edge variant. */
type OutcomeProp = { outcome?: "success" | "fail" };

type TemporaryProps = EdgeProps &
  OutcomeProp & {
    /** When true, route the edge via a wide right-side arc instead of the
     *  default bezier. Used for forward skip-edges so their labels don't
     *  sit behind the intermediate node column. */
    arcOut?: boolean;
  };

const strokeForOutcome = (outcome: OutcomeProp["outcome"]): string | null => {
  if (outcome === "success") return "var(--sw-accent-success)";
  if (outcome === "fail") return "var(--sw-accent-error)";
  return null;
};

const toneForOutcome = (outcome: OutcomeProp["outcome"]): EdgeTone | null => {
  if (outcome === "success") return "success";
  if (outcome === "fail") return "error";
  return null;
};

const Temporary = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  arcOut,
  outcome,
}: TemporaryProps) => {
  const [edgePath, labelX, labelY] = arcOut
    ? wideArcPath(sourceX, sourceY, targetX, targetY)
    : getSimpleBezierPath({
        sourcePosition,
        sourceX,
        sourceY,
        targetPosition,
        targetX,
        targetY,
      });

  const label = (data as TemporaryData | undefined)?.label;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  // Hairline (1px) — default Swarm border tone, or outcome accent when
  // the edge carries pass/fail semantics.
  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke: outcomeStroke ?? "var(--sw-border)",
          strokeDasharray: "5, 5",
          strokeWidth: 1,
        }}
      />
      {label ? <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "muted"} /> : null}
    </>
  );
};

// Back-edge — "loop" return arrow. Dashed in the warn accent so it reads
// distinctly from forward flow; the markerEnd arrow lands on the earlier
// step so the loop direction is unambiguous. The host (GraphView) routes
// these through right-side handles so the arc sits outside the main flow.
const Loop = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
  outcome,
}: EdgeProps & OutcomeProp) => {
  const [edgePath, labelX, labelY] = wideArcPath(sourceX, sourceY, targetX, targetY);

  const label = (data as TemporaryData | undefined)?.label;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke: outcomeStroke ?? "var(--sw-accent-warn)",
          strokeDasharray: "4, 4",
          strokeWidth: 1,
        }}
      />
      {label ? <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "warn"} /> : null}
    </>
  );
};

// Live/running forward edge. Uses the xyflow-supplied handle positions
// (`sourcePosition`/`targetPosition`) so the path always lines up with
// the actual handles — previous versions hard-coded Right/Left, which
// produced a curve to `(0,0)` when the node only had Top/Bottom handles
// in TB orientation. That bug is what made the arrowheads look wrong.
const Animated = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
  outcome,
}: EdgeProps & OutcomeProp) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });

  const label = (data as TemporaryData | undefined)?.label;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  // "Active stream" state — pulse the edge itself in the thinking accent.
  // Uses the shared `.sw-pulse` keyframe (1800ms ease-in-out, opacity-only,
  // honors prefers-reduced-motion). No traveling ornament.
  return (
    <>
      <BaseEdge
        className="sw-pulse"
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke: outcomeStroke ?? "var(--sw-accent-thinking)",
          strokeWidth: 1,
          ...style,
        }}
      />
      {label ? <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "thinking"} /> : null}
    </>
  );
};

export const Edge = {
  Animated,
  Loop,
  Temporary,
};
