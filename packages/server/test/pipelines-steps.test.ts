// Route test for GET /pipelines/:runId/steps — Wave 5.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { createServer } from "../src/index.ts";
import { StepSnapshot } from "../src/schemas.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("GET /pipelines/:runId/steps", () => {
  test("returns an array of StepSnapshot matching the TypeBox schema", async () => {
    const runs = {
      r1: [
        ev({ type: "pipeline.started", timestamp: "2024-01-01T00:00:00.000Z", data: { workflow: "w.dot" } }),
        ev({
          type: "llm.start",
          node_id: "plan",
          timestamp: "2024-01-01T00:00:01.000Z",
          data: {
            provider: "anthropic",
            model: "claude-opus-4-7",
            prompt: "what's next?",
            system_prompt: "you are helpful",
            thread_id: "dev",
            fidelity: "full",
            allowed_tools: ["local:read_file"],
            context_files: [{ path: "AGENTS.md", sha256: "a".repeat(64), bytes: 120, truncated: false, status: "ok" }],
          },
        }),
        ev({
          type: "llm.text_delta",
          node_id: "plan",
          timestamp: "2024-01-01T00:00:01.500Z",
          data: { delta: "ok" },
        }),
        ev({
          type: "cost.recorded",
          node_id: "plan",
          timestamp: "2024-01-01T00:00:01.750Z",
          data: { cost_usd: 0.004, input_tokens: 40, output_tokens: 2, total_tokens: 42 },
        }),
        ev({ type: "llm.done", node_id: "plan", timestamp: "2024-01-01T00:00:02.000Z", data: { stop_reason: "stop" } }),
      ],
    };
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader(runs) } });
    const res = await app.request("/pipelines/r1/steps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
    const arr = body as unknown[];
    expect(arr).toHaveLength(1);
    expect(Value.Check(StepSnapshot, arr[0])).toBe(true);
    const step = arr[0] as {
      nodeId: string;
      prompt: string;
      finalText: string;
      cost?: { cost_usd: number };
      durationMs?: number;
      contextFiles: Array<{ path: string }>;
    };
    expect(step.nodeId).toBe("plan");
    expect(step.prompt).toBe("what's next?");
    expect(step.finalText).toBe("ok");
    expect(step.cost?.cost_usd).toBe(0.004);
    expect(step.durationMs).toBe(1000);
    expect(step.contextFiles[0]!.path).toBe("AGENTS.md");
  });

  test("404s on a missing run with the ErrorBody shape", async () => {
    const app = createServer({ runsDir: "/unused", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/pipelines/nope/steps");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toContain("not found");
    expect(body.code).toBe("not_found");
  });

  test("empty run → empty array (200, not 404)", async () => {
    const app = createServer({
      runsDir: "/unused",
      ports: { runReader: memoryRunReader({ empty: [] }) },
    });
    const res = await app.request("/pipelines/empty/steps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});
