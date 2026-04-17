// `swarm list` — show recent runs found under .swarm/runs/.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonlEvents } from "@swarm/events";
import chalk from "chalk";

export interface ListCommandOptions {
  runsDir?: string;
  limit?: number;
  cwd?: string;
}

export async function listCommand(opts: ListCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const runsDir = resolve(cwd, opts.runsDir ?? ".swarm/runs");
  const limit = opts.limit ?? 20;

  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    console.log(chalk.dim(`no runs found in ${runsDir}`));
    return 0;
  }

  const rows: Array<{ id: string; mtime: number; status: string; nodes: number; failed: string[] }> = [];
  for (const id of entries) {
    const dir = join(runsDir, id);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const eventsPath = join(dir, "events.jsonl");
    let status = "?";
    let nodes = 0;
    const failed: string[] = [];
    try {
      const events = await readJsonlEvents(eventsPath);
      for (const e of events) {
        if (e.type === "pipeline.completed") status = "success";
        else if (e.type === "pipeline.failed") status = "fail";
        else if (e.type === "node.started") nodes++;
        else if (e.type === "node.completed") {
          const outcome = (e.data as { outcome?: { status?: string } }).outcome;
          if (outcome?.status === "fail" && e.node_id) failed.push(e.node_id);
        }
      }
    } catch {
      continue;
    }
    const st = await stat(eventsPath).catch(() => undefined);
    rows.push({ id, mtime: st?.mtimeMs ?? 0, status, nodes, failed });
  }

  rows.sort((a, b) => b.mtime - a.mtime);
  const shown = rows.slice(0, limit);
  if (shown.length === 0) {
    console.log(chalk.dim("no runs found"));
    return 0;
  }

  const col = (w: number, s: string): string => (s.length >= w ? s : s + " ".repeat(w - s.length));
  console.log(chalk.bold(`${col(30, "run_id")}  ${col(8, "status")}  ${col(6, "nodes")}  failures`));
  for (const r of shown) {
    const statusFmt =
      r.status === "success"
        ? chalk.green(col(8, r.status))
        : r.status === "fail"
          ? chalk.red(col(8, r.status))
          : chalk.dim(col(8, r.status));
    const fails = r.failed.length > 0 ? chalk.red(r.failed.join(", ")) : chalk.dim("-");
    console.log(`${chalk.dim(col(30, r.id))}  ${statusFmt}  ${col(6, String(r.nodes))}  ${fails}`);
  }
  if (rows.length > shown.length) {
    console.log(chalk.dim(`\n(${rows.length - shown.length} older runs hidden — pass --limit=<n>)`));
  }
  return 0;
}
