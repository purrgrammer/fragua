// GET /pipelines — list summaries derived from each run's event stream.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { createServer } from "../src/index.ts";
import { PipelineSummary } from "../src/schemas.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("GET /pipelines", () => {
  test("returns 200 and [] for an empty runs directory", async () => {
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/pipelines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(0);
  });

  test("summaries pass TypeBox validation and include derived status", async () => {
    const runs = {
      alpha: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z", data: { workflow: "hello.dot" } }),
        ev({ type: "node.started", node_id: "s", timestamp: "2024-01-01T00:00:01.000Z" }),
        ev({ type: "pipeline.completed", timestamp: "2024-01-01T00:00:02.000Z" }),
      ],
      beta: [
        ev({ type: "pipeline.started", timestamp: "2024-01-02T00:00:00.000Z", data: { workflow: "build.dot" } }),
        ev({ type: "pipeline.failed", timestamp: "2024-01-02T00:00:03.000Z" }),
      ],
      gamma: [ev({ type: "pipeline.started", timestamp: "2024-01-03T00:00:00.000Z", data: { workflow: "x.dot" } })],
      delta: [
        ev({ type: "pipeline.started", timestamp: "2024-01-04T00:00:00.000Z", data: { workflow: "cancelme.dot" } }),
        ev({ type: "pipeline.canceled", timestamp: "2024-01-04T00:00:02.000Z" }),
      ],
    };

    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];

    expect(body.length).toBe(4);
    for (const row of body) {
      expect(Value.Check(PipelineSummary, row)).toBe(true);
    }

    const byId = new Map(body.map((row) => [(row as { runId: string }).runId, row as Record<string, unknown>]));
    expect(byId.get("alpha")?.["status"]).toBe("success");
    expect(byId.get("beta")?.["status"]).toBe("fail");
    expect(byId.get("gamma")?.["status"]).toBe("running");
    expect(byId.get("delta")?.["status"]).toBe("canceled");
    expect(byId.get("alpha")?.["workflow"]).toBe("hello.dot");
    expect(byId.get("alpha")?.["eventCount"]).toBe(3);
  });

  test("sort order is newest-first by startedAt", async () => {
    const runs = {
      old: [ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" })],
      mid: [ev({ type: "pipeline.started", timestamp: "2024-02-01T00:00:00.000Z" })],
      new: [ev({ type: "pipeline.started", timestamp: "2024-03-01T00:00:00.000Z" })],
    };
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines");
    const body = (await res.json()) as Array<{ runId: string }>;
    expect(body.map((r) => r.runId)).toEqual(["new", "mid", "old"]);
  });

  test("skips torn runs whose events cannot be read", async () => {
    // listRuns returns ids that readEvents then reports as undefined
    // (race with cleanup). The list handler must not 500.
    const app = createServer({
      runsDir: "/unused",
      ports: {
        runReader: {
          async listRuns() {
            return ["good", "torn"];
          },
          async readEvents(id: string) {
            if (id === "torn") return undefined;
            return [ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z" })];
          },
        },
      },
    });
    const res = await app.request("/pipelines");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ runId: string }>;
    expect(body.map((r) => r.runId)).toEqual(["good"]);
  });
});
