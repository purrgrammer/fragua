// HTTP tests for POST/GET/DELETE `/jobs`. Drives the routes against
// an in-memory SQLite queue so the full path — body validation, queue
// interaction, error envelopes — is exercised end-to-end without a
// spawned daemon.
//
// DELETE of running jobs is a phase 5 feature; this suite only asserts
// the 501 stub for now so we notice if the stub is accidentally removed
// before the cancel forwarding lands.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@swarm/core";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";
import { createServer } from "../src/index.ts";
import type { JobQueue } from "../src/ports.ts";
import { ev, memoryRunReader } from "./helpers.ts";

describe("POST /jobs", () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await queue.close();
  });

  function mountWithQueue() {
    return createServer({
      runsDir: "/tmp/does-not-matter",
      ports: { jobQueue: queue, runReader: memoryRunReader({}) },
    });
  }

  test("accepts a valid body → 202 with jobId + runId", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "workflows/build.dot", input: "hi" }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; runId: string };
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body.runId).toMatch(/^\d+-[a-z0-9]{6}$/);
    // Row is persisted.
    const row = await queue.get(body.jobId);
    expect(row?.workflow).toBe("workflows/build.dot");
    expect(row?.inputJson).toBe("hi");
    expect(row?.status).toBe("queued");
  });

  test("missing workflow → 400", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  test("invalid JSON → 400", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("duplicate client-supplied id → 409", async () => {
    const app = mountWithQueue();
    const body = { id: "dup", workflow: "w.dot" };
    const first = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(202);
    const second = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(409);
  });

  test("honours priority and runId overrides", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "w.dot", priority: 7, runId: "custom-run" }),
    });
    expect(res.status).toBe(202);
    const { jobId, runId } = (await res.json()) as { jobId: string; runId: string };
    expect(runId).toBe("custom-run");
    const row = await queue.get(jobId);
    expect(row?.priority).toBe(7);
    expect(row?.runId).toBe("custom-run");
  });

  test("resolves bare workflow names via the WorkflowReader", async () => {
    const app = createServer({
      runsDir: "/tmp/does-not-matter",
      ports: {
        jobQueue: queue,
        runReader: memoryRunReader({}),
        workflowReader: {
          async list() {
            return [
              { name: "build-feature", path: "/repo/workflows/build-feature.dot", sha: "abc1234" },
              { name: "fix-bug", path: "/repo/workflows/fix-bug.dot", sha: "def5678" },
            ];
          },
          async read() {
            return undefined;
          },
        },
      },
    });
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "build-feature", input: "ship it" }),
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const row = await queue.get(jobId);
    // Persisted workflow is the resolved absolute path, not the bare name.
    expect(row?.workflow).toBe("/repo/workflows/build-feature.dot");
  });

  test("bare name that doesn't match any workflow → 404", async () => {
    const app = createServer({
      runsDir: "/tmp/does-not-matter",
      ports: {
        jobQueue: queue,
        runReader: memoryRunReader({}),
        workflowReader: {
          async list() {
            return [];
          },
          async read() {
            return undefined;
          },
        },
      },
    });
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "missing" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });
});

describe("GET /jobs", () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await queue.close();
  });

  function mountWithQueue() {
    return createServer({
      runsDir: "/tmp/does-not-matter",
      ports: { jobQueue: queue, runReader: memoryRunReader({}) },
    });
  }

  test("empty queue → []", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns enqueued rows, serialised as JobRowSchema shape", async () => {
    const app = mountWithQueue();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "a.dot", inputJson: "hello" });
    const res = await app.request("/jobs");
    interface WireRow {
      id: string;
      runId: string;
      input?: string;
      inputJson?: unknown;
    }
    const rows = (await res.json()) as WireRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("j1");
    expect(rows[0]?.runId).toBe("r1");
    // Wire shape exposes `input`, not `inputJson`.
    expect(rows[0]?.input).toBe("hello");
    expect(rows[0]?.inputJson).toBeUndefined();
  });

  test("status filter narrows the result set", async () => {
    const app = mountWithQueue();
    await queue.enqueue({ id: "a", runId: "ra", workflow: "w.dot" });
    await queue.enqueue({ id: "b", runId: "rb", workflow: "w.dot" });
    await queue.claimNext(); // one row becomes running
    const running = await app.request("/jobs?status=running");
    const queued = await app.request("/jobs?status=queued");
    expect(((await running.json()) as unknown[]).length).toBe(1);
    expect(((await queued.json()) as unknown[]).length).toBe(1);
  });

  test("invalid status → 400", async () => {
    const app = mountWithQueue();
    const res = await app.request("/jobs?status=bogus");
    expect(res.status).toBe(400);
  });

  test("limit is clamped to 100", async () => {
    const app = mountWithQueue();
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ id: `j${i}`, runId: `r${i}`, workflow: "w.dot" });
    }
    const res = await app.request("/jobs?limit=9999");
    // 5 rows exist; the clamp doesn't bite here but the request still succeeds.
    expect(res.status).toBe(200);
    expect(((await res.json()) as unknown[]).length).toBe(5);
  });
});

