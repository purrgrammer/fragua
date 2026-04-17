// GET /pipelines        → list of PipelineSummary
// GET /pipelines/:runId → PipelineDetail (nodes + status derived from events)
//
// Both handlers are thin adapters over a `RunReader` port. All replay logic
// lives in `deriveSummary` / `deriveDetail` so we can property-test them in
// isolation without spinning up a Hono app.

import type { Event } from "@swarm/core";
import { aggregateCost } from "@swarm/events";
import { Hono } from "hono";
import type { RunReader } from "../ports.ts";
import type { NodeState, PipelineDetail, PipelineSummary } from "../schemas.ts";

export interface PipelinesRouteOptions {
  runReader: RunReader;
}

export function pipelinesRoutes(opts: PipelinesRouteOptions): Hono {
  const app = new Hono();

  app.get("/pipelines", async (c) => {
    const ids = await opts.runReader.listRuns();
    const summaries: PipelineSummary[] = [];
    for (const runId of ids) {
      const events = await opts.runReader.readEvents(runId);
      // `listRuns` and `readEvents` can disagree under a racing cleanup; skip
      // torn entries rather than 500ing the whole list.
      if (!events) continue;
      summaries.push(deriveSummary(runId, events));
    }
    // Newest-first ordering: by startedAt desc. Falls back to runId compare
    // so tests see a stable ordering even when timestamps collide.
    summaries.sort((a, b) => {
      if (a.startedAt === b.startedAt) return a.runId < b.runId ? 1 : -1;
      return a.startedAt < b.startedAt ? 1 : -1;
    });
    return c.json(summaries);
  });

  app.get("/pipelines/:runId", async (c) => {
    const runId = c.req.param("runId");
    const events = await opts.runReader.readEvents(runId);
    if (!events) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json(deriveDetail(runId, events));
  });

  return app;
}

/** Pure reducer over events → summary. Exported for tests and reuse. */
export function deriveSummary(runId: string, events: Event[]): PipelineSummary {
  const first = events[0];
  const startedAt = first?.timestamp ?? new Date(0).toISOString();
  let workflow: string | undefined;
  let workflowName: string | undefined;
  if (first) {
    const data = first.data as {
      workflow?: string;
      workflow_label?: string;
      workflow_path?: string;
      graph_id?: string;
    };
    workflow = data.workflow ?? data.workflow_label ?? first.workflow_sha;
    workflowName = deriveWorkflowName(data, first.workflow_sha);
  }
  // Cost/token aggregation uses the shared @swarm/events accumulator so
  // the CLI's ConsoleSink.totals and the REST summary stay in lockstep.
  const totals = aggregateCost(events);
  const durationMs = deriveDurationMs(events);

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
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Pure reducer over events → detail (nodes + status). */
export function deriveDetail(runId: string, events: Event[]): PipelineDetail {
  const summary = deriveSummary(runId, events);
  const nodeStateById = new Map<string, NodeState>();
  events.forEach((ev, idx) => {
    const seq = idx + 1;
    if (!ev.node_id) return;
    const prev = nodeStateById.get(ev.node_id);
    const next: NodeState = prev
      ? { ...prev, lastEventSeq: seq }
      : { nodeId: ev.node_id, state: "pending", lastEventSeq: seq };
    switch (ev.type) {
      case "node.started":
        next.state = "running";
        break;
      case "node.completed":
        next.state = "completed";
        break;
      case "node.failed":
        next.state = "failed";
        break;
      case "node.skipped":
        next.state = "skipped";
        break;
      case "node.retrying":
        next.state = "retrying";
        break;
      default:
        // Non-lifecycle node event: keep current state but bump seq.
        break;
    }
    nodeStateById.set(ev.node_id, next);
  });

  return {
    runId,
    ...(summary.workflow !== undefined ? { workflow: summary.workflow } : {}),
    ...(summary.workflowName !== undefined ? { workflowName: summary.workflowName } : {}),
    startedAt: summary.startedAt,
    status: summary.status,
    lastEventSeq: events.length,
    nodes: [...nodeStateById.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
    costUsd: summary.costUsd,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
  };
}

function deriveStatus(events: Event[]): PipelineSummary["status"] {
  // Walk from the end: the most recent terminal signal wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.type;
    if (t === "pipeline.completed") return "success";
    if (t === "pipeline.failed") return "fail";
  }
  if (events.some((e) => e.type === "pipeline.started")) return "running";
  return events.length > 0 ? "running" : "unknown";
}

/**
 * Wall-clock span between the first and last event. Returns `undefined`
 * when we can't compute a meaningful value — fewer than two events, or
 * unparseable timestamps, or a non-positive span (which would indicate
 * clock skew). Running runs get the "elapsed so far" reading; terminal
 * runs get the full span. Callers that want "now − start" for a live
 * run can compute it themselves from `startedAt` — we deliberately keep
 * this reducer pure (no `Date.now()` dependency) so server tests don't
 * need a clock fixture.
 */
function deriveDurationMs(events: Event[]): number | undefined {
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
function deriveWorkflowName(
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
