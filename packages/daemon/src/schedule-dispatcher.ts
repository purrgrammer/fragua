// Schedule dispatcher fiber.
//
// Wakes once a minute (configurable), selects rows where
// `next_fire_at <= now AND paused_at IS NULL`, and decides per row:
//
//   - skip-on-overlap: if `overlap_policy='skip'` and the prior run
//     hasn't reached a terminal state, advance `next_fire_at` and
//     emit `fact.schedule_skipped { reason: "overlap" }` \u2014 no fire.
//   - resolve workflow_ref: try `~/.fragua/workflows/<ref>.yaml`, then
//     `<cwd>/.fragua/workflows/<ref>.yaml`, else literal path. On miss
//     or parse failure, emit `fact.schedule_invalid_workflow` and
//     auto-pause the schedule.
//   - emit `fact.schedule_late { missedIntervals }` *before* the
//     catch-up fire when one or more slots were missed; one fire per
//     resume window per the at-most-one catch-up policy.
//   - mint a run id, save the workflow, enqueue the run with
//     `scheduleId` set, then emit `fact.schedule_fired { runId }` and
//     advance `next_fire_at = now + interval_ms` (anchored to actual
//     fire time, not target).
//
// All file I/O (workflow resolution, source read) happens inside the
// dispatcher \u2014 the store stays pure SQL.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { parseWorkflow } from "@fragua/core";
import { type IEventStore, isTerminal as isTerminalStatus, sha256Hex } from "@fragua/store";

export const DEFAULT_SCHEDULE_TICK_MS = 60_000;

export interface ScheduleDispatcherOpts {
  store: IEventStore;
  shutdownSignal: AbortSignal;
  /** Tick interval. Defaults to 60s; tests inject smaller values. */
  tickIntervalMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** `~/.fragua/workflows/` override for tests. */
  homeDir?: string;
  /** Run id minter. Defaults to a 16-char crockford-base32 stamp. */
  newRunId?: () => string;
  /** Tick reporter \u2014 fires after every successful tick (including
   *  no-op ticks where nothing was due). Tests use this to advance
   *  past a tick deterministically. */
  onTick?: (info: { fired: number; skipped: number; paused: number }) => void;
}

interface FireOutcome {
  fired: number;
  skipped: number;
  paused: number;
}

export function startScheduleDispatcher(opts: ScheduleDispatcherOpts): { promise: Promise<void> } {
  const tickMs = opts.tickIntervalMs ?? DEFAULT_SCHEDULE_TICK_MS;
  const promise = (async () => {
    while (!opts.shutdownSignal.aborted) {
      try {
        const outcome = scheduleDispatcherTick(opts);
        if (opts.onTick) opts.onTick(outcome);
      } catch (err) {
        // Never crash the loop. A pathological row should be visible
        // (audit row) but not take the daemon down.
        // eslint-disable-next-line no-console
        console.warn("[schedule-dispatcher] tick failed:", err);
      }
      if (opts.shutdownSignal.aborted) return;
      await sleep(tickMs, opts.shutdownSignal);
    }
  })();
  return { promise };
}

/**
 * Single-tick of the dispatcher. Exported for tests so they can drive
 * the loop synchronously without scheduling timers. Honours the full
 * proposal's per-row decision tree.
 */
