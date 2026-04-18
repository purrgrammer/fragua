// Scheduler loop tests. Drives `startScheduler` against in-memory
// fakes for JobQueue + ProcessSupervisor so the focus stays on loop
// mechanics: concurrency cap, terminal reconciliation, spawn-failure
// path. End-to-end spawning of real `swarm run` workers is covered
// by the smoke test in `local-process-supervisor.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobQueue, JobRow, ProcessSupervisor } from "../src/ports.ts";
import { startScheduler } from "../src/scheduler.ts";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";

/**
 * Fake supervisor. Each call to `spawn` hands back a controlled
 * exit promise; tests resolve those to drive reconciliation.
 */
function fakeSupervisor() {
  const handles = new Map<string, { pid: number; resolve: (code: number) => void; exited: Promise<number> }>();
  let nextPid = 10_000;

  const supervisor: ProcessSupervisor = {
    async spawn(job: JobRow) {
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((r) => {
        resolveExit = r;
      });
      const pid = nextPid++;
      handles.set(job.id, { pid, resolve: resolveExit, exited });
      return { pid, exited };
    },
    async terminate() {
      return true;
    },
  };

  return {
    supervisor,
    /** Resolve the given job's exit promise with the supplied code. */
    finish(jobId: string, code: number) {
      const h = handles.get(jobId);
      if (!h) throw new Error(`no spawn recorded for job ${jobId}`);
      h.resolve(code);
    },
    activeJobIds: () => [...handles.keys()],
  };
}

/**
 * Wait until `predicate()` returns true or the timeout expires. Used
 * to bridge between imperative test steps and the async loop.
 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor: timed out");
}

describe("startScheduler", () => {
  let queue: JobQueue;
  let runsDir: string;

  beforeEach(async () => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
    runsDir = await mkdtemp(join(tmpdir(), "swarm-sched-"));
  });

  afterEach(async () => {
    await queue.close();
    await rm(runsDir, { recursive: true, force: true });
  });

  test("picks up a queued job, marks it running with pid, then success on exit 0", async () => {
    const sup = fakeSupervisor();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 1, runsDir });

    // Wait for it to enter running.
    await waitFor(() => sup.activeJobIds().length === 1);
    const row = await queue.get("j1");
    expect(row?.status).toBe("running");
    expect(row?.childPid).toBeGreaterThan(0);

    // Simulate the worker exiting cleanly.
    sup.finish("j1", 0);
    await waitFor(async () => {
      const r = await queue.get("j1");
      return r?.status === "success";
    });

    await handle.stop();
    const final = await queue.get("j1");
    expect(final?.status).toBe("success");
    expect(final?.childPid).toBeUndefined();
  });

  test("exit code non-zero → failed (when no terminal event in events.jsonl)", async () => {
    const sup = fakeSupervisor();
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 1, runsDir });
    await waitFor(() => sup.activeJobIds().length === 1);
    sup.finish("j1", 42);
    await waitFor(async () => (await queue.get("j1"))?.status === "failed");
    await handle.stop();
    const row = await queue.get("j1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("42");
  });

  test("pipeline.canceled event wins over exit code (cancel reconciliation)", async () => {
    const sup = fakeSupervisor();
    await queue.enqueue({ id: "j1", runId: "cancel-run", workflow: "w.dot" });
    // Plant a canceled terminal event BEFORE the exit fires.
    const runDir = join(runsDir, "cancel-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ type: "pipeline.canceled", seq: 1 })}\n`,
    );

    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 1, runsDir });
    await waitFor(() => sup.activeJobIds().length === 1);
    // Even an exit code of 0 (graceful cancel) reconciles to canceled.
    sup.finish("j1", 0);
    await waitFor(async () => (await queue.get("j1"))?.status === "canceled");
    await handle.stop();
    const row = await queue.get("j1");
    expect(row?.status).toBe("canceled");
  });

  test("pipeline.completed event maps to success even when exit code is non-zero", async () => {
    // Edge case: the worker emitted completed then crashed during shutdown.
    // The event stream is authoritative.
    const sup = fakeSupervisor();
    await queue.enqueue({ id: "j1", runId: "ok-run", workflow: "w.dot" });
    const runDir = join(runsDir, "ok-run");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({ type: "pipeline.completed", seq: 1 })}\n`,
    );
    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 1, runsDir });
    await waitFor(() => sup.activeJobIds().length === 1);
    sup.finish("j1", 1);
    await waitFor(async () => {
      const r = await queue.get("j1");
      return r?.status === "success";
    });
    await handle.stop();
  });

  test("concurrency cap holds — never more than N in flight", async () => {
    const sup = fakeSupervisor();
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ id: `j${i}`, runId: `r${i}`, workflow: "w.dot" });
    }
    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 2, runsDir });

    // Give the loop a moment to claim the max it can.
    await waitFor(() => sup.activeJobIds().length === 2);
    // Crucially: it should NOT claim a third.
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.activeJobIds().length).toBe(2);
    expect(handle.inflight()).toBe(2);

    // Finish one; the loop picks up the next.
    sup.finish(sup.activeJobIds()[0]!, 0);
    await waitFor(() => sup.activeJobIds().length === 3);
    expect(handle.inflight()).toBeLessThanOrEqual(2);

    // Finish the rest so cleanup is clean.
    for (const id of sup.activeJobIds()) sup.finish(id, 0);
    await waitFor(async () => (await queue.list({ status: "queued" })).length === 0);
    await handle.stop();
  });

  test("spawn failure → job marked failed, loop keeps going", async () => {
    let spawnCalls = 0;
    const supervisor: ProcessSupervisor = {
      async spawn() {
        spawnCalls++;
        if (spawnCalls === 1) throw new Error("disk full");
        // Second spawn succeeds with immediate exit 0.
        let resolveExit!: (code: number) => void;
        const exited = new Promise<number>((r) => {
          resolveExit = r;
        });
        setTimeout(() => resolveExit(0), 5);
        return { pid: 42, exited };
      },
      async terminate() {
        return true;
      },
    };
    await queue.enqueue({ id: "bad", runId: "rb", workflow: "w.dot" });
    await queue.enqueue({ id: "good", runId: "rg", workflow: "w.dot" });

    const handle = startScheduler({
      queue,
      supervisor,
      concurrency: 1,
      runsDir,
      onError: () => {},
    });

    await waitFor(async () => (await queue.get("bad"))?.status === "failed");
    await waitFor(async () => (await queue.get("good"))?.status === "success");
    await handle.stop();

    const bad = await queue.get("bad");
    expect(bad?.status).toBe("failed");
    expect(bad?.error).toContain("disk full");
  });

  test("stop() waits for the loop to exit; further enqueues are NOT picked up", async () => {
    const sup = fakeSupervisor();
    const handle = startScheduler({ queue, supervisor: sup.supervisor, concurrency: 1, runsDir });
    await handle.stop();
    await queue.enqueue({ id: "late", runId: "rl", workflow: "w.dot" });
    // Give any lingering poll a moment.
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.activeJobIds()).toEqual([]);
    expect((await queue.get("late"))?.status).toBe("queued");
  });
});
