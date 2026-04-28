// Human-readable labels for wire-shape identifiers (halt reasons,
// model ids, workflow shas/ids, bucket axis ticks). Centralised so any
// future locale work — including a `t()` adapter — lands in one place.
//
// All formatters fall back to the raw input when no mapping is known,
// so a brand-new value never renders as `"unknown"`.

import type { BucketKind } from "../types/analytics.ts";
import { defaultLocale } from "./locale.ts";

// ── Halt reasons (run lifecycle status → display label) ────────────────

// Match the vocabulary the rest of the app uses for run statuses
// (see `format.ts` `statusLabel` and `RunStatusBadge`). "Done"/"Failed"
// drift from "success"/"failure" and read inconsistently across surfaces.
const HALT_LABELS: Record<string, string> = {
  completed: "Success",
  halted: "Failure",
  quarantined: "Quarantined",
  cancelled: "Cancelled",
  paused_hitl: "Awaiting human",
  paused_provider_error: "Provider error",
  running: "Running",
  queued: "Queued",
};

export function humanizeHaltReason(status: string): string {
  return HALT_LABELS[status] ?? titleCaseFromSnake(status);
}

/** Map a halt-reason key to a Swarm CSS-var name (without the `--` prefix)
 *  so chart segments and donut slices share colour with the rest of the
 *  UI. Reads off `theme.css` accents — defined per the design skill. */
export function haltReasonAccentVar(status: string): string {
  switch (status) {
    case "completed":
      return "--sw-accent-success";
    case "halted":
    case "quarantined":
      return "--sw-accent-error";
    case "paused_hitl":
      return "--sw-accent-human";
    case "paused_provider_error":
    case "cancelled":
      return "--sw-accent-warn";
    case "running":
      return "--sw-accent-thinking";
    default:
      return "--sw-accent-idle";
  }
}

// ── Models ─────────────────────────────────────────────────────────────

/** Pretty model labels. Source of truth for the major families;
 *  unknown ids fall through to the raw string so a new model isn't
 *  hidden behind a generic placeholder. */
export function humanizeModel(id: string): string {
  if (!id) return id;
  // Strip provider qualifier if present (e.g. "anthropic/claude-...").
  const bare = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  // Common Anthropic shape: claude-(family)-N-M[-suffix]
  const claude = bare.match(/^claude-(opus|sonnet|haiku)-?(\d+)?-?(\d+)?(?:-(.+))?$/i);
  if (claude) {
    const family = capitalize(claude[1] ?? "");
    const major = claude[2];
    const minor = claude[3];
    const suffix = claude[4];
    const ver = major && minor ? `${major}.${minor}` : (major ?? "");
    return `Claude ${family}${ver ? ` ${ver}` : ""}${suffix ? ` (${suffix})` : ""}`.trim();
  }
  // GPT-4o style → "GPT-4o"
  const gpt = bare.match(/^gpt-(.+)$/i);
  if (gpt) return `GPT-${gpt[1]}`;
  return titleCaseFromSnake(bare);
}

// ── Workflows ──────────────────────────────────────────────────────────

/** Pretty workflow label. Server returns `workflowName` when registered;
 *  fall back to a Title-Cased rendering of the kebab/snake id, and to a
 *  shortened sha (8 chars) when that's all we have. */
export function humanizeWorkflow(name: string | null | undefined, sha?: string | null): string {
  if (name && name.length > 0) return titleCaseFromKebab(stripDotExt(name));
  if (sha && sha.length > 0) return sha.slice(0, 8);
  return "Unknown";
}

// ── Bucket axis ────────────────────────────────────────────────────────

/** Format a bucket-start unix-ms for the chart x-axis. Locale-aware
 *  via `Intl.DateTimeFormat`. */
export function formatBucketTick(bucketMs: number, kind: BucketKind, locale: string = defaultLocale()): string {
  const d = toBucketDate(bucketMs);
  if (!d) return "";
  if (kind === "hour") {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).format(d);
  }
  if (kind === "day") {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(d);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", year: "2-digit" }).format(d);
}

/** Tooltip-grade label for a bucket — wider than the axis tick. */
export function formatBucketTooltip(bucketMs: number, kind: BucketKind, locale: string = defaultLocale()): string {
  const d = toBucketDate(bucketMs);
  if (!d) return "";
  if (kind === "hour") {
    // dateStyle/timeStyle can't be combined with individual fields
    // (hour/minute) — Intl throws "Invalid option : option". Use the
    // two presets together instead.
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
  }
  if (kind === "day") {
    return new Intl.DateTimeFormat(locale, { weekday: "short", month: "long", day: "numeric" }).format(d);
  }
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(d);
}

/** Coerce a bucket-ms argument into a valid Date or `null`. Recharts
 *  tooltips can fire with `undefined`/`NaN`/category-index values
 *  during transient render states — passing those to `Intl.DateTimeFormat`
 *  raises `RangeError: Invalid time value`. */
function toBucketDate(bucketMs: number): Date | null {
  if (!Number.isFinite(bucketMs)) return null;
  const d = new Date(bucketMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Comparison delta ───────────────────────────────────────────────────

export type DeltaTone = "positive" | "negative" | "neutral";

export interface ComparisonDelta {
  /** Signed ratio. `null` when previous is 0 / null and current > 0
   *  (no meaningful prior to compare against). */
  ratio: number | null;
  tone: DeltaTone;
}

/** For most metrics, "more" is good (more runs, more tokens, higher
 *  cache hit rate). For spend, "more" is bad — the caller passes
 *  `direction: 'inverse'` to flip the colour-coding. */
export type DeltaDirection = "normal" | "inverse";

export function computeDelta(
  current: number,
  previous: number | null | undefined,
  direction: DeltaDirection = "normal",
): ComparisonDelta {
  if (previous == null || previous === 0) {
    if (current === 0) return { ratio: 0, tone: "neutral" };
    return { ratio: null, tone: "neutral" };
  }
  const ratio = (current - previous) / previous;
  if (ratio === 0) return { ratio: 0, tone: "neutral" };
  const positive = direction === "inverse" ? ratio < 0 : ratio > 0;
  return { ratio, tone: positive ? "positive" : "negative" };
}

// ── Internals ──────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

function titleCaseFromSnake(s: string): string {
  return s
    .split(/[_-]/)
    .filter((w) => w.length > 0)
    .map(capitalize)
    .join(" ");
}

function titleCaseFromKebab(s: string): string {
  return titleCaseFromSnake(s);
}

function stripDotExt(name: string): string {
  return name.replace(/\.dot$/i, "");
}
