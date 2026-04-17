// GET /pipelines/:runId/events — Server-Sent Events tail of a run's JSONL.
//
// Route lives under `/pipelines/**` (not the earlier `/api/runs/**`) so the
// web client can reach it through the same `/api` → root Vite proxy used
// by every other pipeline endpoint. The `runId` path param matches the
// naming used by sibling routes (`/pipelines/:runId`, `/pipelines/:runId/graph.svg`).
//
// Contract:
//   - Each line of `<runsDir>/<runId>/events.jsonl` is emitted as one SSE frame:
//       event: <event.type>
//       id:    <sequence number, 1-based>
//       data:  <JSON of the Event>
//   - Pre-existing lines replay first (in order), then appended lines stream
//     live until the client disconnects or the file stops changing.
//   - `Last-Event-ID` (if numeric) skips the first N events on reconnect so
//     resume is exact. Anything non-numeric is ignored.
//   - Missing run → 404 JSON, not an SSE frame. We only enter SSE mode once
//     the file exists, so broken subscribers fail fast.
//
// We deliberately do NOT do long-polling, compression, or auth here — those
// belong to later tasks (and this package is a single-user local tool).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { tailJsonl } from "@swarm/events";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface EventsRouteOptions {
  /** Directory containing `<runId>/events.jsonl` per run. */
  runsDir: string;
}

export function eventsRoutes(opts: EventsRouteOptions): Hono {
  const app = new Hono();

  app.get("/pipelines/:runId/events", (c) => {
    const runId = c.req.param("runId");
    const filePath = join(opts.runsDir, runId, "events.jsonl");

    if (!existsSync(filePath)) {
      return c.json({ error: "run not found", runId }, 404);
    }

    // Parse resume hint. SSE sends Last-Event-ID as a string; we used 1-based
    // sequence numbers as ids, so a valid value means "skip the first N".
    const lastIdHeader = c.req.header("Last-Event-ID");
    const skip = parseSkip(lastIdHeader);

    return streamSSE(c, async (stream) => {
      // Abort the tail iterator when the client disconnects. Hono exposes
      // stream.onAbort for this; we forward it to our AbortController.
      const ac = new AbortController();
      stream.onAbort(() => ac.abort());

      let seq = 0;
      for await (const event of tailJsonl(filePath, { signal: ac.signal })) {
        seq += 1;
        if (seq <= skip) continue;
        await stream.writeSSE({
          id: String(seq),
          event: event.type,
          data: JSON.stringify(event),
        });
      }
    });
  });

  return app;
}

function parseSkip(header: string | undefined): number {
  if (!header) return 0;
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
