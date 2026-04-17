// GET /pipelines/:runId/interview — lists pending questions derived from
// interview.started / .completed events in the run's JSONL.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { createServer } from "../src/index.ts";
import { InterviewQuestion } from "../src/schemas.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("GET /pipelines/:runId/interview", () => {
  test("returns pending questions and filters out already-answered", async () => {
    const runs = {
      r1: [
        ev({ type: "pipeline.started", data: { workflow: "w.dot" } }),
        ev({
          type: "interview.started",
          node_id: "n1",
          timestamp: "2024-01-01T00:00:01.000Z",
          data: {
            question_id: "q1",
            text: "Proceed?",
            type: "YES_NO",
            stage: "review",
          },
        }),
        ev({
          type: "interview.started",
          node_id: "n2",
          timestamp: "2024-01-01T00:00:02.000Z",
          data: {
            question_id: "q2",
            text: "Which path?",
            type: "MULTIPLE_CHOICE",
            options: [
              { key: "A", label: "Alpha" },
              { key: "B", label: "Beta" },
            ],
            stage: "plan",
          },
        }),
        ev({
          type: "interview.completed",
          node_id: "n1",
          data: { question_id: "q1", value: "YES" },
        }),
      ],
    };

    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines/r1/interview");
    expect(res.status).toBe(200);

    const body = (await res.json()) as unknown[];
    for (const row of body) {
      expect(Value.Check(InterviewQuestion, row)).toBe(true);
    }
    const ids = body.map((q) => (q as { questionId: string }).questionId);
    expect(ids).toEqual(["q2"]);

    const q2 = body[0] as { options?: unknown[]; type: string; nodeId: string };
    expect(q2.type).toBe("MULTIPLE_CHOICE");
    expect(q2.nodeId).toBe("n2");
    expect(q2.options).toEqual([
      { key: "A", label: "Alpha" },
      { key: "B", label: "Beta" },
    ]);
  });

  test("unknown run → 404", async () => {
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/pipelines/ghost/interview");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("run with no interview events → empty list, not 404", async () => {
    const runs = {
      r1: [ev({ type: "pipeline.started", data: {} })],
    };
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines/r1/interview");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
