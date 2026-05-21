// `fragua runs {accept,discard,diff}` — operator post-run primitives over the
// HTTP surface.
//
// accept/discard POST the post-terminal operator-action intents the daemon
// sweep folds into git mutations (accept replays the run's commits onto the
// operator's current branch + stages the tail; discard drops the refs).
// `diff` is a read over the snapshot endpoints. Harness discovery mirrors
// `fragua run`:
//   1. --url   2. <cwd>/.fragua/serve.json (or <db-dir>/serve.json with --db)
//   3. ~/.fragua/fragua.db daemon_lock.http_url   4. http://localhost:3000

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";

interface DiscoveryOpts {
  url?: string;
  cwd?: string;
  dbPath?: string;
}

async function discoverServerUrl(searchPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(searchPath, "utf8")) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : undefined;
  } catch {
    return undefined;
  }
}

function discoverHarnessUrl(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    const store = new SqliteStore({ path: dbPath });
    try {
      return store.currentDaemonLock()?.httpUrl ?? undefined;
    } finally {
      store.close();
    }
  } catch {
    return undefined;
  }
}

async function resolveBaseUrl(opts: DiscoveryOpts): Promise<string> {
  const cwd = opts.cwd ?? process.cwd();
  const serveJsonPath = opts.dbPath
    ? resolve(dirname(resolve(opts.dbPath)), "serve.json")
    : resolve(cwd, ".fragua/serve.json");
  const harnessDbPath = resolve(homedir(), ".fragua/fragua.db");
  const url =
    opts.url ??
    (await discoverServerUrl(serveJsonPath)) ??
    discoverHarnessUrl(harnessDbPath) ??
    "http://localhost:3000";
  return url.replace(/\/$/, "");
}

