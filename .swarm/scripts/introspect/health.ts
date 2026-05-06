#!/usr/bin/env bun
// introspect/health.ts — operational health probes against the harness
// SQLite store. Replaces the original codergen `health` node, which
// asked a haiku to compose explicit sqlite3 queries with explicit
// thresholds — pure mechanics. Output is one JSON document on stdout,
// consumed by `synthesize` via `$health.output`.
//
// DB resolution mirrors analyze/collect.ts: prefer
// `<cwd>/.swarm/swarm.db` if it has rows, else fall back to
// `~/.swarm/swarm.db` (harness default). Read-only — no lock contention
// with the running daemon.
//
// Window: last 7 days for event-derived metrics. `run_state` is a live
// snapshot, not windowed.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PAYLOAD_CAP_BYTES = 4096;
const ROUTING_CAP_BYTES = 8192;
const NEAR_CAP_RATIO = 0.8;
const ALERT_HIT_RATE = 0.01;
const WINDOW_DAYS = 7;

type Label = "OK" | "WATCH" | "ALERT";

interface Metric {
  id: string;
  label: Label;
  value: unknown;
  note?: string;
}

function defaultStorePath(): string {
  const project = resolve(process.cwd(), ".swarm/swarm.db");
  if (existsSync(project) && projectStoreHasRuns(project)) return project;
  return resolve(homedir(), ".swarm/swarm.db");
}

function projectStoreHasRuns(path: string): boolean {
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare("SELECT 1 FROM run_state LIMIT 1").get();
      return row != null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function worstOf(labels: Label[]): Label {
  if (labels.includes("ALERT")) return "ALERT";
  if (labels.includes("WATCH")) return "WATCH";
  return "OK";
}

function runStatusDistribution(db: Database): Metric {
  const rows = db
    .prepare("SELECT status, COUNT(*) AS n FROM run_state GROUP BY status ORDER BY status")
    .all() as Array<{ status: string; n: number }>;
  const value: Record<string, number> = {};
  for (const r of rows) value[r.status] = r.n;
  return { id: "run_status_distribution", label: "OK", value };
}

function haltReasonDistribution(db: Database, sinceMs: number): Metric {
  const rows = db
    .prepare(
      `SELECT json_extract(payload, '$.reason') AS reason, COUNT(*) AS n
         FROM events
        WHERE type = 'fact.run_halted' AND ts >= ?
        GROUP BY reason
        ORDER BY n DESC`,
    )
    .all(sinceMs) as Array<{ reason: string | null; n: number }>;
  const value: Record<string, number> = {};
  for (const r of rows) value[r.reason ?? "(null)"] = r.n;
  return { id: "halt_reason_distribution", label: "OK", value };
}

function payloadSize(db: Database, sinceMs: number): Metric {
  const threshold = Math.floor(PAYLOAD_CAP_BYTES * NEAR_CAP_RATIO);
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                        AS total,
         COALESCE(MAX(length(payload)), 0)               AS max_bytes,
         COALESCE(CAST(AVG(length(payload)) AS INTEGER), 0) AS avg_bytes,
         COALESCE(SUM(CASE WHEN length(payload) >= ? THEN 1 ELSE 0 END), 0) AS near_cap_count,
         COALESCE(SUM(CASE WHEN length(payload) >= ? THEN 1 ELSE 0 END), 0) AS at_cap_count
       FROM events
       WHERE ts >= ?`,
    )
    .get(threshold, PAYLOAD_CAP_BYTES, sinceMs) as {
    total: number;
    max_bytes: number;
    avg_bytes: number;
    near_cap_count: number;
    at_cap_count: number;
  };
  const hitRate = row.total > 0 ? row.at_cap_count / row.total : 0;
  let label: Label = "OK";
  if (row.near_cap_count > 0) label = "WATCH";
  if (hitRate > ALERT_HIT_RATE) label = "ALERT";
  return {
    id: "event_payload_size",
    label,
    value: {
      ...row,
      cap_bytes: PAYLOAD_CAP_BYTES,
      near_cap_threshold_bytes: threshold,
      hit_rate: Number(hitRate.toFixed(4)),
    },
  };
}

function routingSize(db: Database): Metric {
  const threshold = Math.floor(ROUTING_CAP_BYTES * NEAR_CAP_RATIO);
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                        AS total,
         COALESCE(MAX(length(routing)), 0)               AS max_bytes,
         COALESCE(CAST(AVG(length(routing)) AS INTEGER), 0) AS avg_bytes,
         COALESCE(SUM(CASE WHEN length(routing) >= ? THEN 1 ELSE 0 END), 0) AS near_cap_count,
         COALESCE(SUM(CASE WHEN length(routing) >= ? THEN 1 ELSE 0 END), 0) AS at_cap_count
       FROM run_state`,
    )
    .get(threshold, ROUTING_CAP_BYTES) as {
    total: number;
    max_bytes: number;
    avg_bytes: number;
    near_cap_count: number;
    at_cap_count: number;
  };
  const hitRate = row.total > 0 ? row.at_cap_count / row.total : 0;
  let label: Label = "OK";
  if (row.near_cap_count > 0) label = "WATCH";
  if (hitRate > ALERT_HIT_RATE) label = "ALERT";
  return {
    id: "routing_size",
    label,
    value: {
      ...row,
      cap_bytes: ROUTING_CAP_BYTES,
      near_cap_threshold_bytes: threshold,
      hit_rate: Number(hitRate.toFixed(4)),
    },
  };
}