export function scheduleDispatcherTick(opts: ScheduleDispatcherOpts): FireOutcome {
  const now = (opts.now ?? Date.now)();
  const newRunId = opts.newRunId ?? defaultRunId;
  const due = opts.store.getDueSchedules(now);
  let fired = 0;
  let skipped = 0;
  let paused = 0;

  for (const row of due) {
    // Skip-on-overlap: don't fire if the prior run is still active.
    if (row.overlapPolicy === "skip" && row.lastRunId != null) {
      const prior = opts.store.getState(row.lastRunId);
      if (prior != null && !isTerminalStatus(prior.status)) {
        opts.store.recordScheduleSkipped(row.id, now);
        opts.store.appendDaemonEvent(
          {
            type: "fact.schedule_skipped",
            payload: { scheduleId: row.id, reason: "overlap" },
          },
          // No runId on this audit row \u2014 the schedule didn't produce a
          // run this tick. (If we surfaced lastRunId it would mislead
          // consumers into thinking *that* run was the result of *this*
          // tick.)
        );
        skipped++;
        continue;
      }
    }

    // Resolve workflow_ref; auto-pause + audit on failure.
    const resolved = resolveSchedulingWorkflow(row.workflowRef, row.cwd, opts.homeDir);
    if (resolved == null) {
      opts.store.pauseSchedule(row.id, now);
      opts.store.appendDaemonEvent({
        type: "fact.schedule_invalid_workflow",
        payload: { scheduleId: row.id, error: `workflow not found: ${row.workflowRef}` },
      });
      paused++;
      continue;
    }

    let dotSource: string;
    try {
      dotSource = readFileSync(resolved.dotPath, "utf8");
    } catch (err) {
      opts.store.pauseSchedule(row.id, now);
      opts.store.appendDaemonEvent({
        type: "fact.schedule_invalid_workflow",
        payload: {
          scheduleId: row.id,
          error: `cannot read ${resolved.dotPath}: ${(err as Error).message}`,
        },
      });
      paused++;
      continue;
    }

    try {
      parseWorkflow(dotSource);
    } catch (err) {
      opts.store.pauseSchedule(row.id, now);
      opts.store.appendDaemonEvent({
        type: "fact.schedule_invalid_workflow",
        payload: {
          scheduleId: row.id,
          error: `parse failed: ${(err as Error).message}`,
        },
      });
      paused++;
      continue;
    }

    // Catch-up audit \u2014 emitted *before* the fire when slot(s) missed.
    // Anchor counting to `next_fire_at` (the original target).
    const missedIntervals = Math.max(0, Math.floor((now - row.nextFireAt) / row.intervalMs));
    if (missedIntervals >= 1) {
      opts.store.appendDaemonEvent({
        type: "fact.schedule_late",
        payload: {
          scheduleId: row.id,
          missedIntervals,
          lastTargetAt: row.nextFireAt,
        },
      });
    }

    // Fire.
    const sha = sha256Hex(dotSource);
    opts.store.saveWorkflow(sha, resolved.name, dotSource);
    const runId = newRunId();
    const initialRouting: Record<string, unknown> = {};
    if (row.input != null && row.input.length > 0) initialRouting["input"] = row.input;

    opts.store.enqueueRun({
      runId,
      workflowSha: sha,
      cwd: row.cwd,
      ...(resolved.scope === "global" || resolved.scope === "local"
        ? { workflowName: resolved.name, workflowScope: resolved.scope }
        : { workflowScope: "path", workflowPath: resolved.dotPath }),
      ...(Object.keys(initialRouting).length > 0 ? { initialRouting } : {}),
      scheduleId: row.id,
    });
    opts.store.recordScheduleFire(row.id, runId, now);
    opts.store.appendDaemonEvent(
      {
        type: "fact.schedule_fired",
        payload: { scheduleId: row.id, runId },
      },
      { runId },
    );
    fired++;
  }

  return { fired, skipped, paused };
}

interface ResolvedSchedulingWorkflow {
  dotPath: string;
  name: string;
  scope: "global" | "local" | "path";
}

/** Synchronous workflow-path resolver used by the dispatcher tick.
 *  Mirrors `@fragua/cli`'s async `resolveWorkflow` cascade: bare name \u2192
 *  `~/.fragua/workflows/<name>.yaml` \u2192 `<cwd>/.fragua/workflows/<name>.yaml`;
 *  paths resolve directly. We keep a local copy because @fragua/daemon
 *  must not depend on @fragua/cli (the dependency direction is the
 *  other way around). */
function resolveSchedulingWorkflow(
  arg: string,
  cwd: string,
  homeDir: string | undefined,
): ResolvedSchedulingWorkflow | null {
  const looksLikePath = arg.includes("/") || arg.includes("\\") || arg.endsWith(".yaml");
  if (!looksLikePath) {
    const globalDir = resolvePath(homeDir ?? homedir(), ".fragua/workflows");
    const globalCandidate = resolvePath(globalDir, `${arg}.yaml`);
    if (existsSync(globalCandidate)) {
      return { dotPath: globalCandidate, name: arg, scope: "global" };
    }
    const localCandidate = resolvePath(cwd, ".fragua/workflows", `${arg}.yaml`);
    if (existsSync(localCandidate)) {
      return { dotPath: localCandidate, name: arg, scope: "local" };
    }
    return null;
  }
  const path = resolvePath(cwd, arg);
  if (existsSync(path)) {
    const slash = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
    const leaf = slash >= 0 ? arg.slice(slash + 1) : arg;
    const dot = leaf.lastIndexOf(".");
    const name = dot > 0 ? leaf.slice(0, dot) : leaf;
    return { dotPath: path, name, scope: "path" };
  }
  return null;
}

const ID_ALPH = "0123456789abcdefghjkmnpqrstvwxyz";
function defaultRunId(): string {
  let s = "run_";
  for (let i = 0; i < 12; i++) s += ID_ALPH[Math.floor(Math.random() * ID_ALPH.length)];
  return s;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