async function postAction(verb: string, runId: string, body: unknown, opts: DiscoveryOpts): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const res = await fetch(`${baseUrl}/runs/${encodeURIComponent(runId)}/${verb}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return failResponse(verb, res);
  const body2 = (await res.json()) as {
    seq?: number;
    sha?: string;
    replayed?: number;
    tailStaged?: boolean;
  };
  // accept/discard run synchronously server-side and return their result.
  if (verb === "accept" && body2.sha != null) {
    const tail = body2.tailStaged === true ? "; tail staged — `git commit` when ready" : "";
    console.log(chalk.green("accepted") + chalk.dim(` (run ${runId}, replayed ${body2.replayed ?? 0}${tail})`));
  } else if (verb === "discard") {
    console.log(chalk.green("discarded") + chalk.dim(` (run ${runId})`));
  } else {
    console.log(chalk.green(`${verb} requested`) + chalk.dim(` (run ${runId}, intent seq ${body2.seq})`));
  }
  return 0;
}

async function failResponse(verb: string, res: Response): Promise<number> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    detail = body.error ?? "";
    if (body.code) detail += chalk.dim(` [${body.code}]`);
  } catch {
    try {
      detail = await res.text();
    } catch {}
  }
  console.error(chalk.red(`${verb}: ${res.status}`) + (detail ? ` ${detail}` : ""));
  return 1;
}

export interface DiscardOptions extends DiscoveryOpts {
  runId: string;
}

export function discardCommand(opts: DiscardOptions): Promise<number> {
  return postAction("discard", opts.runId, {}, opts);
}

export interface AcceptOptions extends DiscoveryOpts {
  runId: string;
}

export function acceptCommand(opts: AcceptOptions): Promise<number> {
  return postAction("accept", opts.runId, {}, opts);
}

interface SnapshotRow {
  eventIdx: number;
  nodeId: string | null;
  label: string;
}

interface InboxRunRow {
  runId: string;
  title?: string;
  runStatus?: string;
  changeStat?: {
    committed: { filesChanged: number; insertions: number; deletions: number } | null;
    uncommitted: { filesChanged: number; insertions: number; deletions: number } | null;
  };
}

export interface InboxOptions extends DiscoveryOpts {
  limit?: number;
}

const BLOCKED_STATUSES = "paused_human,paused,paused_auto,quarantined";

function titleOf(r: InboxRunRow): string {
  return r.title != null && r.title.length > 0 ? r.title : chalk.dim("(untitled)");
}

function changeBadge(r: InboxRunRow): string {
  const stat = r.changeStat?.committed ?? r.changeStat?.uncommitted ?? null;
  if (stat == null) return "";
  return ` ${chalk.dim(`(${stat.filesChanged} file${stat.filesChanged === 1 ? "" : "s"}, `)}${chalk.green(`+${stat.insertions}`)}${chalk.dim(" / ")}${chalk.red(`−${stat.deletions}`)}${chalk.dim(")")}`;
}

/** Suggested verb for a blocked run, by lifecycle status. */
function blockedVerb(runStatus?: string): string {
  if (runStatus === "paused_human") return "respond";
  if (runStatus === "quarantined") return "unquarantine";
  return "resume"; // paused | paused_auto
}

/**
 * Two-section operator inbox, mirroring the web /inbox:
 *   NEEDS INPUT  — blocked runs (HITL / paused / quarantined) → unblock so
 *                  the run continues (respond / resume / unquarantine).
 *   READY TO LAND — terminal runs with recoverable work → land the output
 *                  (accept / discard).
 */
export async function inboxCommand(opts: InboxOptions): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const list = async (qs: Record<string, string>): Promise<InboxRunRow[]> => {
    const params = new URLSearchParams({ order: "oldest", cwd, ...qs });
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const res = await fetch(`${baseUrl}/runs?${params.toString()}`);
    return res.ok ? ((await res.json()) as InboxRunRow[]) : [];
  };

  const [blocked, ready] = await Promise.all([list({ status: BLOCKED_STATUSES }), list({ inbox: "pending" })]);

  if (blocked.length === 0 && ready.length === 0) {
    console.log(chalk.dim("inbox: nothing awaiting an operator decision"));
    return 0;
  }
  if (blocked.length > 0) {
    console.log(chalk.bold(`NEEDS INPUT (${blocked.length})`));
    for (const r of blocked) {
      console.log(
        `  ${chalk.cyan(r.runId)}  ${titleOf(r)} ${chalk.yellow(`· ${r.runStatus ?? "?"}`)} ${chalk.dim(`→ fragua runs ${blockedVerb(r.runStatus)}`)}`,
      );
    }
  }
  if (ready.length > 0) {
    console.log(chalk.bold(`READY TO LAND (${ready.length})`));
    for (const r of ready) {
      console.log(
        `  ${chalk.cyan(r.runId)}  ${titleOf(r)}${changeBadge(r)} ${chalk.dim("→ fragua runs accept|discard")}`,
      );
    }
  }
  return 0;
}

export interface RespondOptions extends DiscoveryOpts {
  runId: string;
  route?: string;
  note?: string;
}

/** Respond to a `paused_human` HITL gate. With `--route` it posts directly
 * (scriptable); without, it shows the gate prompt + routes and reads a choice
 * from stdin (interactive). */
export async function respondCommand(opts: RespondOptions): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const detailRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(opts.runId)}`);
  if (!detailRes.ok) return failResponse("respond", detailRes);
  const detail = (await detailRes.json()) as { runStatus?: string; hitlLabel?: string; hitlOptions?: string[] };
  if (detail.runStatus !== "paused_human") {
    console.error(chalk.red(`respond: run is not at a HITL gate (status=${detail.runStatus ?? "?"})`));
    return 1;
  }
  const routes = detail.hitlOptions ?? [];
  let route = opts.route;
  if (route == null) {
    console.log(detail.hitlLabel ?? "(needs input)");
    for (let i = 0; i < routes.length; i++) console.log(`  [${i + 1}] ${routes[i]}`);
    const ans = (globalThis.prompt?.(`Choose [1-${routes.length}]:`) ?? "").trim();
    const idx = Number.parseInt(ans, 10) - 1;
    if (!(idx >= 0 && idx < routes.length)) {
      console.error(chalk.red("respond: invalid choice (pass --route to script it)"));
      return 1;
    }
    route = routes[idx];
  } else if (routes.length > 0 && !routes.includes(route)) {
    console.error(chalk.red(`respond: unknown route "${route}" (expected one of: ${routes.join(", ")})`));
    return 1;
  }
  const body: { route: string; note?: string } = { route: route! };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return postAction("human", opts.runId, body, opts);
}

