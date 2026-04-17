// GET /pipelines/:runId/graph.svg — render the run's workflow DOT to SVG.
//
// DOT source is reconstructed from the first `pipeline.started` event, which
// carries `data.workflow_source` (the raw DOT). We don't re-parse here —
// Graphviz (via the injected renderer) handles that. If the source is
// missing (older runs, partial writes), we 404 rather than guess.
//
// The renderer is behind a port so tests can inject a deterministic stub and
// exercise error paths without wrestling a wasm module.

import type { Event } from "@swarm/core";
import { Hono } from "hono";
import type { GraphRenderer, RunReader } from "../ports.ts";

export interface GraphRouteOptions {
  runReader: RunReader;
  graphRenderer: GraphRenderer;
}

export function graphRoutes(opts: GraphRouteOptions): Hono {
  const app = new Hono();

  app.get("/pipelines/:runId/graph.svg", async (c) => {
    const runId = c.req.param("runId");
    const events = await opts.runReader.readEvents(runId);
    if (!events) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }

    const source = extractDotSource(events);
    if (!source) {
      return c.json(
        {
          error: "workflow source not recorded for this run",
          code: "source_missing",
          details: { runId },
        },
        404,
      );
    }

    let svg: string;
    try {
      svg = await opts.graphRenderer.render(source);
    } catch (err) {
      // Never leak stack traces or raw Graphviz errors — they sometimes
      // contain absolute paths from the wasm bootstrap. One line is plenty.
      // Strip everything after the first newline and redact absolute paths so
      // a wasm stack trace never leaks into the response.
      const raw = err instanceof Error ? err.message : "graph render failed";
      const firstLine = raw.split(/\r?\n/)[0] ?? "graph render failed";
      const message = firstLine.replace(/\/[^\s]+/g, "<path>").slice(0, 200);
      return c.json({ error: "graph render failed", code: "render_error", details: { message } }, 500);
    }

    return c.body(svg, 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      // Short cache: re-renders are cheap but SVGs shouldn't be stale while
      // the graph colour-codes by live state.
      "cache-control": "no-cache",
    });
  });

  return app;
}

function extractDotSource(events: Event[]): string | undefined {
  for (const ev of events) {
    if (ev.type !== "pipeline.started") continue;
    const src = (ev.data as { workflow_source?: unknown }).workflow_source;
    if (typeof src === "string" && src.length > 0) return src;
  }
  return undefined;
}
