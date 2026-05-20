// `swarm {branch,commit,merge,discard,diff}` — operator post-run
// primitives over the HTTP surface (docs/proposals/worktrees.md §7).
//
// branch/commit/merge/discard POST the post-terminal operator-action
// intents the daemon sweep folds into git mutations; the server validates
// synchronously and returns a 4xx the CLI surfaces verbatim. `diff` is a
// read over the snapshot endpoints. Harness discovery mirrors `swarm run`:
//   1. --url   2. <cwd>/.swarm/serve.json (or <db-dir>/serve.json with --db)
//   3. ~/.swarm/swarm.db daemon_lock.http_url   4. http://localhost:3000

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@swarm/store";
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
    : resolve(cwd, ".swarm/serve.json");
  const harnessDbPath = resolve(homedir(), ".swarm/swarm.db");
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
  const { seq } = (await res.json()) as { seq?: number };
  console.log(chalk.green(`${verb} requested`) + chalk.dim(` (run ${runId}, intent seq ${seq})`));
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

export interface BranchOptions extends DiscoveryOpts {
  runId: string;
  branch: string;
  force?: boolean;
}

export function branchCommand(opts: BranchOptions): Promise<number> {
  const body: { branch: string; force?: boolean } = { branch: opts.branch };
  if (opts.force === true) body.force = true;
  return postAction("branch", opts.runId, body, opts);
}

export interface CommitOptions extends DiscoveryOpts {
  runId: string;
  message?: string;
  onto?: string;
}

export function commitCommand(opts: CommitOptions): Promise<number> {
  if (opts.message == null || opts.message.length === 0) {
    console.error(chalk.red("commit: -m/--message required"));
    return Promise.resolve(1);
  }
  const body: { message: string; onto?: string } = { message: opts.message };
  if (opts.onto != null && opts.onto.length > 0) body.onto = opts.onto;
  return postAction("commit", opts.runId, body, opts);
}

export interface MergeOptions extends DiscoveryOpts {
  runId: string;
  noFf?: boolean;
  squash?: boolean;
  into?: string;
}

export function mergeCommand(opts: MergeOptions): Promise<number> {
  if (opts.noFf === true && opts.squash === true) {
    console.error(chalk.red("merge: --no-ff and --squash are mutually exclusive"));
    return Promise.resolve(1);
  }
  // --ff-only is the implicit default; only a flag changes the mode.
  const mode = opts.squash === true ? "squash" : opts.noFf === true ? "no-ff" : "ff";
  const body: { mode: "ff" | "no-ff" | "squash"; into?: string } = { mode };
  if (opts.into != null && opts.into.length > 0) body.into = opts.into;
  return postAction("merge", opts.runId, body, opts);
}

export interface DiscardOptions extends DiscoveryOpts {
  runId: string;
}

export function discardCommand(opts: DiscardOptions): Promise<number> {
  return postAction("discard", opts.runId, {}, opts);
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

export async function inboxCommand(opts: InboxOptions): Promise<number> {
  const baseUrl = await resolveBaseUrl(opts);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const params = new URLSearchParams({ inbox: "pending", order: "oldest", cwd });
  if (opts.limit != null) params.set("limit", String(opts.limit));
  const res = await fetch(`${baseUrl}/runs?${params.toString()}`);
  if (!res.ok) return failResponse("inbox", res);
  const rows = (await res.json()) as InboxRunRow[];
  if (rows.length === 0) {
    console.log(chalk.dim("inbox: no runs awaiting an operator decision"));
    return 0;
  }
  for (const r of rows) {
    const stat = r.changeStat?.committed ?? r.changeStat?.uncommitted ?? null;
    const counts = stat
      ? ` ${chalk.dim(`(${stat.filesChanged} files, `)}${chalk.green(`+${stat.insertions}`)}${chalk.dim(" / ")}${chalk.red(`−${stat.deletions}`)}${chalk.dim(")")}`
      : "";
    const title = r.title != null && r.title.length > 0 ? r.title : chalk.dim("(untitled)");
    console.log(`${chalk.cyan(r.runId)}  ${title}${counts}`);
  }
  console.log(chalk.dim(`\n${rows.length} run(s) — act with: swarm branch|commit|merge|discard <runId>`));
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