export interface ResumeOptions extends DiscoveryOpts {
  runId: string;
  note?: string;
}

export function resumeCommand(opts: ResumeOptions): Promise<number> {
  const body: { note?: string } = {};
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return postAction("resume", opts.runId, body, opts);
}

export interface CancelOptions extends DiscoveryOpts {
  runId: string;
  reason?: string;
}

export function cancelCommand(opts: CancelOptions): Promise<number> {
  const body: { reason?: string } = {};
  if (opts.reason != null && opts.reason.length > 0) body.reason = opts.reason;
  return postAction("cancel", opts.runId, body, opts);
}

export interface UnquarantineOptions extends DiscoveryOpts {
  runId: string;
  resolution?: string;
  note?: string;
}

export function unquarantineCommand(opts: UnquarantineOptions): Promise<number> {
  const r = opts.resolution;
  if (r !== "treat_as_done" && r !== "retry" && r !== "cancel") {
    console.error(chalk.red("unquarantine: --resolution treat_as_done|retry|cancel required"));
    return Promise.resolve(1);
  }
  const body: { resolution: string; note?: string } = { resolution: r };
  if (opts.note != null && opts.note.length > 0) body.note = opts.note;
  return postAction("unquarantine", opts.runId, body, opts);
}

export interface LsOptions extends DiscoveryOpts {
  status?: string;
  limit?: number;
}

/** List runs (optionally filtered by lifecycle status). */
export async function lsCommand(opts: LsOptions): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const params = new URLSearchParams({ cwd });
  if (opts.status != null && opts.status.length > 0) params.set("status", opts.status);
  params.set("limit", String(opts.limit ?? 30));
  const res = await fetch(`${baseUrl}/runs?${params.toString()}`);
  if (!res.ok) return failResponse("ls", res);
  const rows = (await res.json()) as Array<InboxRunRow & { status?: string }>;
  if (rows.length === 0) {
    console.log(chalk.dim("ls: no runs"));
    return 0;
  }
  for (const r of rows) {
    console.log(`${chalk.cyan(r.runId)}  ${chalk.dim((r.runStatus ?? r.status ?? "?").padEnd(13))} ${titleOf(r)}`);
  }
  return 0;
}

export interface DiffOptions extends DiscoveryOpts {
  runId: string;
  against?: string;
  snap?: number;
}

export async function diffCommand(opts: DiffOptions): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const listRes = await fetch(`${baseUrl}/runs/${encodeURIComponent(opts.runId)}/snapshots`);
  if (!listRes.ok) return failResponse("diff", listRes);
  const snapshots = (await listRes.json()) as SnapshotRow[];
  if (snapshots.length === 0) {
    console.error(chalk.yellow(`diff: run ${opts.runId} has no snapshots (bare-cwd or no worktree)`));
    return 1;
  }
  const eventIdx = opts.snap ?? snapshots[snapshots.length - 1]!.eventIdx;
  const against = opts.against ?? "base";
  const url = `${baseUrl}/runs/${encodeURIComponent(opts.runId)}/snapshots/${eventIdx}/diff?against=${encodeURIComponent(against)}`;
  const diffRes = await fetch(url);
  if (!diffRes.ok) return failResponse("diff", diffRes);
  const text = await diffRes.text();
  if (text.trim() === "") {
    console.log(chalk.dim(`(no changes vs ${against})`));
    return 0;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}
