// Pure event-replay helpers shared by the /pipelines and /stats routes.
//
// Lifted out of `routes/pipelines.ts` so the new `routes/stats.ts` can
// reuse the exact same status / workflow-name / duration semantics
// without forcing the routes to import from each other (which is the
// kind of cross-route coupling that festers).
//
// All functions here are pure reducers over an `Event[]`. They have no
// `Date.now()` dependency — running runs get "elapsed up to last
// observed event" rather than wall-clock-now — which keeps server
// tests deterministic without a clock fixture.

import type { Event } from "@swarm/core";
import { aggregateCost, type Projection } from "@swarm/events";
import type { PipelineSummary } from "../schemas.ts";

/** Stable projection key. Future `MaterializedProjectionStore` adapters
 * cache summaries under this name. */
export const SUMMARY_PROJECTION_KEY = "summary";

/** `deriveSummary` as a `Projection` — runId-agnostic. The caller (a
 * route or `foldAll` folder) stitches the runId on after the fact.
 * Keeps the underlying event reducer closure-free so a DB adapter's
 * materialised view never has to track "which runId did this come
 * from" out of band — it's always the surrounding row. */
export const summaryProjection: Projection<Omit<PipelineSummary, "runId">> = (events) => {
  const { runId: _unused, ...rest } = deriveSummary("__projection__", events as Event[]);
  return rest;
};

/** Pure reducer over events → summary. Exported for tests and reuse. */
export function deriveSummary(runId: string, events: Event[]): PipelineSummary {
  const first = events[0];
  const startedAt = first?.timestamp ?? new Date(0).toISOString();
  let workflow: string | undefined;
  let workflowName: string | undefined;
  let input: string | undefined;
  if (first) {
    const data = first.data as {
      workflow?: string;
      workflow_label?: string;
      workflow_path?: string;
      graph_id?: string;
      input?: string;
    };
    workflow = data.workflow ?? data.workflow_label ?? first.workflow_sha;
    workflowName = deriveWorkflowName(data, first.workflow_sha);
    if (typeof data.input === "string" && data.input.length > 0) input = data.input;
  }
  // Cost/token aggregation uses the shared @swarm/events accumulator so
  // the CLI's ConsoleSink.totals and the REST summary stay in lockstep.
  const totals = aggregateCost(events);
  const durationMs = deriveDurationMs(events);
  const title = deriveTitle(events);

  return {
    runId,
    ...(workflow !== undefined ? { workflow } : {}),
    ...(workflowName !== undefined ? { workflowName } : {}),
    startedAt,
    status: deriveStatus(events),
    eventCount: events.length,
    costUsd: totals.cost_usd,
    inputTokens: totals.input_tokens,
    outputTokens: totals.output_tokens,
    cacheReadTokens: totals.cache_read_tokens,
    cacheWriteTokens: totals.cache_write_tokens,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(input !== undefined ? { input } : {}),
  };
}

/** Latest-wins title pick — a retrofit script may append a second
 * `pipeline.title_generated` and we want that to become authoritative. */
export function deriveTitle(events: Event[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "pipeline.title_generated") {
      const t = (events[i]?.data as { title?: unknown }).title;
      if (typeof t === "string" && t.length > 0) return t;
    }
  }
  return undefined;
}

/**
 * Most-recent-terminal-signal-wins status derivation. Walks backwards
 * so a successful retry-after-fail still reports `"success"`.
 *
 * `pipeline.canceled` maps to `"canceled"` rather than `"fail"` — user-initiated
 * termination is a distinct outcome (no success-rate penalty, different UI
 * affordance) even though both are terminal.
 */
export function deriveStatus(events: Event[]): PipelineSummary["status"] {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.type;
    if (t === "pipeline.completed") return "success";
    if (t === "pipeline.failed") return "fail";
    if (t === "pipeline.canceled") return "canceled";
  }
  if (events.some((e) => e.type === "pipeline.started")) return "running";
  return events.length > 0 ? "running" : "unknown";
}

/**
 * Wall-clock span between the first and last event. Returns `undefined`
 * when we can't compute a meaningful value — fewer than two events, or
 * unparseable timestamps, or a non-positive span (which would indicate
 * clock skew). Pure: never reads `Date.now()`.
 */
export function deriveDurationMs(events: Event[]): number | undefined {
  if (events.length < 2) return undefined;
  const firstTs = Date.parse(events[0]?.timestamp ?? "");
  const lastTs = Date.parse(events[events.length - 1]?.timestamp ?? "");
  if (!Number.isFinite(firstTs) || !Number.isFinite(lastTs)) return undefined;
  const span = lastTs - firstTs;
  if (span < 0) return undefined;
  return span;
}

/**
 * Compute a human-readable workflow name from the `pipeline.started`
 * payload. Preference order (most specific → least):
 *
 *   1. explicit `workflow_label` — the authoring layer's choice
 *   2. basename-without-extension of `workflow_path` — e.g. "build-feature"
 *      from "/repo/workflows/build-feature.dot"
 *   3. basename-without-extension of `workflow` when it looks like a path
 *      or filename (contains `/` or ends with `.dot`)
 *   4. `graph_id` — the `digraph <id>` identifier from the DOT source
 *   5. undefined → UI renders "(unknown)"
 *
 * Raw 40-char SHAs and short hex-only identifiers are filtered out so we
 * never return a hash masquerading as a name.
 */
export function deriveWorkflowName(
  data: { workflow?: string; workflow_label?: string; workflow_path?: string; graph_id?: string },
  workflowSha: string,
): string | undefined {
  const candidates: Array<string | undefined> = [
    data.workflow_label,
    basenameWithoutExt(data.workflow_path),
    looksLikeFilename(data.workflow) ? basenameWithoutExt(data.workflow) : undefined,
    data.graph_id,
  ];
  for (const c of candidates) {
    if (c && c.length > 0 && !isLikelySha(c) && c !== workflowSha) return c;
  }
  return undefined;
}

function basenameWithoutExt(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function looksLikeFilename(s: string | undefined): boolean {
  if (!s) return false;
  return s.includes("/") || s.includes("\\") || /\.[A-Za-z0-9]{1,8}$/.test(s);
}

/** Heuristic: pure-hex of length ≥ 16 → treat as SHA, not a name. */
function isLikelySha(s: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(s);
}
