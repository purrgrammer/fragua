// GET /pipelines        → list of PipelineSummary
// GET /pipelines/:runId → PipelineDetail (nodes + status derived from events)
//
// Both handlers are thin adapters over a `RunReader` port. All replay logic
// lives in `deriveSummary` / `deriveDetail` so we can property-test them in
// isolation without spinning up a Hono app.

import type { Event } from "@swarm/core";
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
  if (first) {
    const data = first.data as { workflow?: string; workflow_label?: string };
    workflow = data.workflow ?? data.workflow_label ?? first.workflow_sha;
  }
  return {
    runId,
    ...(workflow !== undefined ? { workflow } : {}),
    startedAt,
    status: deriveStatus(events),
    eventCount: events.length,
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
    startedAt: summary.startedAt,
    status: summary.status,
    lastEventSeq: events.length,
    nodes: [...nodeStateById.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
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
