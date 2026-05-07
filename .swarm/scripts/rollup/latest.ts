#!/usr/bin/env bun
// rollup/latest.ts — assemble the inputs for rollup.dot's `synthesize` node.
//
// For each "drift" workflow (structural-drift / narrative-drift / analyze),
// finds the latest terminal run in the SQLite store and pulls the final
// assistant message from the named output node. Health is a *now*-snapshot
// (operational state, not historical findings) so we shell out to
// .swarm/scripts/health/collect.ts at rollup time rather than reading a stored
// run.
//
// Output is one JSON document on stdout, consumed by `synthesize` via
// `$collect_latest.output`. Missing runs are reported as `null` entries with
// an explanatory note rather than aborts — a fresh store with no prior runs
// is a legitimate first-run state.
//
// DB resolution mirrors health/collect.ts: prefer `<cwd>/.swarm/swarm.db` if
// it has rows, else fall back to `~/.swarm/swarm.db` (harness default).
// Read-only — no lock contention with the running daemon.

import { spawnSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const TERMINAL_STATUSES = ["completed", "halted", "cancelled", "quarantined"] as const;

interface DriftTarget {
  label: string;
  node: string;
  title: string;
}

const DRIFT_TARGETS: DriftTarget[] = [
  { label: "structural-drift", node: "drift", title: "Structural drift findings" },
  { label: "narrative-drift", node: "diff", title: "Narrative drift findings" },
  { label: "analyze", node: "analyze", title: "Workflow-quality hypotheses" },
];

function defaultStorePath(): string {
  const project = resolve(process.cwd(), ".swarm/swarm.db");
  if (existsSync(project) && projectStoreHasRuns(project)) return project;
  return resolve(homedir(), ".swarm/swarm.db");
}

function projectStoreHasRuns(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db.prepare("SELECT 1 FROM run_state LIMIT 1").get() != null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

interface RunRow {
  run_id: string;
  status: string;
  updated_at: number;
  workflow_name: string | null;
  cwd: string | null;
  total_cost_usd: number;
  billed_tokens: number;
}

function latestTerminalRun(db: Database, label: string): RunRow | null {
  const placeholders = TERMINAL_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT run_id, status, updated_at, workflow_name, cwd,
              total_cost_usd, billed_tokens
         FROM run_state
        WHERE workflow_name = ?
          AND status IN (${placeholders})
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get(label, ...TERMINAL_STATUSES) as RunRow | undefined;
  return row ?? null;
}

function lastAssistantText(db: Database, runId: string, nodeId: string): string {
  const row = db
    .prepare(
      `SELECT content FROM messages
        WHERE run_id = ? AND node_id = ? AND role = 'assistant'
        ORDER BY ordinal DESC
        LIMIT 1`,
    )
    .get(runId, nodeId) as { content: string } | undefined;
  if (!row) return "";
  return extractText(row.content);
}

function extractText(messageJson: string): string {
  try {
    const m = JSON.parse(messageJson) as { content?: unknown };
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const block of c) {
        if (block && typeof block === "object") {
          const b = block as { type?: string; text?: string };
          if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        }
      }
      return parts.join("\n").trim();
    }
    return "";
  } catch {
    return "";
  }
}

function haltReason(db: Database, runId: string): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(payload, '$.reason') AS reason
         FROM events
        WHERE run_id = ? AND type = 'fact.run_halted'
        ORDER BY seq DESC
        LIMIT 1`,
    )
    .get(runId) as { reason: string | null } | undefined;
  return row?.reason ?? null;
}

interface DriftSlot {
  label: string;
  title: string;
  run: (RunRow & { halt_reason: string | null }) | null;
  output: string | null;
  note: string | null;
}

function collectDriftSlot(db: Database, t: DriftTarget): DriftSlot {
  const row = latestTerminalRun(db, t.label);
  if (!row) {
    return {
      label: t.label,
      title: t.title,
      run: null,
      output: null,
      note: `no terminal run found for workflow_name=${t.label}`,
    };
  }
  const text = lastAssistantText(db, row.run_id, t.node);
  const halt = row.status === "halted" ? haltReason(db, row.run_id) : null;
  return {
    label: t.label,
    title: t.title,
    run: { ...row, halt_reason: halt },
    output: text || null,
    note: text ? null : `run ${row.run_id} has no assistant message for node=${t.node}`,
  };
}

function snapshotHealth(): unknown {
  const script = resolve(process.cwd(), ".swarm/scripts/health/collect.ts");
  if (!existsSync(script)) {
    return {
      label: "health",
      title: "Operational health",
      error: `health collector not found at ${script}`,
    };
  }
  const proc = spawnSync("bun", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (proc.status !== 0) {
    return {
      label: "health",
      title: "Operational health",
      error: `health collector exited ${proc.status}: ${proc.stderr ?? ""}`.trim(),
    };
  }
  try {
    return {
      label: "health",
      title: "Operational health",
      snapshot: JSON.parse(proc.stdout),
    };
  } catch (err) {
    return {
      label: "health",
      title: "Operational health",
      error: `failed to parse health JSON: ${(err as Error).message}`,
    };
  }
}

const focus = process.argv.slice(2).join(" ").trim();
const storePath = resolve(defaultStorePath());
const collectedAt = new Date().toISOString();

if (!existsSync(storePath)) {
  process.stdout.write(
    JSON.stringify(
      {
        collected_at: collectedAt,
        store_path: storePath,
        db_status: "missing",
        focus: focus || null,
        drift: DRIFT_TARGETS.map((t) => ({
          label: t.label,
          title: t.title,
          run: null,
          output: null,
          note: "store missing",
        })),
        health: snapshotHealth(),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

const db = new Database(storePath, { readonly: true });
try {
  const drift = DRIFT_TARGETS.map((t) => collectDriftSlot(db, t));
  const snapshot = {
    collected_at: collectedAt,
    store_path: storePath,
    db_status: "ok" as const,
    focus: focus || null,
    drift,
    health: snapshotHealth(),
  };
  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
} finally {
  db.close();
}
