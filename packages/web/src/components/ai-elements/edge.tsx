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
  /** Slot within a parallel-edge group (same source + target). When set
   *  alongside `parallelCount > 1`, the label is offset cross-axis so
   *  stacked routes (e.g. `triage -> plan [route=small|feature]`) don't
   *  draw on top of each other. */
  parallelIndex?: number;
  parallelCount?: number;
};

/** Per-slot cross-axis offset for parallel edges. Roughly one pill height
 *  so adjacent labels read as a stack, not a single overlapping blob. */
const PARALLEL_LABEL_STEP = 22;

/** Edges the executor never traversed render at reduced opacity. The same
 *  factor applies to both the SVG path and the HTML label pill so they
 *  fade in lock-step — EdgeLabelRenderer renders pills to a sibling DOM
 *  tree, so style on the path alone wouldn't reach them. */
const DIM_OPACITY = 0.3;

/**
 * Build a wide arc path for skip/back edges whose handles live on the
 * node's left or right side. Control points sit past the matching extreme
 * handle x so the curve — and the edge label near its source end — clears
 * the node column instead of cutting through it. Returns the SVG path
 * and the (labelX, labelY) anchor used by the edge pill.
 *
 * `arcIndex` lets the host stagger multiple arcs on the same side so they
 * don't overlap. Each step bumps the bulge outward by `ARC_SPREAD_STEP`
 * pixels (and the label with it). Index 0 sits at the base offset.
 *
 * Label positioning: anchored at `LABEL_T` along the cubic Bézier (0 =
 * source, 1 = target). Putting it near the source — rather than the arc
 * midpoint — makes it obvious *which* node the branch leaves. Especially
 * valuable for `outcome=fail` edges where the operator wants to see
 * "this is the fail path out of <node>" without tracing the curve.
 */
// Wider spread between stacked arcs. With three skip-edges converging on
// the same exit node (e.g. `route -> done`, `signoff -> done`,
// `run_tests -> done`), 36px-per-step kept the bulges close enough that
// the curves overlapped near the shared target. 64px gives each arc its
// own visual lane plus enough room for the label pill at the source end.
const ARC_SPREAD_STEP = 64;
// Anchor labels slightly past 1/3 along the curve. Earlier values
// (0.3) put the pill very close to the source node, so on short
// skip-edges the pill landed on top of the source body. 0.35 keeps
// the "this branch leaves <node>" reading while clearing the body.
const LABEL_T = 0.35;
// Margin beyond the measured lateral extent of intermediate-layer
// nodes — the arc bulge is pushed at least `extent + ARC_MARGIN`
// outward so it clears wide parallel fans without grazing the
// rightmost (or leftmost) branch column.
const ARC_EXTENT_MARGIN = 48;
// Left-side arcs (synthetic retargets) carry a small base bump on top of
// the shared offset so their labels — sitting at LABEL_T near the source —
// don't land on top of the node column when the arc is short. Right-side
// arcs already clear comfortably; bumping them too would over-widen the
// loop channel for no reason.
const LEFT_ARC_BASE_BOOST = 28;
const wideArcPath = (
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  side: "right" | "left" = "right",
  arcIndex = 0,
  /** Optional lateral-extent floor (px). When set, the control x is
   *  clamped so the arc bulge sits at least `minExtent + margin` past
   *  the origin on the chosen side. The xyflow handle coordinates are
   *  in flow-canvas space (origin at the canvas root), so the same
   *  scale that produced `minExtent` from `layoutDag` positions
   *  applies directly here. */
  minExtent = 0,
): [string, number, number] => {
  // Arc depth scales with the vertical span so short loops get a gentle
  // arc and long skip-edges push further out. 100 min keeps the label
  // visibly outside a 240-wide node.
  const span = Math.abs(ty - sy);
  const baseOffset = Math.max(100, Math.min(180, 60 + span * 0.25)) + (side === "left" ? LEFT_ARC_BASE_BOOST : 0);
  const offset = baseOffset + Math.max(0, arcIndex) * ARC_SPREAD_STEP;
  const extreme = side === "right" ? Math.max(sx, tx) : Math.min(sx, tx);
  let cx = side === "right" ? extreme + offset : extreme - offset;
  // Push past the parallel-fan extent if the host measured one. The
  // floor is a *lower* bound — if the arcIndex stagger already widens
  // the bulge past it, the natural offset wins.
  if (minExtent > 0) {
    const floor = minExtent + ARC_EXTENT_MARGIN;
    if (side === "right") cx = Math.max(cx, floor);
    else cx = Math.min(cx, -floor);
  }
  const path = `M ${sx},${sy} C ${cx},${sy} ${cx},${ty} ${tx},${ty}`;
  // Anchor the label at LABEL_T along the actual cubic Bézier so it
  // tracks the curve rather than a linear midpoint approximation. With
  // P1 = (cx, sy) and P2 = (cx, ty), the x is dominated by cx through
  // most of the curve and the y interpolates monotonically from sy to ty.
  const [labelX, labelY] = bezierPoint(LABEL_T, [sx, sy], [cx, sy], [cx, ty], [tx, ty]);
  return [path, labelX, labelY];
};

