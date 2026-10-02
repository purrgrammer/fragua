// `fragua schedule {add,list,rm,pause,resume}` \u2014 direct store-client.
// Reads/writes schedule rows + their daemon-event audit trail straight on the
// local store (no HTTP). Store path: --db, else ~/.fragua/fragua.db (harness).

import { resolve } from "node:path";
import type { Schedule } from "@fragua/store";
import chalk from "chalk";
import { resolveProject } from "../project.ts";
import { withStoreClient } from "../store-client.ts";

interface ScheduleOpts {
  cwd?: string;
  dbPath?: string;
}

interface RecentRun {
  runId: string;
  status: string;
  enqueuedAt: number;
}

type ScheduleListRow = Schedule & { recentRuns?: RecentRun[] };

export interface ScheduleAddOptions extends ScheduleOpts {
  workflow: string;
  every: string;
  cwd?: string;
  title?: string;
  overlap?: string;
  noFireOnCreate?: boolean;
}

export async function scheduleAddCommand(opts: ScheduleAddOptions): Promise<number> {
  // Resolve project identity at the boundary (walk-up + auto-init); the
  // schedule records cwd as the project root and carries the project id so
  // fired runs attribute correctly.
  const project = await resolveProject(opts.cwd ?? process.cwd());
  return withStoreClient(opts, ({ plane }) => {
    // Validation (interval / overlap whitelists), id mint, and the atomic
    // row + audit-event write all live in the intent plane — the single
    // implementation the server route shares.
    const build = plane.buildScheduleCreate({
      workflow: opts.workflow,
      cwd: project.projectRoot,
      projectId: project.projectId,
      every: opts.every,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.overlap !== undefined ? { overlap: opts.overlap } : {}),
      fireOnCreate: opts.noFireOnCreate !== true,
    });
    if (!build.ok) {
      console.error(chalk.red(`schedule add: ${build.error}`));
      return 1;
    }
    const created = plane.commitScheduleCreate(build.create, Date.now());
    console.log(chalk.green(`schedule created: ${created.id}`));
    console.log(
      chalk.dim(
        `  workflow=${created.workflowRef} every=${created.intervalText} cwd=${created.cwd} overlap=${created.overlapPolicy}`,
      ),
    );
    console.log(chalk.dim(`  next fire: ${formatRelative(created.nextFireAt, Date.now())}`));
    return 0;
  });
}

export interface ScheduleListOptions extends ScheduleOpts {
  cwd?: string;
}

export async function scheduleListCommand(opts: ScheduleListOptions): Promise<number> {
  const cwdFilter = opts.cwd != null ? resolve(opts.cwd) : undefined;
  return withStoreClient(opts, ({ store }) => {
    const schedules = store.listSchedules(cwdFilter != null ? { cwd: cwdFilter } : {});
    const rows: ScheduleListRow[] = schedules.map((s) => ({ ...s, recentRuns: store.getScheduleRuns(s.id, 10) }));
    if (rows.length === 0) {
      console.log(chalk.dim("(no schedules)"));
      return 0;
    }
    const now = Date.now();
    console.log(["ID", "Workflow", "cwd", "Every", "Last fire", "Next fire", "Status", "Last 10"].join("\t"));
    for (const r of rows) {
      const status = r.pausedAt != null ? chalk.yellow("paused") : chalk.green("active");
      const last = r.lastFireAt != null ? formatRelative(r.lastFireAt, now) : "\u2014";
      const next = r.pausedAt != null ? "\u2014" : formatRelative(r.nextFireAt, now);
      const stripe = buildHealthStripe(r.recentRuns ?? []);
      console.log([r.id, r.workflowRef, r.cwd, r.intervalText, last, next, status, stripe].join("\t"));
      // The auto-pause cause (an unresolvable/invalid workflow) \u2014 without it
      // a dispatcher-paused schedule is indistinguishable from an operator one.
      if (r.lastError != null) console.log(chalk.red(`  \u21b3 paused by dispatcher: ${r.lastError}`));
    }
    return 0;
  });
}

