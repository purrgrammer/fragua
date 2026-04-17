// GET /pipelines/:runId/graph.svg — DOT → SVG rendered via injected port.

import { describe, expect, test } from "bun:test";
import { createServer } from "../src/index.ts";
import type { GraphRenderer } from "../src/ports.ts";
import { ev, memoryRunReader } from "./helpers.ts";

const STUB_SVG = `<svg xmlns="http://www.w3.org/2000/svg"><g><text>stub</text></g></svg>`;

const stubRenderer: GraphRenderer = {
  async render(dot: string): Promise<string> {
    if (!dot.includes("digraph")) throw new Error("stub expected digraph source");
    return STUB_SVG;
  },
};

describe("GET /pipelines/:runId/graph.svg", () => {
  const dot = `digraph { s [shape=Mdiamond]; s -> done; done [shape=Msquare]; }`;
  const goodRuns = {
    r1: [
      ev({ type: "pipeline.started", data: { workflow_source: dot, workflow: "w.dot" } }),
      ev({ type: "pipeline.completed" }),
    ],
  };

  test("returns SVG with image/svg+xml content-type", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { runReader: memoryRunReader(goodRuns), graphRenderer: stubRenderer },
    });
    const res = await app.request("/pipelines/r1/graph.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
  });

  test("renderer error → 500 with ErrorBody, no stack trace leak", async () => {
    const throwing: GraphRenderer = {
      async render(): Promise<string> {
        throw new Error("boom\n  at /absolute/path/to/viz.wasm:42");
      },
    };
    const app = createServer({
      runsDir: "/unused",
      ports: { runReader: memoryRunReader(goodRuns), graphRenderer: throwing },
    });
    const res = await app.request("/pipelines/r1/graph.svg");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code?: string; details?: unknown };
    expect(body.error).toBe("graph render failed");
    expect(body.code).toBe("render_error");
    // The message in details is a single line; the handler must not serialize
    // a multi-line stack trace into the response body.
    expect(JSON.stringify(body)).not.toContain("viz.wasm:42");
  });

  test("unknown run → 404", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { runReader: memoryRunReader({}), graphRenderer: stubRenderer },
    });
    const res = await app.request("/pipelines/nope/graph.svg");
    expect(res.status).toBe(404);
  });

  test("missing workflow_source → 404 source_missing", async () => {
    const noSource = {
      r1: [ev({ type: "pipeline.started", data: {} })],
    };
    const app = createServer({
      runsDir: "/unused",
      ports: { runReader: memoryRunReader(noSource), graphRenderer: stubRenderer },
    });
    const res = await app.request("/pipelines/r1/graph.svg");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("source_missing");
  });
});
