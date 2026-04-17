// POST /pipelines/:runId/interview/:questionId — submit an answer.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { createServer } from "../src/index.ts";
import { ev, memoryRunReader, RecordingSink } from "./helpers.ts";

function makeApp(extraEvents: Event[] = []) {
  const sink = new RecordingSink();
  const runs = {
    r1: [
      ev({ type: "pipeline.started", data: {}, workflow_sha: "sha-abc" }),
      ev({
        type: "interview.started",
        node_id: "n1",
        timestamp: "2024-01-01T00:00:01.000Z",
        workflow_sha: "sha-abc",
        data: { question_id: "q1", text: "Proceed?", type: "YES_NO", stage: "review" },
      }),
      ...extraEvents,
    ],
  };
  const app = createServer({
    runsDir: "/unused",
    ports: { runReader: memoryRunReader(runs), eventSink: sink },
  });
  return { app, sink };
}

describe("POST /pipelines/:runId/interview/:questionId", () => {
  test("valid body → 202 and emits interview.completed", async () => {
    const { app, sink } = makeApp();
    const res = await app.request("/pipelines/r1/interview/q1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "YES", text: "sure" }),
    });
    expect(res.status).toBe(202);
    expect(sink.events.length).toBe(1);
    const emitted = sink.events[0]!;
    expect(emitted.type).toBe("interview.completed");
    expect(emitted.run_id).toBe("r1");
    expect(emitted.node_id).toBe("n1");
    expect(emitted.workflow_sha).toBe("sha-abc");
    expect(emitted.data).toMatchObject({
      question_id: "q1",
      value: "YES",
      text: "sure",
      source: "web",
    });
  });

  test("invalid body (schema fail) → 400, no event emitted", async () => {
    const { app, sink } = makeApp();
    const res = await app.request("/pipelines/r1/interview/q1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "" }),
    });
    expect(res.status).toBe(400);
    expect(sink.events.length).toBe(0);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("bad_request");
  });

  test("non-JSON body → 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/pipelines/r1/interview/q1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("unknown question → 404", async () => {
    const { app, sink } = makeApp();
    const res = await app.request("/pipelines/r1/interview/ghost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "YES" }),
    });
    expect(res.status).toBe(404);
    expect(sink.events.length).toBe(0);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown_question");
  });

  test("double-answer → 409 and no duplicate event emitted", async () => {
    const { app, sink } = makeApp([
      ev({
        type: "interview.completed",
        node_id: "n1",
        data: { question_id: "q1", value: "YES" },
      }),
    ]);
    const res = await app.request("/pipelines/r1/interview/q1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "NO" }),
    });
    expect(res.status).toBe(409);
    expect(sink.events.length).toBe(0);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("already_answered");
  });
});
