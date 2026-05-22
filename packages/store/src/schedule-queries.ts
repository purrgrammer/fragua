// SQL + typed helpers for the `schedules` table.
//
// Per AGENTS.md: every literal SQL string touching `schedules` lives
// here. `store.ts` owns the transaction boundary and converts
// `ScheduleRow` (snake_case DB shape) into the public `Schedule`
// (camelCase) at its boundary.

import type { Database } from "bun:sqlite";
import type { ScheduleOverlapPolicy } from "./types.ts";

export interface ScheduleRow {
  id: string;
  workflow_ref: string;
  cwd: string;
  project_id: string;
  interval_ms: number;
  interval_text: string;
  input: string | null;
  overlap_policy: ScheduleOverlapPolicy;
  next_fire_at: number;
  last_fire_at: number | null;
  last_run_id: string | null;
  paused_at: number | null;
  created_at: number;
}

const INSERT_SCHEDULE_SQL = `
  INSERT INTO schedules (
    id, workflow_ref, cwd, project_id, interval_ms, interval_text, input,
    overlap_policy, next_fire_at, last_fire_at, last_run_id,
    paused_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
`;

export function insertSchedule(
  db: Database,
  args: {
    id: string;
    workflowRef: string;
    cwd: string;
    projectId: string;
    intervalMs: number;
    intervalText: string;
    input: string | null;
    overlapPolicy: ScheduleOverlapPolicy;
    nextFireAt: number;
    createdAt: number;
  },
): void {
  db.query(INSERT_SCHEDULE_SQL).run(
    args.id,
    args.workflowRef,
    args.cwd,
    args.projectId,
    args.intervalMs,
    args.intervalText,
    args.input,
    args.overlapPolicy,
    args.nextFireAt,
    args.createdAt,
  );
}

const SELECT_SCHEDULE_SQL = `
  SELECT id, workflow_ref, cwd, project_id, interval_ms, interval_text, input,
         overlap_policy, next_fire_at, last_fire_at, last_run_id,
         paused_at, created_at
    FROM schedules
   WHERE id = ?
`;

export function selectSchedule(db: Database, id: string): ScheduleRow | null {
  return db.query<ScheduleRow, [string]>(SELECT_SCHEDULE_SQL).get(id) ?? null;
}

const SELECT_SCHEDULES_BY_CWD_SQL = `
  SELECT id, workflow_ref, cwd, project_id, interval_ms, interval_text, input,
         overlap_policy, next_fire_at, last_fire_at, last_run_id,
         paused_at, created_at
    FROM schedules
   WHERE cwd = ?
   ORDER BY created_at ASC, id ASC
`;

export function selectSchedulesByCwd(db: Database, cwd: string): ScheduleRow[] {
  return db.query<ScheduleRow, [string]>(SELECT_SCHEDULES_BY_CWD_SQL).all(cwd);
}

const SELECT_ALL_SCHEDULES_SQL = `
  SELECT id, workflow_ref, cwd, project_id, interval_ms, interval_text, input,
         overlap_policy, next_fire_at, last_fire_at, last_run_id,
         paused_at, created_at
    FROM schedules
   ORDER BY created_at ASC, id ASC
`;

export function selectAllSchedules(db: Database): ScheduleRow[] {
  return db.query<ScheduleRow, []>(SELECT_ALL_SCHEDULES_SQL).all();
}

const SELECT_DUE_SCHEDULES_SQL = `
  SELECT id, workflow_ref, cwd, project_id, interval_ms, interval_text, input,
         overlap_policy, next_fire_at, last_fire_at, last_run_id,
         paused_at, created_at
    FROM schedules
   WHERE paused_at IS NULL
     AND next_fire_at <= ?
   ORDER BY next_fire_at ASC, id ASC
`;

export function selectDueSchedules(db: Database, now: number): ScheduleRow[] {
  return db.query<ScheduleRow, [number]>(SELECT_DUE_SCHEDULES_SQL).all(now);
}

const UPDATE_SCHEDULE_AFTER_FIRE_SQL = `
  UPDATE schedules
     SET last_fire_at = ?,
         last_run_id  = ?,
         next_fire_at = ? + interval_ms
   WHERE id = ?
`;

export function updateScheduleAfterFire(db: Database, args: { id: string; runId: string; now: number }): void {
  db.query(UPDATE_SCHEDULE_AFTER_FIRE_SQL).run(args.now, args.runId, args.now, args.id);
}

const UPDATE_SCHEDULE_SKIP_SQL = `
  UPDATE schedules
     SET next_fire_at = ? + interval_ms
   WHERE id = ?
`;

export function updateScheduleSkip(db: Database, id: string, now: number): void {
  db.query(UPDATE_SCHEDULE_SKIP_SQL).run(now, id);
}

const UPDATE_SCHEDULE_PAUSED_SQL = `
  UPDATE schedules SET paused_at = ? WHERE id = ? AND paused_at IS NULL
`;

export function updateSchedulePaused(db: Database, id: string, now: number): void {
  db.query(UPDATE_SCHEDULE_PAUSED_SQL).run(now, id);
}

// On resume: clear `paused_at` and re-anchor `next_fire_at` to
// `now + interval_ms`. Per the proposal, resume must NOT trigger a
// catch-up fire \u2014 the pause window is a declared "no fires", and a
// retroactive fire would contradict that.
const UPDATE_SCHEDULE_RESUMED_SQL = `
  UPDATE schedules
     SET paused_at = NULL,
         next_fire_at = ? + interval_ms
   WHERE id = ? AND paused_at IS NOT NULL
`;

export function updateScheduleResumed(db: Database, id: string, now: number): void {
  db.query(UPDATE_SCHEDULE_RESUMED_SQL).run(now, id);
}

const DELETE_SCHEDULE_SQL = `
  DELETE FROM schedules WHERE id = ?
`;

export function deleteScheduleRow(db: Database, id: string): void {
  db.query(DELETE_SCHEDULE_SQL).run(id);
}

// ─────────────────────────────────────────────────────────────────────
// Health stripe: last-N run statuses fired by a schedule
// ─────────────────────────────────────────────────────────────────────

export interface ScheduleRunRow {
  run_id: string;
  status: string;
  enqueued_at: number;
}

const SELECT_SCHEDULE_RUNS_SQL = `
  SELECT run_id, status, enqueued_at
    FROM run_state
   WHERE schedule_id = ?
   ORDER BY enqueued_at DESC, run_id DESC
   LIMIT ?
`;

export function selectScheduleRuns(db: Database, scheduleId: string, limit: number): ScheduleRunRow[] {
  return db.query<ScheduleRunRow, [string, number]>(SELECT_SCHEDULE_RUNS_SQL).all(scheduleId, limit);
}
