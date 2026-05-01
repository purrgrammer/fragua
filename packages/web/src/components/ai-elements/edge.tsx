import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSimpleBezierPath } from "@xyflow/react";

type EdgeTone = "muted" | "warn" | "thinking" | "success" | "error";

type EdgeLabelProps = {
  labelX: number;
  labelY: number;
  label: string;
  /** Edge variant — switches the pill tone. */
  tone?: EdgeTone;
  /** Fade when the executor didn't traverse this edge. */
  dim?: boolean;
};

/** Edges the executor never traversed render at reduced opacity. The same
 *  factor applies to both the SVG path and the HTML label pill so they
 *  fade in lock-step — EdgeLabelRenderer renders pills to a sibling DOM
 *  tree, so style on the path alone wouldn't reach them. */
const DIM_OPACITY = 0.3;

/**
 * Build a wide arc path for skip/back edges whose handles live on the
 * node's left or right side. Control points sit past the matching extreme
 * handle x so the curve — and the edge label at its midpoint — clears
 * the node column instead of cutting through it. Returns the SVG path
 * and the (labelX, labelY) midpoint used to anchor the edge pill.
 *
 * `arcIndex` lets the host stagger multiple arcs on the same side so they
 * don't overlap. Each step bumps the bulge outward by `ARC_SPREAD_STEP`
 * pixels (and the label with it). Index 0 sits at the base offset.
 */
const ARC_SPREAD_STEP = 36;
const wideArcPath = (
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  side: "right" | "left" = "right",
  arcIndex = 0,
): [string, number, number] => {
  // Arc depth scales with the vertical span so short loops get a gentle
  // arc and long skip-edges push further out. 100 min keeps the label
  // visibly outside a 240-wide node.
  const span = Math.abs(ty - sy);
  const baseOffset = Math.max(100, Math.min(180, 60 + span * 0.25));
  const offset = baseOffset + Math.max(0, arcIndex) * ARC_SPREAD_STEP;
  const extreme = side === "right" ? Math.max(sx, tx) : Math.min(sx, tx);
  const cx = side === "right" ? extreme + offset : extreme - offset;
  const path = `M ${sx},${sy} C ${cx},${sy} ${cx},${ty} ${tx},${ty}`;
  // Pull the label slightly inside the arc peak so it sits *just* off-
  // column rather than at the bulge tip. Sign mirrors the side.
  const labelX = side === "right" ? cx - 8 : cx + 8;
  const labelY = (sy + ty) / 2;
  return [path, labelX, labelY];
};

// Small inline pill rendered at the edge's midpoint. Shows DOT edge
// `condition` / `label` attrs ("outcome=success", etc.) so readers can
// tell branching edges apart without opening the inspector.
const EdgeLabel = ({ labelX, labelY, label, tone = "muted", dim }: EdgeLabelProps) => {
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
          opacity: dim ? DIM_OPACITY : 1,
        }}
        className={`pointer-events-auto rounded-sw-default border px-1 py-0.5 text-sw-xs uppercase tracking-[0.06em] ${toneClass}`}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  );
};

type TemporaryData = { label?: string; dim?: boolean };

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

  const d = data as TemporaryData | undefined;
  const label = d?.label;
  const dim = d?.dim;
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
          opacity: dim ? DIM_OPACITY : 1,
        }}
      />
      {label ? (
        <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "muted"} dim={dim} />
      ) : null}
    </>
  );
};

type LoopData = TemporaryData & { arcIndex?: number };

type LoopProps = EdgeProps &
  OutcomeProp & {
    /** Which side the arc bulges toward. Real back-edges and self-loops
     *  arc right (matching the right-side handles GraphView mounts);
     *  synthetic goal-gate retargets arc left to claim a separate visual
     *  channel. Defaults to right for backward compatibility. */
    arcSide?: "left" | "right";
  };

// Back-edge — "loop" return arrow. Dashed; tone defaults to muted so retry
// channels read as structural backflow rather than negative outcomes (the
// warn / error accents are reserved for forward-edge `outcome=fail`).
// `arcSide` picks which side the bulge falls on so retarget edges and
// regular loops can coexist without overlapping arcs.
const Loop = ({ id, sourceX, sourceY, targetX, targetY, markerEnd, data, outcome, arcSide = "right" }: LoopProps) => {
  const d = data as LoopData | undefined;
  const arcIndex = typeof d?.arcIndex === "number" ? d.arcIndex : 0;
  const [edgePath, labelX, labelY] = wideArcPath(sourceX, sourceY, targetX, targetY, arcSide, arcIndex);

  const label = d?.label;
  const dim = d?.dim;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke: outcomeStroke ?? "var(--sw-accent-idle)",
          strokeDasharray: "4, 4",
          strokeWidth: 1,
          opacity: dim ? DIM_OPACITY : 1,
        }}
      />
      {label ? (
        <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "muted"} dim={dim} />
      ) : null}
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

  const d = data as TemporaryData | undefined;
  const label = d?.label;
  const dim = d?.dim;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  // "Active stream" state — pulse the edge itself in the thinking accent.
  // Uses the shared `.sw-pulse` keyframe (1800ms ease-in-out, opacity-only,
  // honors prefers-reduced-motion). No traveling ornament.
  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke: outcomeStroke ?? "var(--sw-accent-thinking)",
          strokeWidth: 1,
          opacity: dim ? DIM_OPACITY : 1,
          ...style,
        }}
      />
      {label ? (
        <EdgeLabel labelX={labelX} labelY={labelY} label={label} tone={outcomeTone ?? "thinking"} dim={dim} />
      ) : null}
    </>
  );
};

export const Edge = {
  Animated,
  Loop,
  Temporary,
};
