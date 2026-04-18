// One-off backfill: append a synthetic `pipeline.failed` / `pipeline.canceled`
// / `pipeline.completed` event to a run's `events.jsonl` when the worker died
// before emitting one. Without a terminal event the /pipelines reducer derives
// status="running" in perpetuity even though the job queue already marked the
// row terminal.
//
// Matches the job-queue status → event-type one-for-one:
//   failed   → pipeline.failed
//   canceled → pipeline.canceled
//   success  → pipeline.completed
//
// Idempotent: skips runs whose events.jsonl already carries any of those three
// events. Append-only: never rewrites existing lines. The synthetic event
// carries `cause: "backfill"` on its `data` block so it's distinguishable from
// a real terminal emission.
//
// Usage:
//   bun run scripts/backfill-terminal-events.ts <runId> [<runId> ...] [--dry-run]
//   bun run scripts/backfill-terminal-events.ts --all [--dry-run]
//
// Reads job status via the daemon's HTTP API (default http://localhost:3737)
// so we don't have to open the sqlite queue while the daemon holds its lock.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { appendFile } from "node:fs/promises";

interface JobRow {
  runId: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  completedAt?: string;
  error?: string;
}

const TERMINAL_EVENT_TYPES = new Set(["pipeline.completed", "pipeline.failed", "pipeline.canceled"]);

const STATUS_TO_EVENT: Record<string, "pipeline.failed" | "pipeline.canceled" | "pipeline.completed"> = {
  failed: "pipeline.failed",
  canceled: "pipeline.canceled",
  success: "pipeline.completed",
};

interface Args {
  runIds: string[];
  all: boolean;
  dryRun: boolean;
  runsDir: string;
  daemonUrl: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runIds: [],
    all: false,
    dryRun: false,
    runsDir: resolve(process.cwd(), ".swarm/runs"),
    daemonUrl: "http://localhost:3737",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--runs-dir" && argv[i + 1]) args.runsDir = resolve(process.cwd(), argv[++i]!);
    else if (a === "--daemon" && argv[i + 1]) args.daemonUrl = argv[++i]!;
    else if (a && !a.startsWith("--")) args.runIds.push(a);
  }
  return args;
}

async function fetchTerminalJobs(daemonUrl: string): Promise<Map<string, JobRow>> {
  const map = new Map<string, JobRow>();
  for (const status of ["failed", "canceled", "success"]) {
    const res = await fetch(`${daemonUrl}/jobs?status=${status}&limit=1000`);
    if (!res.ok) throw new Error(`GET /jobs?status=${status} → ${res.status}`);
    const rows = (await res.json()) as JobRow[];
    for (const row of rows) map.set(row.runId, row);
  }
  return map;
}

async function readFirstEvent(path: string): Promise<{ workflow_sha?: string } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const firstLine = raw.slice(0, raw.indexOf("\n"));
    if (!firstLine) return undefined;
    return JSON.parse(firstLine);
  } catch {
    return undefined;
  }
}

async function hasTerminalEvent(path: string): Promise<boolean> {
  const raw = await readFile(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as { type?: string };
      if (ev.type && TERMINAL_EVENT_TYPES.has(ev.type)) return true;
    } catch {
      // tolerate partial writes
    }
  }
  return false;
}

interface BackfillResult {
  runId: string;
  action: "appended" | "skipped-already-terminal" | "skipped-no-events" | "skipped-no-job" | "skipped-not-terminal";
  eventType?: string;
}

async function backfillOne(runId: string, jobs: Map<string, JobRow>, args: Args): Promise<BackfillResult> {
  const eventsPath = resolve(args.runsDir, runId, "events.jsonl");
  try {
    await stat(eventsPath);
  } catch {
    return { runId, action: "skipped-no-events" };
  }

  const job = jobs.get(runId);
  if (!job) return { runId, action: "skipped-no-job" };
  const eventType = STATUS_TO_EVENT[job.status];
  if (!eventType) return { runId, action: "skipped-not-terminal" };

  if (await hasTerminalEvent(eventsPath)) {
    return { runId, action: "skipped-already-terminal" };
  }

  const first = await readFirstEvent(eventsPath);
  const synthetic = {
    run_id: runId,
    type: eventType,
    timestamp: job.completedAt ?? new Date().toISOString(),
    workflow_sha: first?.workflow_sha ?? "",
    schema_version: 1,
    data: {
      cause: "backfill",
      ...(job.error ? { reason: job.error } : {}),
    },
  };

  if (!args.dryRun) {
    // Ensure leading newline when the file doesn't already end with one so
    // the synthetic line stays on its own row even if the prior write was
    // torn mid-line.
    const raw = await readFile(eventsPath, "utf8");
    const needsLeadingNewline = raw.length > 0 && !raw.endsWith("\n");
    await appendFile(
      eventsPath,
      `${needsLeadingNewline ? "\n" : ""}${JSON.stringify(synthetic)}\n`,
      "utf8",
    );
  }
  return { runId, action: "appended", eventType };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && args.runIds.length === 0) {
    console.error("usage: bun run scripts/backfill-terminal-events.ts <runId> [<runId> ...] [--dry-run]");
    console.error("       bun run scripts/backfill-terminal-events.ts --all [--dry-run]");
    return 2;
  }

  const jobs = await fetchTerminalJobs(args.daemonUrl);
  const targets = args.all ? [...jobs.keys()] : args.runIds;

  for (const runId of targets) {
    const result = await backfillOne(runId, jobs, args);
    const prefix = args.dryRun ? "[dry-run] " : "";
    if (result.action === "appended") {
      console.log(`${prefix}${result.runId} → appended ${result.eventType}`);
    } else {
      console.log(`${prefix}${result.runId} → ${result.action}`);
    }
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