function eventTypeCount(db: Database, type: string, sinceMs: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE type = ? AND ts >= ?")
    .get(type, sinceMs) as { n: number };
  return row.n;
}

function handlerTimeoutLeaks(db: Database, sinceMs: number): Metric {
  const count = eventTypeCount(db, "fact.handler_timeout_leaked", sinceMs);
  return {
    id: "handler_timeout_leaks",
    label: count > 0 ? "WATCH" : "OK",
    value: { count },
  };
}

function quarantines(db: Database, sinceMs: number): Metric {
  const count = eventTypeCount(db, "fact.run_quarantined", sinceMs);
  return {
    id: "quarantines",
    label: count > 0 ? "ALERT" : "OK",
    value: { count },
  };
}

function daemonEventsByType(db: Database, sinceMs: number): Metric {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n
         FROM daemon_events
        WHERE ts >= ?
        GROUP BY type
        ORDER BY n DESC`,
    )
    .all(sinceMs) as Array<{ type: string; n: number }>;
  const value: Record<string, number> = {};
  for (const r of rows) value[r.type] = r.n;
  const reaper = value["daemon.reaper_took_over"] ?? 0;
  return {
    id: "daemon_events_by_type",
    label: reaper > 0 ? "ALERT" : "OK",
    value,
    note: reaper > 0 ? `recent reaper takeover (${reaper})` : undefined,
  };
}

const storePath = resolve(defaultStorePath());
const now = Date.now();
const sinceMs = now - WINDOW_DAYS * 86_400_000;

if (!existsSync(storePath)) {
  process.stdout.write(
    JSON.stringify(
      {
        collected_at: new Date(now).toISOString(),
        store_path: storePath,
        db_status: "missing",
        window: null,
        metrics: [],
        worst_label: "OK",
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(0);
}

const db = new Database(storePath, { readonly: true });
try {
  const hasAnyRun = db.prepare("SELECT 1 FROM run_state LIMIT 1").get() != null;
  if (!hasAnyRun) {
    process.stdout.write(
      JSON.stringify(
        {
          collected_at: new Date(now).toISOString(),
          store_path: storePath,
          db_status: "empty",
          window: null,
          metrics: [],
          worst_label: "OK",
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }

  const metrics: Metric[] = [
    runStatusDistribution(db),
    haltReasonDistribution(db, sinceMs),
    payloadSize(db, sinceMs),
    routingSize(db),
    handlerTimeoutLeaks(db, sinceMs),
    quarantines(db, sinceMs),
    daemonEventsByType(db, sinceMs),
  ];

  const snapshot = {
    collected_at: new Date(now).toISOString(),
    store_path: storePath,
    db_status: "ok" as const,
    window: {
      since_ms: sinceMs,
      since_iso: new Date(sinceMs).toISOString(),
      now_ms: now,
      now_iso: new Date(now).toISOString(),
      days: WINDOW_DAYS,
    },
    metrics,
    worst_label: worstOf(metrics.map((m) => m.label)),
  };

  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
} finally {
  db.close();
}
