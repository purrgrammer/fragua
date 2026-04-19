// Adversarial: orphan recovery running concurrently with new enqueues
// and claims. The daemon boot flow is:
//
//   1. Open queue
//   2. recoverOrphans() — scans rows where status='running', reconciles
//      dead pids, adopts alive ones
//   3. startScheduler() — polls queued rows and spawns workers
//
// In reality these happen back-to-back but a future daemon (hot reload,
// multi-instance) could have them overlap. The queue has one writer,
// but the orderings we want to pin down are:
//
//   A. Orphan reconciliation must NEVER touch queued rows — only running.
//   B. New enqueues during recovery must survive; none get lost.
//   C. A new claim racing with a reconcile on a different row must not
//      block / corrupt either row.
//   D. An alive-pid orphan that's adopted must not be reconciled until
//      the pid actually dies — even if a new scheduler tick fires.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";
import type { JobQueue } from "../src/ports.ts";
import { recoverOrphans } from "../src/scheduler.ts";

const DEAD_PID = 2147483646;

async function plantTerminal(
  runsDir: string,
  runId: string,
  terminal?: "pipeline.completed" | "pipeline.failed" | "pipeline.canceled",
): Promise<void> {
  const dir = join(runsDir, runId);
  await mkdir(dir, { recursive: true });
  const lines = [`${JSON.stringify({ type: "pipeline.started" })}\n`];
  if (terminal) lines.push(`${JSON.stringify({ type: terminal })}\n`);
  await writeFile(join(dir, "events.jsonl"), lines.join(""));
}

describe("scheduler — orphan recovery races", () => {
  let queue: JobQueue;
  let runsDir: string;

  beforeEach(async () => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
    runsDir = await mkdtemp(join(tmpdir(), "swarm-sched-race-"));
  });

  afterEach(async () => {
    await queue.close();
    await rm(runsDir, { recursive: true, force: true });
  });

  test("recoverOrphans concurrent with enqueue + claim: queued rows survive, running gets reconciled", async () => {
    // Plant one running orphan with a dead pid + completed terminal.
    await queue.enqueue({ id: "orphan", runId: "r-orphan", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("orphan", DEAD_PID);
    await plantTerminal(runsDir, "r-orphan", "pipeline.completed");

    // Race: fire recoverOrphans while simultaneously enqueuing new rows.
    const [recovery, enqueues] = await Promise.all([
      recoverOrphans({ queue, runsDir }),
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue({ id: `new-${i}`, runId: `r-new-${i}`, workflow: "w.dot" });
        }
      })(),
    ]);
    recovery.stop();
    void enqueues;

    // Orphan reconciled to success.
    const orphan = await queue.get("orphan");
    expect(orphan?.status).toBe("success");
    // All 10 new rows are queued and untouched.
    const queued = await queue.list({ status: "queued", limit: 99 });
    expect(queued).toHaveLength(10);
    expect(queued.every((r) => r.id.startsWith("new-"))).toBe(true);
  });

  test("claims racing with reconciles never touch the wrong row", async () => {
    // Plant: one running orphan (dead pid, will reconcile) + 5 queued jobs.
    await queue.enqueue({ id: "orphan", runId: "r-orphan", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("orphan", DEAD_PID);
    await plantTerminal(runsDir, "r-orphan", "pipeline.failed");

    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ id: `q${i}`, runId: `rq${i}`, workflow: "w.dot", priority: i });
    }

    // Race: recovery + 5 concurrent claimNext calls.
    const [recovery, ...claims] = await Promise.all([
      recoverOrphans({ queue, runsDir }),
      queue.claimNext(),
      queue.claimNext(),
      queue.claimNext(),
      queue.claimNext(),
      queue.claimNext(),
    ]);
    recovery.stop();

    // Orphan reconciled, not re-claimed.
    expect((await queue.get("orphan"))?.status).toBe("failed");
    // All 5 queued rows got claimed (exactly once each).
    const claimed = claims.filter((c) => c !== undefined);
    const ids = new Set(claimed.map((c) => c!.id));
    expect(ids.size).toBe(5);
    expect([...ids].every((id) => id.startsWith("q"))).toBe(true);
  });

  test("adopted (alive-pid) orphan is not reconciled prematurely even under load", async () => {
    // Alive orphan adopted by recovery; polling should hold off on
    // reconcile while the pid is alive.
    await queue.enqueue({ id: "alive", runId: "r-alive", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("alive", process.pid);
    await plantTerminal(runsDir, "r-alive"); // no terminal

    const recovery = await recoverOrphans({ queue, runsDir, watcherPollIntervalMs: 10 });
    expect(recovery.adopted).toBe(1);

    // Hammer the queue with enqueue + claim for a bit so the watcher
    // has plenty of chances to misfire.
    for (let i = 0; i < 20; i++) {
      await queue.enqueue({ id: `x${i}`, runId: `rx${i}`, workflow: "w.dot" });
      await queue.claimNext();
    }
    await new Promise((r) => setTimeout(r, 50));

    // Orphan row still running — watcher correctly deferred.
    const row = await queue.get("alive");
    expect(row?.status).toBe("running");
    recovery.stop();
  });

  test("orphan with malformed events.jsonl falls through to 'daemon restart' failure", async () => {
    await queue.enqueue({ id: "garbled", runId: "r-g", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("garbled", DEAD_PID);
    // Write garbage into events.jsonl — readTerminalEvent should swallow
    // parse errors per-line and ultimately return undefined, producing
    // the "daemon restart" failure path.
    await mkdir(join(runsDir, "r-g"), { recursive: true });
    await writeFile(
      join(runsDir, "r-g", "events.jsonl"),
      "not-json\n{\"truncated\n{incomplete \n",
    );

    const recovery = await recoverOrphans({ queue, runsDir });
    recovery.stop();
    const row = await queue.get("garbled");
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("daemon restart");
  });
});