export interface ScheduleIdOptions extends ScheduleOpts {
  id: string;
}

export async function scheduleRmCommand(opts: ScheduleIdOptions): Promise<number> {
  return withStoreClient(opts, ({ store, plane }) => {
    if (store.getSchedule(opts.id) == null) {
      console.error(chalk.red(`schedule rm: not found: ${opts.id}`));
      return 1;
    }
    plane.commitScheduleDelete(opts.id, plane.buildScheduleDelete(opts.id), Date.now());
    console.log(chalk.green(`schedule deleted: ${opts.id}`));
    return 0;
  });
}

export async function schedulePauseCommand(opts: ScheduleIdOptions): Promise<number> {
  return withStoreClient(opts, ({ store, plane }) => {
    if (store.getSchedule(opts.id) == null) {
      console.error(chalk.red(`schedule pause: not found: ${opts.id}`));
      return 1;
    }
    plane.commitSchedulePause(opts.id, plane.buildSchedulePause(opts.id), Date.now());
    console.log(chalk.green(`schedule paused: ${opts.id}`));
    return 0;
  });
}

export async function scheduleResumeCommand(opts: ScheduleIdOptions): Promise<number> {
  return withStoreClient(opts, ({ store, plane }) => {
    if (store.getSchedule(opts.id) == null) {
      console.error(chalk.red(`schedule resume: not found: ${opts.id}`));
      return 1;
    }
    plane.commitScheduleResume(opts.id, plane.buildScheduleResume(opts.id), Date.now());
    console.log(chalk.green(`schedule resumed: ${opts.id}`));
    return 0;
  });
}

/** Map a run's status to a single health-stripe glyph.
 *  The stripe reads left-to-right oldest→newest, same convention as
 *  the proposal's example output. */
function runToGlyph(status: string): string {
  if (status === "completed") return "✅";
  if (status === "halted" || status === "cancelled" || status === "quarantined") return "❌";
  return "⏳";
}

function buildHealthStripe(runs: RecentRun[]): string {
  if (runs.length === 0) return "—";
  // recentRuns arrives newest-first from the server; reverse so the
  // stripe reads oldest-to-newest matching the proposal's example.
  return [...runs]
    .reverse()
    .map((r) => runToGlyph(r.status))
    .join("");
}

function formatRelative(ts: number, now: number): string {
  const dMs = ts - now;
  const abs = Math.abs(dMs);
  const min = Math.floor(abs / 60_000);
  const hr = Math.floor(min / 60);
  const dir = dMs >= 0 ? "in" : "ago";
  if (hr >= 24) return `${dir} ${Math.floor(hr / 24)}d`;
  if (hr >= 1) return `${dir} ${hr}h${min % 60 > 0 ? ` ${min % 60}m` : ""}`;
  return `${dir} ${min}m`;
}

export function scheduleHelp(): number {
  console.log(chalk.bold("fragua schedule \u2014 manage recurring workflow runs\n"));
  console.log("Subcommands:");
  console.log(`  ${chalk.cyan("add <workflow>")}   Create a schedule (--every required)`);
  console.log(`  ${chalk.cyan("list")}             List schedules (--cwd to filter)`);
  console.log(`  ${chalk.cyan("rm <id>")}          Delete a schedule`);
  console.log(`  ${chalk.cyan("pause <id>")}       Pause a schedule`);
  console.log(`  ${chalk.cyan("resume <id>")}      Resume a paused schedule`);
  console.log("\nOptions on add:");
  console.log("  --every <30m|1h|6h|24h|3d|7d>  Interval shorthand (required)");
  console.log("  --cwd <dir>                   Project root (default cwd)");
  console.log("  --title <text>                Run title applied to every fired run");
  console.log("  --on-overlap <skip|queue|concurrent>  Default skip");
  console.log("  --no-fire-on-create           Wait one full interval before first fire");
  return 0;
}
