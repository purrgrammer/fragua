// Daemon scheduler loop.
//
// Sits on top of `JobQueue` and `ProcessSupervisor`. Each tick:
//   1. If `inflight >= concurrency`, wait for one to finish.
//   2. Otherwise `claimNext()`.
//      - empty queue → short sleep, retry.
//      - row returned → transitioned to `running` atomically.
//   3. `supervisor.spawn(job)` → { pid, exited }.
//      - spawn failure → mark the job `failed` with the error.
//   4. `queue.markRunning(job.id, pid)` to record the child pid.
//   5. Detach the `exited` promise to reconcile on completion.
//
// Reconciliation maps the child's exit code to a terminal job status,
// with the run's own event stream as tiebreaker: a cancel can exit
// non-zero AND 0 depending on how it unwinds, so we check for a
// terminal `pipeline.canceled` event before defaulting to the exit-code
// heuristic.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JobQueue, JobRow, ProcessSupervisor } from "./ports.ts";

export interface SchedulerOptions {
  queue: JobQueue;
  supervisor: ProcessSupervisor;
  /** Hard cap on concurrently-running workers. */
  concurrency: number;
  /** `<runsDir>` — used by reconciliation to peek at events.jsonl. */
  runsDir: string;
  /** How long the loop sleeps when the queue is empty. Default 500ms. */
  pollIntervalMs?: number;
  /** Optional logger for scheduler-level noise. Defaults to console.error. */
  onError?: (err: Error, context: { jobId?: string }) => void;
}

export interface SchedulerHandle {
  /** Stop accepting new work. Resolves once the loop has exited. Running
   * children continue running — callers that want to bring them down
   * should use `supervisor.terminate` separately. */
  stop(): Promise<void>;
  /** How many workers are currently live (for `/health` inflight). */
  inflight(): number;
}

/**
 * Start the scheduler. Returns immediately; the loop runs in the
 * background until `stop()` is called. The loop is single-reader by
 * design — `JobQueue.claimNext` is atomic against itself, but the
 * scheduler doesn't need to share claims across instances.
 */
export function startScheduler(opts: SchedulerOptions): SchedulerHandle {
  const { queue, supervisor, concurrency, runsDir } = opts;
  const pollMs = opts.pollIntervalMs ?? 500;
  const onError = opts.onError ?? ((err, ctx) => {
    const tag = ctx.jobId ? `[${ctx.jobId}]` : "";
    console.error(`scheduler ${tag}: ${err.message}`);
  });

  const inflight = new Set<string>();
  let stopping = false;
  // `wakeUp` lets a completing worker nudge the loop out of its
  // concurrency-backoff wait without a timer.
  let wakeUp: (() => void) | undefined;

  const wake = () => {
    const w = wakeUp;
    wakeUp = undefined;
    if (w) w();
  };

  const waitForSlot = () =>
    new Promise<void>((resolve) => {
      wakeUp = resolve;
    });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, ms);
      // Replace wakeUp so stop/exit can cut the sleep short.
      wakeUp = () => {
        clearTimeout(handle);
        resolve();
      };
    });

  const reconcileAndMark = async (job: JobRow, exitCode: number) => {
    const terminal = await readTerminalEvent(runsDir, job.runId);
    let status: "success" | "failed" | "canceled";
    if (terminal === "canceled") status = "canceled";
    else if (terminal === "failed") status = "failed";
    else if (terminal === "completed") status = "success";
    else status = exitCode === 0 ? "success" : "failed";
    const error = status === "failed" && terminal !== "failed" ? `worker exited ${exitCode}` : undefined;
    await queue.markTerminal(job.id, status, error);
  };

  const loop = async () => {
    while (!stopping) {
      if (inflight.size >= concurrency) {
        await waitForSlot();
        continue;
      }
      let job: JobRow | undefined;
      try {
        job = await queue.claimNext();
      } catch (err) {
        onError(err as Error, {});
        await sleep(pollMs);
        continue;
      }
      if (!job) {
        await sleep(pollMs);
        continue;
      }

      // We hold a reference so we can guarantee `inflight.delete` runs.
      const claimed = job;
      inflight.add(claimed.id);
      try {
        const { pid, exited } = await supervisor.spawn(claimed);
        await queue.markRunning(claimed.id, pid);
        // Detach; reconciliation happens when the child exits.
        exited
          .then(async (code) => {
            try {
              await reconcileAndMark(claimed, code);
            } catch (err) {
              onError(err as Error, { jobId: claimed.id });
            } finally {
              inflight.delete(claimed.id);
              wake();
            }
          })
          .catch((err) => {
            inflight.delete(claimed.id);
            wake();
            onError(err as Error, { jobId: claimed.id });
          });
      } catch (err) {
        inflight.delete(claimed.id);
        try {
          await queue.markTerminal(claimed.id, "failed", `spawn failed: ${(err as Error).message}`);
        } catch (markErr) {
          onError(markErr as Error, { jobId: claimed.id });
        }
      }
    }
  };

  const done = loop().catch((err) => {
    onError(err as Error, {});
  });

  return {
    async stop() {
      stopping = true;
      wake();
      await done;
    },
    inflight() {
      return inflight.size;
    },
  };
}

/**
 * Peek at the tail of `events.jsonl` for a run and classify the
 * terminal event if any. Used by the scheduler to map child exits
 * into job statuses. Returns `undefined` when no terminal event is
 * present (e.g. child crashed before emitting one).
 */
async function readTerminalEvent(
  runsDir: string,
  runId: string,
): Promise<"completed" | "failed" | "canceled" | undefined> {
  try {
    const raw = await readFile(join(runsDir, runId, "events.jsonl"), "utf8");
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let ev: { type?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "pipeline.canceled") return "canceled";
      if (ev.type === "pipeline.completed") return "completed";
      if (ev.type === "pipeline.failed") return "failed";
    }
  } catch {
    // ENOENT or read failure — no terminal event available.
  }
  return undefined;
}
