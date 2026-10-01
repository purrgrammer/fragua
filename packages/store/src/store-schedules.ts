import { insertDaemonEvent } from "./daemon-queries.ts";
import {
  deleteScheduleRow,
  insertSchedule,
  type ScheduleRow,
  selectAllSchedules,
  selectDueSchedules,
  selectLatestScheduleError,
  selectSchedule,
  selectScheduleRuns,
  selectSchedulesByCwd,
  updateScheduleAfterFire,
  updateSchedulePaused,
  updateScheduleResumed,
  updateScheduleSkip,
} from "./schedule-queries.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { rowToSchedule } from "./store-rows.ts";
import type { CreateScheduleParams, DaemonEvent, Schedule } from "./types.ts";

/** Derive a schedule's insert args + its public `Schedule` shape from the
 * create params. Pure — shared by `createSchedule` and `createScheduleAudited`
 * so the two can't compute `nextFireAt` / `projectId` / defaults differently. */
function buildScheduleInsert(
  params: CreateScheduleParams,
  now: number,
): { insertArgs: Parameters<typeof insertSchedule>[1]; schedule: Schedule } {
  const fireOnCreate = params.fireOnCreate ?? true;
  const overlapPolicy = params.overlapPolicy ?? "skip";
  const nextFireAt = fireOnCreate ? now : now + params.intervalMs;
  const title = params.title ?? null;
  const projectId = params.projectId ?? params.cwd;
  const insertArgs = {
    id: params.id,
    workflowRef: params.workflowRef,
    cwd: params.cwd,
    projectId,
    intervalMs: params.intervalMs,
    intervalText: params.intervalText,
    title,
    overlapPolicy,
    nextFireAt,
    createdAt: now,
  };
  const schedule: Schedule = {
    ...insertArgs,
    lastFireAt: null,
    lastRunId: null,
    pausedAt: null,
    lastError: null,
  };
  return { insertArgs, schedule };
}

/** Public schedule shape + the auto-pause cause. The cause join runs only
 * for paused rows (the dispatcher excludes paused schedules from the due
 * scan, so the hot path never pays it). */
function scheduleFromRow(ctx: StoreCtx, row: ScheduleRow): Schedule {
  const schedule = rowToSchedule(row);
  if (row.paused_at == null) return schedule;
  const err = selectLatestScheduleError(ctx.db, row.id);
  return err == null ? schedule : { ...schedule, lastError: err.error };
}

export function createSchedule(ctx: StoreCtx, params: CreateScheduleParams, now: number): Schedule {
  const { insertArgs, schedule } = buildScheduleInsert(params, now);
  ctx.writeTxn(() => {
    insertSchedule(ctx.db, insertArgs);
  });
  return schedule;
}

export function createScheduleAudited(
  ctx: StoreCtx,
  params: CreateScheduleParams,
  event: DaemonEvent,
  now: number,
): Schedule {
  const { insertArgs, schedule } = buildScheduleInsert(params, now);
  const auditPayload = ctx.validatePayload(event.payload);
  ctx.writeTxn(() => {
    insertSchedule(ctx.db, insertArgs);
    insertDaemonEvent(ctx.db, event.type, auditPayload, now, null);
  });
  return schedule;
}

export function getSchedule(ctx: StoreCtx, id: string): Schedule | null {
  const row = selectSchedule(ctx.db, id);
  return row == null ? null : scheduleFromRow(ctx, row);
}

export function listSchedules(ctx: StoreCtx, opts?: { cwd?: string }): Schedule[] {
  const rows = opts?.cwd != null ? selectSchedulesByCwd(ctx.db, opts.cwd) : selectAllSchedules(ctx.db);
  return rows.map((r) => scheduleFromRow(ctx, r));
}

export function getDueSchedules(ctx: StoreCtx, now: number): Schedule[] {
  return selectDueSchedules(ctx.db, now).map(rowToSchedule);
}

export function pauseSchedule(ctx: StoreCtx, id: string, now: number): void {
  ctx.writeTxn(() => {
    updateSchedulePaused(ctx.db, id, now);
  });
}

export function pauseScheduleAudited(ctx: StoreCtx, id: string, event: DaemonEvent, now: number): void {
  const auditPayload = ctx.validatePayload(event.payload);
  ctx.writeTxn(() => {
    updateSchedulePaused(ctx.db, id, now);
    insertDaemonEvent(ctx.db, event.type, auditPayload, now, null);
  });
}

export function resumeSchedule(ctx: StoreCtx, id: string, now: number): void {
  ctx.writeTxn(() => {
    updateScheduleResumed(ctx.db, id, now);
  });
}

export function resumeScheduleAudited(ctx: StoreCtx, id: string, event: DaemonEvent, now: number): void {
  const auditPayload = ctx.validatePayload(event.payload);
  ctx.writeTxn(() => {
    updateScheduleResumed(ctx.db, id, now);
    insertDaemonEvent(ctx.db, event.type, auditPayload, now, null);
  });
}

export function deleteSchedule(ctx: StoreCtx, id: string): void {
  ctx.writeTxn(() => {
    deleteScheduleRow(ctx.db, id);
  });
}

export function deleteScheduleAudited(ctx: StoreCtx, id: string, event: DaemonEvent, now: number): void {
  const auditPayload = ctx.validatePayload(event.payload);
  ctx.writeTxn(() => {
    deleteScheduleRow(ctx.db, id);
    insertDaemonEvent(ctx.db, event.type, auditPayload, now, null);
  });
}

export function recordScheduleFire(ctx: StoreCtx, scheduleId: string, runId: string, now: number): void {
  ctx.writeTxn(() => {
    updateScheduleAfterFire(ctx.db, { id: scheduleId, runId, now });
  });
}

export function recordScheduleSkipped(ctx: StoreCtx, scheduleId: string, now: number): void {
  ctx.writeTxn(() => {
    updateScheduleSkip(ctx.db, scheduleId, now);
  });
}

export function getScheduleRuns(
  ctx: StoreCtx,
  scheduleId: string,
  limit: number,
): Array<{ runId: string; status: string; enqueuedAt: number }> {
  return selectScheduleRuns(ctx.db, scheduleId, limit).map((r) => ({
    runId: r.run_id,
    status: r.status,
    enqueuedAt: r.enqueued_at,
  }));
}
