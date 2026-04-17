// GET /pipelines/:runId — per-run detail with node-state replay.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { Event } from "@swarm/core";
import fc from "fast-check";
import { createServer, deriveDetail } from "../src/index.ts";
import { PipelineDetail } from "../src/schemas.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("GET /pipelines/:runId", () => {
  test("returns detail with node states and lastEventSeq", async () => {
    const runs = {
      r1: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z", data: { workflow: "w.dot" } }),
        ev({ type: "node.started", node_id: "a", timestamp: "2024-01-01T00:00:01.000Z" }),
        ev({ type: "node.completed", node_id: "a", timestamp: "2024-01-01T00:00:02.000Z" }),
        ev({ type: "node.started", node_id: "b", timestamp: "2024-01-01T00:00:03.000Z" }),
        ev({ type: "node.failed", node_id: "b", timestamp: "2024-01-01T00:00:04.000Z" }),
        ev({ type: "pipeline.failed", timestamp: "2024-01-01T00:00:05.000Z" }),
      ],
    };
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines/r1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Value.Check(PipelineDetail, body)).toBe(true);

    const detail = body as {
      status: string;
      lastEventSeq: number;
      nodes: Array<{ nodeId: string; state: string; lastEventSeq: number }>;
    };
    expect(detail.status).toBe("fail");
    expect(detail.lastEventSeq).toBe(6);
    const byId = new Map(detail.nodes.map((n) => [n.nodeId, n]));
    expect(byId.get("a")?.state).toBe("completed");
    expect(byId.get("b")?.state).toBe("failed");
  });

  test("unknown runId → 404 with ErrorBody shape", async () => {
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/pipelines/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code?: string; details?: unknown };
    expect(body.error).toBeTruthy();
    expect(body.code).toBe("not_found");
  });

  test("property: detail is a pure function of injected events", async () => {
    // For any random interleaving of node lifecycle events across a fixed
    // set of node ids, the derived detail agrees with a hand-rolled reducer.
    const eventTypes = ["node.started", "node.completed", "node.failed", "node.skipped", "node.retrying"] as const;

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            nodeId: fc.constantFrom("a", "b", "c"),
            type: fc.constantFrom(...eventTypes),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (seq) => {
          const events: Event[] = seq.map((s, i) =>
            ev({
              type: s.type,
              node_id: s.nodeId,
              timestamp: new Date(2024, 0, 1, 0, 0, i).toISOString(),
            }),
          );
          const detail = deriveDetail("rX", events);
          expect(detail.runId).toBe("rX");
          expect(detail.lastEventSeq).toBe(events.length);

          // Hand-rolled expected: last type per node determines state.
          const expected: Record<string, string> = {};
          const expectedSeq: Record<string, number> = {};
          events.forEach((e, i) => {
            if (!e.node_id) return;
            const map: Record<string, string> = {
              "node.started": "running",
              "node.completed": "completed",
              "node.failed": "failed",
              "node.skipped": "skipped",
              "node.retrying": "retrying",
            };
            expected[e.node_id] = map[e.type] ?? expected[e.node_id] ?? "pending";
            expectedSeq[e.node_id] = i + 1;
          });
          for (const node of detail.nodes) {
            expect(node.state).toBe(expected[node.nodeId] as typeof node.state);
            expect(node.lastEventSeq).toBe(expectedSeq[node.nodeId] ?? 0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
