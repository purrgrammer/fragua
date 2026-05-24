// `fragua schedule {add,list,rm,pause,resume}` \u2014 thin shells over the
// HTTP /schedules surface.
//
// Discovers the server URL the same way `fragua run` does (no localhost
// default \u2014 a missing server is an error):
//   1. --url override
//   2. server_endpoint in the project store (--db, else <cwd>/.fragua/fragua.db)
//   3. server_endpoint in ~/.fragua/fragua.db (the harness)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";
import { resolveProject } from "../project.ts";

const ALLOWED_INTERVALS = new Set(["30m", "1h", "6h", "24h", "3d", "7d"]);
const ALLOWED_OVERLAP = new Set(["skip", "queue", "concurrent"]);

interface DiscoveryOpts {
  url?: string;
  cwd?: string;
  dbPath?: string;
}

/** Read the published server URL from a store's `server_endpoint` row. */
function discoverEndpointUrl(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    const store = new SqliteStore({ path: dbPath });
    try {
      return store.currentServerEndpoint()?.url ?? undefined;
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

/** Resolve the server URL, or undefined when none is discoverable. */
function resolveBaseUrl(opts: DiscoveryOpts): string | undefined {
  const cwd = opts.cwd ?? process.cwd();
  const projectDb = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".fragua/fragua.db");
  const harnessDb = resolve(homedir(), ".fragua/fragua.db");
  const url = opts.url ?? discoverEndpointUrl(projectDb) ?? discoverEndpointUrl(harnessDb);
  return url?.replace(/\/$/, "");
}

/** Actionable error when no server is discoverable. Returns exit code 1. */
function noServerFound(): number {
  console.error(chalk.red("no running fragua server found"));
  console.error(chalk.dim("  start one with `fragua harness`, or pass --url http://host:port[/api]"));
  return 1;
}

interface RecentRun {
  runId: string;
  status: string;
  enqueuedAt: number;
}

interface ScheduleRow {
  id: string;
  workflowRef: string;
  cwd: string;
  intervalMs: number;
  intervalText: string;
  input: string | null;
  overlapPolicy: string;
  nextFireAt: number;
  lastFireAt: number | null;
  lastRunId: string | null;
  pausedAt: number | null;
  createdAt: number;
  /** Last-N run statuses embedded by GET /schedules for the health stripe. */
  recentRuns?: RecentRun[];
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fail(msg: string, res: Response): Promise<number> {
  console.error(chalk.red(`schedule: ${msg}`));
  try {
    console.error(chalk.dim(`  ${await res.text()}`));
  } catch {}
  return 1;
}

export interface ScheduleAddOptions extends DiscoveryOpts {
  workflow: string;
  every: string;
  cwd?: string;
  input?: string;
  overlap?: string;
  noFireOnCreate?: boolean;
}

export async function scheduleAddCommand(opts: ScheduleAddOptions): Promise<number> {
  if (!ALLOWED_INTERVALS.has(opts.every)) {
    console.error(chalk.red(`schedule add: --every must be one of 30m, 1h, 6h, 24h, 3d, 7d`));
    return 1;
  }
  const overlap = opts.overlap ?? "skip";
  if (!ALLOWED_OVERLAP.has(overlap)) {
    console.error(chalk.red(`schedule add: --on-overlap must be one of skip, queue, concurrent`));
    return 1;
  }
  const baseUrl = resolveBaseUrl(opts);
  if (baseUrl == null) return noServerFound();
  // Resolve project identity at the boundary (walk-up + auto-init); the
  // schedule records cwd as the project root and carries the project id so
  // fired runs attribute correctly.
  const project = await resolveProject(opts.cwd ?? process.cwd());
  const cwd = project.projectRoot;
  const body: Record<string, unknown> = {
    workflow: opts.workflow,
    cwd,
    projectId: project.projectId,
    every: opts.every,
    overlap,
    fireOnCreate: opts.noFireOnCreate !== true,
  };
  if (opts.input !== undefined) body["input"] = opts.input;

  const res = await postJson(`${baseUrl}/schedules`, body);
  if (!res.ok) return fail(`add failed (${res.status})`, res);
  const created = (await res.json()) as ScheduleRow;
  console.log(chalk.green(`schedule created: ${created.id}`));
  console.log(
    chalk.dim(
      `  workflow=${created.workflowRef} every=${created.intervalText} cwd=${created.cwd} overlap=${created.overlapPolicy}`,
    ),
  );
  console.log(chalk.dim(`  next fire: ${formatRelative(created.nextFireAt, Date.now())}`));
  return 0;
}

export interface ScheduleListOptions extends DiscoveryOpts {
  cwd?: string;
}

export async function scheduleListCommand(opts: ScheduleListOptions): Promise<number> {
  const baseUrl = resolveBaseUrl(opts);
  if (baseUrl == null) return noServerFound();
  const cwd = opts.cwd != null ? resolve(opts.cwd) : undefined;
  const url = cwd != null ? `${baseUrl}/schedules?cwd=${encodeURIComponent(cwd)}` : `${baseUrl}/schedules`;
  const res = await fetch(url);
  if (!res.ok) return fail(`list failed (${res.status})`, res);
  const rows = (await res.json()) as ScheduleRow[];
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
  }
  return 0;
}

export interface ScheduleIdOptions extends DiscoveryOpts {
  id: string;
}

export async function scheduleRmCommand(opts: ScheduleIdOptions): Promise<number> {
  const baseUrl = resolveBaseUrl(opts);
  if (baseUrl == null) return noServerFound();
  const res = await fetch(`${baseUrl}/schedules/${encodeURIComponent(opts.id)}`, { method: "DELETE" });
  if (res.status === 404) {
    console.error(chalk.red(`schedule rm: not found: ${opts.id}`));
    return 1;
  }
  if (!res.ok) return fail(`rm failed (${res.status})`, res);
  console.log(chalk.green(`schedule deleted: ${opts.id}`));
  return 0;
}

export async function schedulePauseCommand(opts: ScheduleIdOptions): Promise<number> {
  const baseUrl = resolveBaseUrl(opts);
  if (baseUrl == null) return noServerFound();
  const res = await postJson(`${baseUrl}/schedules/${encodeURIComponent(opts.id)}/pause`, {});
  if (res.status === 404) {
    console.error(chalk.red(`schedule pause: not found: ${opts.id}`));
    return 1;
  }
  if (!res.ok) return fail(`pause failed (${res.status})`, res);
  console.log(chalk.green(`schedule paused: ${opts.id}`));
  return 0;
}

export async function scheduleResumeCommand(opts: ScheduleIdOptions): Promise<number> {
  const baseUrl = resolveBaseUrl(opts);
  if (baseUrl == null) return noServerFound();
  const res = await postJson(`${baseUrl}/schedules/${encodeURIComponent(opts.id)}/resume`, {});
  if (res.status === 404) {
    console.error(chalk.red(`schedule resume: not found: ${opts.id}`));
    return 1;
  }
  if (!res.ok) return fail(`resume failed (${res.status})`, res);
  console.log(chalk.green(`schedule resumed: ${opts.id}`));
  return 0;
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
  console.log("  --input <text>                Free-form description for every fire");
  console.log("  --on-overlap <skip|queue|concurrent>  Default skip");
  console.log("  --no-fire-on-create           Wait one full interval before first fire");
  return 0;
}