/** Cubic Bézier point evaluator. P0 → P3 are the four control points
 *  (start, ctrl1, ctrl2, end). `t` is in [0, 1]. */
const bezierPoint = (
  t: number,
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
): [number, number] => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return [w0 * p0[0] + w1 * p1[0] + w2 * p2[0] + w3 * p3[0], w0 * p0[1] + w1 * p1[1] + w2 * p2[1] + w3 * p3[1]];
};

// Small inline pill rendered at the edge's midpoint. Shows workflow edge
// `condition` / `label` attrs ("outcome=success", etc.) so readers can
// tell branching edges apart without opening the inspector.
const EdgeLabel = ({ labelX, labelY, label, tone = "muted", dim, parallelIndex, parallelCount }: EdgeLabelProps) => {
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
  const stackOffset =
    typeof parallelIndex === "number" && typeof parallelCount === "number" && parallelCount > 1
      ? (parallelIndex - (parallelCount - 1) / 2) * PARALLEL_LABEL_STEP
      : 0;
  return (
    <EdgeLabelRenderer>
      <div
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + stackOffset}px)`,
          // Non-interactive — click-throughs to underlying nodes when
          // the pill overlaps a node body on dense graphs.
          pointerEvents: "none",
          opacity: dim ? DIM_OPACITY : 1,
        }}
        className={`rounded-sw-default border px-1 py-0.5 text-sw-xs uppercase tracking-[0.06em] ${toneClass}`}
      >
        {label}
      </div>
    </EdgeLabelRenderer>
  );
};

type TemporaryData = {
  label?: string;
  dim?: boolean;
  /** Bulge stagger for arcOut mode. Shared with Loop's per-side counter
   *  so back-edges and right-side skip-edges don't draw on top of each
   *  other. Ignored when `arcOut` is false. */
  arcIndex?: number;
  /** Lateral-extent floor (px) for the arc bulge. Set by the host when
   *  the arc has to clear a parallel fan; ignored when undefined or 0. */
  arcExtent?: number;
  /** Human-node edges (adjacent to a `kind=human` node) lift to the
   *  idle-gray retry tone instead of the default very-faint border so
   *  operator-choice routes stand out at a glance. Set by the host when
   *  either the source or target has `kind=human`; Temporary picks up the
   *  matching stroke. */
  isHumanEdge?: boolean;
  /** Slot within a parallel-edge group (same source + target). Lets the
   *  label renderer stagger labels along the cross-axis so they don't
   *  stack at the midpoint. */
  parallelIndex?: number;
  parallelCount?: number;
};

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
  const d = data as TemporaryData | undefined;
  const arcIndex = typeof d?.arcIndex === "number" ? d.arcIndex : 0;
  const arcExtent = typeof d?.arcExtent === "number" ? d.arcExtent : 0;
  const [edgePath, labelX, labelY] = arcOut
    ? wideArcPath(sourceX, sourceY, targetX, targetY, "right", arcIndex, arcExtent)
    : getSimpleBezierPath({
        sourcePosition,
        sourceX,
        sourceY,
        targetPosition,
        targetX,
        targetY,
      });

  const label = d?.label;
  const dim = d?.dim;
  const outcomeStroke = strokeForOutcome(outcome);
  const outcomeTone = toneForOutcome(outcome);

  // Hairline (1px). Stroke priority: outcome accent (semantic) >
  // human-node idle-gray (visibility lift for routes leaving or entering
  // a `kind=human` node) > default border (the quietest tier, plain flow).
  const stroke = outcomeStroke ?? (d?.isHumanEdge ? "var(--sw-accent-idle)" : "var(--sw-border)");
  return (
    <>
      <BaseEdge
        id={id}
        markerEnd={markerEnd}
        path={edgePath}
        style={{
          stroke,
          strokeDasharray: "5, 5",
          strokeWidth: 1,
          opacity: dim ? DIM_OPACITY : 1,
        }}
      />
      {label ? (
        <EdgeLabel
          labelX={labelX}
          labelY={labelY}
          label={label}
          tone={outcomeTone ?? "muted"}
          dim={dim}
          parallelIndex={d?.parallelIndex}
          parallelCount={d?.parallelCount}
        />
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
  const arcExtent = typeof d?.arcExtent === "number" ? d.arcExtent : 0;
  const [edgePath, labelX, labelY] = wideArcPath(sourceX, sourceY, targetX, targetY, arcSide, arcIndex, arcExtent);

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
        <EdgeLabel
          labelX={labelX}
          labelY={labelY}
          label={label}
          tone={outcomeTone ?? "muted"}
          dim={dim}
          parallelIndex={d?.parallelIndex}
          parallelCount={d?.parallelCount}
        />
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
        <EdgeLabel
          labelX={labelX}
          labelY={labelY}
          label={label}
          tone={outcomeTone ?? "thinking"}
          dim={dim}
          parallelIndex={d?.parallelIndex}
          parallelCount={d?.parallelCount}
        />
      ) : null}
    </>
  );
};

export const Edge = {
  Animated,
  Loop,
  Temporary,
};
