// The same-origin gate: a browser page on another origin must not be able to
// drive the control plane. These tests exercise the gate through `createServer`
// (the only place it is mounted), seeding a real run so an accepted intent
// would actually land — proving a refused request writes nothing.

import { describe, expect, test } from "bun:test";
import type { SqliteStore } from "@fragua/store";
import { createServer } from "../src/index.ts";
import { freshStore, gatedRequest } from "./helpers.ts";

const BOUND = { host: "127.0.0.1", port: 6767 };
const SAME_ORIGIN = "http://127.0.0.1:6767";

const TOOL_WORKFLOW = `name: gate-test
steps:
  a:
    type: tool
    run: echo x
    next: exit
  exit:
    type: exit
`;

function mount(): { app: ReturnType<typeof createServer>; store: SqliteStore } {
  const store = freshStore();
  const app = createServer({ store, boundOrigin: () => BOUND });
  return { app, store };
}

/** Save the tool workflow + enqueue a run through the same-origin path so a
 * later `/cancel` has a real target (getState non-null). Returns its run id. */
async function seedRun(app: ReturnType<typeof createServer>): Promise<string> {
  const saved = await gatedRequest(app, "/workflows", {
    method: "POST",
    headers: { origin: SAME_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "gate-test", source: TOOL_WORKFLOW }),
  });
  expect(saved.status).toBe(200);
  const { sha } = (await saved.json()) as { sha: string };
  const enq = await gatedRequest(app, "/runs", {
    method: "POST",
    headers: { origin: SAME_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ workflowSha: sha, cwd: "/tmp/gate-test" }),
  });
  expect(enq.status).toBe(200);
  const { runId } = (await enq.json()) as { runId: string };
  return runId;
}

function hasCancelIntent(store: SqliteStore, runId: string): boolean {
  return store.getEvents(runId).some((e) => e.type === "intent.cancel_requested");
}

describe("same-origin gate", () => {
  test("text/plain cross-origin POST to /runs/:id/cancel is refused and writes no intent", async () => {
    const { app, store } = mount();
    const runId = await seedRun(app);
    const res = await gatedRequest(app, `/runs/${runId}/cancel`, {
      method: "POST",
      headers: { origin: "http://evil.example", "content-type": "text/plain" },
      body: "{}",
    });
    expect([403, 415]).toContain(res.status);
    expect(hasCancelIntent(store, runId)).toBe(false);
    store.close();
  });

  test("same-origin JSON POST to /runs/:id/cancel is accepted and writes the intent", async () => {
    const { app, store } = mount();
    const runId = await seedRun(app);
    const res = await gatedRequest(app, `/runs/${runId}/cancel`, {
      method: "POST",
      headers: { origin: SAME_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ reason: "obsolete" }),
    });
    expect(res.status).toBe(200);
    expect(hasCancelIntent(store, runId)).toBe(true);
    store.close();
  });

  test("POST with a foreign Host is refused with code forbidden_host", async () => {
    const { app, store } = mount();
    const runId = await seedRun(app);
    const res = await gatedRequest(app, `/runs/${runId}/cancel`, {
      method: "POST",
      host: "attacker.example",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("forbidden_host");
    expect(hasCancelIntent(store, runId)).toBe(false);
    store.close();
  });

  test("SSE GET /runs/:id/stream with a foreign Origin is refused with code forbidden_origin", async () => {
    const { app, store } = mount();
    const runId = await seedRun(app);
    const res = await gatedRequest(app, `/runs/${runId}/stream`, {
      headers: { origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("forbidden_origin");
    store.close();
  });

  test("loopback Host with no Origin passes the gate", async () => {
    const { app, store } = mount();
    const res = await gatedRequest(app, "/health", { host: "localhost" });
    expect(res.status).toBe(200);
    store.close();
  });

  test("JSON body sent as text/plain is rejected fail-closed (readJson defence)", async () => {
    const { app, store } = mount();
    const runId = await seedRun(app);
    const res = await gatedRequest(app, `/runs/${runId}/cancel`, {
      method: "POST",
      headers: { origin: SAME_ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ reason: "obsolete" }),
    });
    expect([400, 415]).toContain(res.status);
    expect(hasCancelIntent(store, runId)).toBe(false);
    store.close();
  });
});
