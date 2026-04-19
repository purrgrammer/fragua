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
import type { JobQueue, JobRow, JobStatus, ProcessSupervisor } from "./ports.ts";
import { isPidAlive } from "./rendezvous.ts";

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
  const onError =
    opts.onError ??
    ((err, ctx) => {
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
 * One-shot orphan recovery pass. Call on daemon startup, before
 * `startScheduler`. Scans every `status='running'` row in the queue:
 *
 * - **Pid alive** — the worker outlived the previous daemon. We
 *   "adopt" it by spawning a poller that watches the pid; when it
 *   dies, we reconcile against the run's terminal event (same path
 *   the scheduler takes for its own children). The row stays
 *   `running` in the meantime so the new daemon doesn't double-spawn.
 *
 * - **Pid dead** — the worker exited during the daemon outage. Read
 *   the run's last terminal event and mark the job accordingly. If
 *   no terminal event is present, mark the job failed with a
 *   "daemon restart" note.
 *
 * Returns counts + a handle to stop any in-flight watchers (used by
 * daemon shutdown so we don't leak timers).
 */
export interface OrphanRecoveryOptions {
  queue: JobQueue;
  runsDir: string;
  /** How often to poll adopted-orphan pids for liveness. Default 1s. */
  watcherPollIntervalMs?: number;
  /** Optional hook — fires when a reconciled row transitions. */
  onReconciled?: (jobId: string, status: JobStatus) => void;
}

export interface OrphanRecoveryResult {
  /** Rows whose child pids were still alive; each has a watcher. */
  adopted: number;
  /** Rows whose child pids were dead; reconciled inline. */
  reconciled: number;
  /** Stop all watchers — called from daemon shutdown. */
  stop(): void;
}

export async function recoverOrphans(opts: OrphanRecoveryOptions): Promise<OrphanRecoveryResult> {
  const orphans = await opts.queue.runningJobs();
  let adopted = 0;
  let reconciled = 0;
  const watchers: Array<{ stop(): void }> = [];

  const reconcileDead = async (job: JobRow) => {
    const terminal = await readTerminalEvent(opts.runsDir, job.runId);
    const status = mapTerminalToStatus(terminal);
    const error = terminal === undefined ? "daemon restart; worker exited without a terminal event" : undefined;
    await opts.queue.markTerminal(job.id, status, error);
    opts.onReconciled?.(job.id, status);
  };

  for (const job of orphans) {
    if (job.childPid !== undefined && isPidAlive(job.childPid)) {
      adopted++;
      watchers.push(startOrphanWatcher(job, opts, reconcileDead));
    } else {
      reconciled++;
      await reconcileDead(job);
    }
  }

  return {
    adopted,
    reconciled,
    stop() {
      for (const w of watchers) w.stop();
    },
  };
}

/** Poll a pid for liveness; when it dies, reconcile the row. */
function startOrphanWatcher(
  job: JobRow,
  opts: OrphanRecoveryOptions,
  reconcileDead: (j: JobRow) => Promise<void>,
): { stop(): void } {
  const pollMs = opts.watcherPollIntervalMs ?? 1_000;
  let stopped = false;
  let handle: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    if (job.childPid === undefined || !isPidAlive(job.childPid)) {
      try {
        await reconcileDead(job);
      } catch {
        // Best effort — don't crash the watcher.
      }
      return;
    }
    handle = setTimeout(tick, pollMs);
  };
  handle = setTimeout(tick, pollMs);

  return {
    stop() {
      stopped = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

function mapTerminalToStatus(
  terminal: "completed" | "failed" | "canceled" | undefined,
): "success" | "failed" | "canceled" {
  if (terminal === "canceled") return "canceled";
  if (terminal === "completed") return "success";
  return "failed";
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