describe("GET /jobs/:id", () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await queue.close();
  });

  function mount() {
    return createServer({
      runsDir: "/tmp/does-not-matter",
      ports: { jobQueue: queue, runReader: memoryRunReader({}) },
    });
  }

  test("known id → 200 with row", async () => {
    const app = mount();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const res = await app.request("/jobs/j1");
    expect(res.status).toBe(200);
    const row = (await res.json()) as { id: string; runId: string };
    expect(row.id).toBe("j1");
    expect(row.runId).toBe("r1");
  });

  test("unknown id → 404", async () => {
    const app = mount();
    const res = await app.request("/jobs/ghost");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /jobs/:id", () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await queue.close();
  });

  function mount() {
    return createServer({
      runsDir: "/tmp/does-not-matter",
      ports: { jobQueue: queue, runReader: memoryRunReader({}) },
    });
  }

  test("queued row → 200 and row is gone", async () => {
    const app = mount();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const res = await app.request("/jobs/j1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await queue.get("j1")).toBeUndefined();
  });

  test("unknown id → 404", async () => {
    const app = mount();
    const res = await app.request("/jobs/ghost", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("running row with run dir present → 202 + canceling (cancel forwarded)", async () => {
    // Plant events.jsonl so the control gateway's run-existence check succeeds.
    const runsDir = await mkdtemp(join(tmpdir(), "swarm-cancel-"));
    try {
      await mkdir(join(runsDir, "r1"), { recursive: true });
      await writeFile(join(runsDir, "r1", "events.jsonl"), `${JSON.stringify({ type: "pipeline.started", seq: 0 })}\n`);
      const placeholder: Event = ev({ type: "pipeline.started" });
      const app = createServer({
        runsDir,
        ports: { jobQueue: queue, runReader: memoryRunReader({ r1: [placeholder] }) },
      });
      await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
      await queue.claimNext();
      const res = await app.request("/jobs/j1", { method: "DELETE" });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { status: string; jobId: string; requestId: string };
      expect(body.status).toBe("canceling");
      expect(body.jobId).toBe("j1");
      expect(typeof body.requestId).toBe("string");
      // control.jsonl should carry a cancel request now.
      const control = await readFile(join(runsDir, "r1", "control.jsonl"), "utf8");
      expect(control).toContain(`"command":"cancel"`);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("running row when run dir missing → marks job canceled directly", async () => {
    // No events.jsonl → control gateway returns not_found → fast-path
    // marks the row as canceled without waiting for the worker.
    const app = mount();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    const res = await app.request("/jobs/j1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("canceled");
    const row = await queue.get("j1");
    expect(row?.status).toBe("canceled");
  });

  test("terminal row → 409", async () => {
    const app = mount();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markTerminal("j1", "success");
    const res = await app.request("/jobs/j1", { method: "DELETE" });
    expect(res.status).toBe(409);
  });
});

describe("jobs routes without a queue (foreground serve)", () => {
  test("POST /jobs → 503", async () => {
    const app = createServer({ runsDir: "/tmp/does-not-matter", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "w.dot" }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("service_unavailable");
  });

  test("GET /jobs → 503", async () => {
    const app = createServer({ runsDir: "/tmp/does-not-matter", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/jobs");
    expect(res.status).toBe(503);
  });

  test("GET /jobs/:id → 503", async () => {
    const app = createServer({ runsDir: "/tmp/does-not-matter", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/jobs/whatever");
    expect(res.status).toBe(503);
  });

  test("DELETE /jobs/:id → 503", async () => {
    const app = createServer({ runsDir: "/tmp/does-not-matter", ports: { runReader: memoryRunReader({}) } });
    const res = await app.request("/jobs/whatever", { method: "DELETE" });
    expect(res.status).toBe(503);
  });
});
