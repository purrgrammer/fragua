// POST /pipelines/:runId/{steer,pause,resume,cancel} — control channel.
//
// The routes are thin wrappers over a `ControlGateway` port. Tests inject
// a memory-backed gateway so they verify exactly one thing: the HTTP
// contract (body validation, status codes, error envelopes). Filesystem
// behavior is covered separately by the executor's own control tests.

import { describe, expect, test } from "bun:test";
import { createServer } from "../src/index.ts";
import type { ControlGateway, ControlSubmitResult } from "../src/ports.ts";
import { ev, memoryRunReader } from "./helpers.ts";

interface RecordedCall {
  command: "steer" | "pause" | "resume" | "cancel";
  runId: string;
  arg?: string;
}

function memoryControlGateway(): ControlGateway & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let nextId = 0;
  const ok = (): ControlSubmitResult => ({ ok: true, id: `gen-${++nextId}` });
  const missing = (runId: string, seen: Record<string, unknown>): ControlSubmitResult | undefined =>
    runId in seen ? undefined : { ok: false, code: "not_found" };

  // Minimal run registry so 404 tests exercise the same predicate
  // as the production fs adapter (gateway checks existence itself).
  const seen = { r1: true };

  return {
    calls,
    async steer(runId, message) {
      const miss = missing(runId, seen);
      if (miss) return miss;
      calls.push({ command: "steer", runId, arg: message });
      return ok();
    },
    async pause(runId, reason) {
      const miss = missing(runId, seen);
      if (miss) return miss;
      calls.push({ command: "pause", runId, ...(reason !== undefined ? { arg: reason } : {}) });
      return ok();
    },
    async resume(runId) {
      const miss = missing(runId, seen);
      if (miss) return miss;
      calls.push({ command: "resume", runId });
      return ok();
    },
    async cancel(runId, reason) {
      const miss = missing(runId, seen);
      if (miss) return miss;
      calls.push({ command: "cancel", runId, ...(reason !== undefined ? { arg: reason } : {}) });
      return ok();
    },
  };
}

function makeApp() {
  const gateway = memoryControlGateway();
  const app = createServer({
    runsDir: "/unused",
    ports: {
      // RunReader used by other routes (e.g. /pipelines). The gateway
      // does its own existence check so this only needs to be present.
      runReader: memoryRunReader({ r1: [ev({ type: "pipeline.started" })] }),
      controlGateway: gateway,
    },
  });
  return { app, gateway };
}

describe("POST /pipelines/:runId/steer", () => {
  test("valid body → 202 with { id } and a recorded gateway call", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "focus on tests" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe("string");
    expect(gateway.calls).toEqual([{ command: "steer", runId: "r1", arg: "focus on tests" }]);
  });

  test("empty message → 400", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
    expect(gateway.calls.length).toBe(0);
  });

  test("non-JSON body → 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/pipelines/r1/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("unknown run → 404", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/ghost/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(404);
    expect(gateway.calls.length).toBe(0);
  });
});

describe("POST /pipelines/:runId/pause", () => {
  test("empty body accepted as {} → 202; gateway called with no reason", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/pause", { method: "POST" });
    expect(res.status).toBe(202);
    expect(gateway.calls).toEqual([{ command: "pause", runId: "r1" }]);
  });

  test("reason passed through", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "stepping away" }),
    });
    expect(res.status).toBe(202);
    expect(gateway.calls).toEqual([{ command: "pause", runId: "r1", arg: "stepping away" }]);
  });

  test("unknown run → 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/pipelines/ghost/pause", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /pipelines/:runId/resume", () => {
  test("no body → 202", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/resume", { method: "POST" });
    expect(res.status).toBe(202);
    expect(gateway.calls).toEqual([{ command: "resume", runId: "r1" }]);
  });

  test("unknown run → 404", async () => {
    const { app } = makeApp();
    const res = await app.request("/pipelines/ghost/resume", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("POST /pipelines/:runId/cancel", () => {
  test("empty body → 202", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/cancel", { method: "POST" });
    expect(res.status).toBe(202);
    expect(gateway.calls).toEqual([{ command: "cancel", runId: "r1" }]);
  });

  test("reason passed through", async () => {
    const { app, gateway } = makeApp();
    const res = await app.request("/pipelines/r1/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "wrong branch" }),
    });
    expect(res.status).toBe(202);
    expect(gateway.calls).toEqual([{ command: "cancel", runId: "r1", arg: "wrong branch" }]);
  });
});
