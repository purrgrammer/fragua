// Tests for `recoverOrphans`. Two shapes:
//   1. Dead pid → reconcile inline against events.jsonl.
//   2. Alive pid → set up a watcher; when the pid dies later,
//      reconcile via the same path.
//
// Uses `process.pid` as the "alive" pid (guaranteed alive during the
// test) and a massive sentinel as the "dead" pid.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";
import type { JobQueue } from "../src/ports.ts";
import { recoverOrphans } from "../src/scheduler.ts";

const DEAD_PID = 2147483646;

async function plantEvents(
  runsDir: string,
  runId: string,
  terminal?: "pipeline.canceled" | "pipeline.completed" | "pipeline.failed",
): Promise<void> {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  const lines = [`${JSON.stringify({ type: "pipeline.started", seq: 0 })}\n`];
  if (terminal) {
    lines.push(`${JSON.stringify({ type: terminal, seq: 1 })}\n`);
  }
  await writeFile(join(dir, "events.jsonl"), lines.join(""));
}

describe("recoverOrphans", () => {
  let queue: JobQueue;
  let runsDir: string;

  beforeEach(async () => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
    runsDir = await mkdtemp(join(tmpdir(), "swarm-orphan-"));
  });

  afterEach(async () => {
    await queue.close();
    await rm(runsDir, { recursive: true, force: true });
  });

  test("dead pid + completed terminal → marked success inline", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("j1", DEAD_PID);
    await plantEvents(runsDir, "r1", "pipeline.completed");

    const result = await recoverOrphans({ queue, runsDir });
    expect(result.reconciled).toBe(1);
    expect(result.adopted).toBe(0);
    const row = await queue.get("j1");
    expect(row?.status).toBe("success");
    result.stop();
  });

  test("dead pid + canceled terminal → marked canceled", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("j1", DEAD_PID);
    await plantEvents(runsDir, "r1", "pipeline.canceled");

    const result = await recoverOrphans({ queue, runsDir });
    result.stop();
    const row = await queue.get("j1");
    expect(row?.status).toBe("canceled");
  });

  test("dead pid + no terminal event → failed with 'daemon restart' error", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("j1", DEAD_PID);
    // events.jsonl has only the started event, no terminal.
    await plantEvents(runsDir, "r1");

    const result = await recoverOrphans({ queue, runsDir });
    result.stop();
    const row = await queue.get("j1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("daemon restart");
  });

  test("alive pid → adopted; row stays running until pid dies", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    // Our own pid is guaranteed alive during the test.
    await queue.markRunning("j1", process.pid);
    await plantEvents(runsDir, "r1");

    const result = await recoverOrphans({
      queue,
      runsDir,
      watcherPollIntervalMs: 50,
    });
    expect(result.adopted).toBe(1);
    expect(result.reconciled).toBe(0);
    // Row is unchanged — still running.
    const row = await queue.get("j1");
    expect(row?.status).toBe("running");
    // Clean up the watcher so it doesn't keep polling.
    result.stop();
  });

  test("empty queue → no work, no watchers", async () => {
    const result = await recoverOrphans({ queue, runsDir });
    expect(result.adopted).toBe(0);
    expect(result.reconciled).toBe(0);
    result.stop();
  });

  test("does not touch non-running rows", async () => {
    await queue.enqueue({ id: "queued", runId: "rq", workflow: "w.dot" });
    await queue.enqueue({ id: "done", runId: "rd", workflow: "w.dot" });
    await queue.claimNext(); // queued → running
    await queue.markTerminal("queued", "success"); // now success

    const result = await recoverOrphans({ queue, runsDir });
    result.stop();
    // `done` is still queued, `queued` is success — neither touched.
    expect((await queue.get("queued"))?.status).toBe("success");
    expect((await queue.get("done"))?.status).toBe("queued");
  });
});
