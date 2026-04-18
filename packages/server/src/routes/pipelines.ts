// GET /pipelines        → list of PipelineSummary
// GET /pipelines/:runId → PipelineDetail (node state replay + raw DOT source)
//
// Both handlers are thin adapters over a `RunReader` port. All replay logic
// lives in `deriveSummary` / `deriveDetail` so we can property-test them in
// isolation without spinning up a Hono app.
//
// On edges / graph topology:
//   We do NOT parse DOT server-side. `deriveDetail` surfaces the raw
//   `workflow_source` string on the first `pipeline.started` event (when
//   present) so the web UI can call `@swarm/core`'s `parseDotSource` and
//   get the full topology in-process. Keeping the parser out of the
//   server boundary means one parse path, one set of semantics, zero
//   risk of drift between "what the runtime sees" and "what the UI shows".
//
// Reducer placement: the pure helpers (`deriveSummary`, `deriveStatus`,
// `deriveWorkflowName`, …) used to live here. They moved to
// `../lib/summary.ts` when /stats was added so both routes consume the
// same definitions without importing each other. We keep
// `deriveSummary` re-exported below — `index.ts` and a few external
// callers depend on the old import path.

import type { Event } from "@swarm/core";
import { foldAll, type Projection, projectRun } from "@swarm/events";
import { Hono } from "hono";
import { stepsProjection } from "../lib/steps.ts";
import { deriveSummary, summaryProjection } from "../lib/summary.ts";
import { type RunReader, sourceFromRunReader } from "../ports.ts";
import type { NodeState, PipelineDetail, PipelineSummary } from "../schemas.ts";

export interface PipelinesRouteOptions {
  runReader: RunReader;
}

export function pipelinesRoutes(opts: PipelinesRouteOptions): Hono {
  const app = new Hono();

  app.get("/pipelines", async (c) => {
    // Fold the `summaryProjection` (runId-agnostic) across every run and
    // stitch the runId on inside the folder. Equivalent to the old
    // manual loop but reads against the common abstraction — same
    // numbers, same ordering, one less place the reducer logic lives.
    const source = sourceFromRunReader(opts.runReader);
    const summaries = await foldAll<Omit<PipelineSummary, "runId">, PipelineSummary[]>(
      source,
      summaryProjection,
      (acc, partial, runId) => {
        acc.push({ runId, ...partial } as PipelineSummary);
        return acc;
      },
      [],
    );
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
    // projectRun collapses the readEvents → 404 check → project triple
    // into one call; the route is now literally "not found or here's
    // the projection result".
    const detail = await projectRun(sourceFromRunReader(opts.runReader), runId, (events) =>
      deriveDetail(runId, events as Event[]),
    );
    if (detail === undefined) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json(detail);
  });

  // Bulk historical events — companion to the SSE stream at the same
  // /pipelines/:runId/events path. The `.jsonl` extension differentiates by
  // content-type: the SSE route handles `GET /events` with
  // `text/event-stream`, this one returns the full array as JSON. The UI
  // calls it once on mount to bootstrap the conversation reducer, then
  // resumes from `lastSeq` via SSE — avoids keeping a 23K-event ring
  // buffer in the browser for long runs.
  //
  // Shape: `{ events: Event[], lastSeq: number }`. `lastSeq` is the 1-based
  // sequence id of the final event (matches the SSE `id:` frames), suitable
  // for passing as `Last-Event-ID` to the stream endpoint.
  app.get("/pipelines/:runId/events.json", async (c) => {
    const runId = c.req.param("runId");
    const events = await opts.runReader.readEvents(runId);
    if (!events) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json({ events, lastSeq: events.length });
  });

  // Wave 5 — per-step introspection. One StepSnapshot per llm.start,
  // reconstructed server-side so clients never have to replay the
  // raw stream to inspect "what did the agent see at step N". The
  // reducer is exposed as a Projection so a future DB-backed
  // MaterializedProjectionStore can cache it under STEPS_PROJECTION_KEY.
  app.get("/pipelines/:runId/steps", async (c) => {
    const runId = c.req.param("runId");
    const events = await opts.runReader.readEvents(runId);
    if (!events) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json(await stepsProjection(events));
  });

  return app;
}

/** Stable projection key for future `MaterializedProjectionStore`
 * adapters. Matches `stepsProjection`'s `STEPS_PROJECTION_KEY` shape. */
export const DETAIL_PROJECTION_KEY = "detail";

/** `deriveDetail` as a runId-aware `Projection`. Factory form — the
 * caller binds runId because `deriveDetail` needs it to populate the
 * envelope; foldAll-style consumers should inject it per-run via the
 * folder. */
export function detailProjection(runId: string): Projection<PipelineDetail> {
  return (events) => deriveDetail(runId, events as Event[]);
}

/**
 * Pure reducer over events → detail (nodes + status + raw DOT source).
 *
 * We deliberately do NOT try to parse the DOT here — we copy it through
 * unchanged so the browser can call `@swarm/core`'s `parseDotSource` and
 * reuse the same parser the runtime uses. That keeps one parser in one
 * place; the server only ever has to worry about event replay.
 */
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

  const workflowSource = extractDotSource(events);

  return {
    runId,
    ...(summary.workflow !== undefined ? { workflow: summary.workflow } : {}),
    ...(summary.workflowName !== undefined ? { workflowName: summary.workflowName } : {}),
    startedAt: summary.startedAt,
    status: summary.status,
    lastEventSeq: events.length,
    nodes: [...nodeStateById.values()].sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1)),
    ...(workflowSource !== undefined ? { workflowSource } : {}),
    costUsd: summary.costUsd,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    ...(summary.title !== undefined ? { title: summary.title } : {}),
    ...(summary.input !== undefined ? { input: summary.input } : {}),
  };
}

/**
 * Pull the raw DOT source off the earliest `pipeline.started` event.
 * Older runs may not have recorded it — callers treat `undefined` as
 * "no graph available" and render an empty state.
 */
function extractDotSource(events: Event[]): string | undefined {
  for (const ev of events) {
    if (ev.type !== "pipeline.started") continue;
    const src = (ev.data as { workflow_source?: unknown }).workflow_source;
    if (typeof src === "string" && src.length > 0) return src;
  }
  return undefined;
}

// Re-exports for back-compat with callers that imported helpers from
// this module before the move to ../lib/summary.ts (notably `index.ts`,
// which keeps `deriveSummary` in its public surface).
export { deriveStatus, deriveSummary, deriveWorkflowName } from "../lib/summary.ts";
