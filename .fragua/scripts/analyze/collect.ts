#!/usr/bin/env bun
// analyze collector — materialise a bounded window of the fragua store for
// introspection.
//
// Two artefacts under --out (default .fragua/scratch/analyze/):
//
//   window.db      a small SQLite copy of the window: `run_state` rows,
//                  the `workflows` sources they ran, the non-streaming events
//                  (facts, intents, cost, judge, budget, agent info/warnings,
//                  turn + tool boundaries) and `messages` METADATA with smell
//                  flags — never message content. Every number in the
//                  snapshot can be re-derived from it with `sqlite3
//                  -readonly`, which is what the workflow's `verify` step does.
//   snapshot.json  per-workflow aggregates + a trimmed per-run view, all
//                  computed by SQL over window.db.
//
// The live store is opened read-only and only ever read.
//
//   bun .fragua/scripts/analyze/collect.ts [--db PATH] [--workflow NAME]
//        [--since-days N] [--limit N] [--out DIR]

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { deserializeGraph, handlerOf } from "@fragua/core";

interface Args {
  storePath: string;
  limit: number;
  workflow: string | null;
  sinceMs: number | null;
  out: string;
}

function defaultStorePath(): string {
  const project = resolve(process.cwd(), ".fragua/fragua.db");
  if (existsSync(project) && storeHasRuns(project)) return project;
  return resolve(homedir(), ".fragua/fragua.db");
}

function storeHasRuns(path: string): boolean {
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

function parseArgs(argv: string[]): Args {
  let storePath: string | null = null;
  let limit = 200;
  let workflow: string | null = null;
  let sinceMs: number | null = Date.now() - 7 * 86400_000;
  let out = ".fragua/scratch/analyze";
  const tokens = argv.flatMap((a) => {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      return [a.slice(0, eq), a.slice(eq + 1)];
    }
    return [a];
  });
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const rawNext = tokens[i + 1];
    const next = rawNext !== undefined && !rawNext.startsWith("--") ? rawNext : undefined;
    if (a === "--db" && next) {
      storePath = next;
      i++;
    } else if (a === "--limit" && next) {
      limit = Number(next);
      i++;
    } else if (a === "--workflow" && next) {
      workflow = next;
      i++;
    } else if (a === "--since-days" && next) {
      sinceMs = Date.now() - Number(next) * 86400_000;
      i++;
    } else if (a === "--out" && next) {
      out = next;
      i++;
    } else if (a === "--no-since") {
      sinceMs = null;
    }
  }
  // The engine single-quotes substituted values; a call site that adds its
  // own quotes hands them through. An empty value under any quoting means
  // "no filter".
  if (workflow !== null) {
    const m = workflow.match(/^(['"])(.*)\1$/);
    if (m) workflow = m[2] ?? "";
    if (workflow === "") workflow = null;
  }
  return { storePath: resolve(storePath ?? defaultStorePath()), limit, workflow, sinceMs, out: resolve(out) };
}

// ─────────────────────────── window.db ───────────────────────────

// Streaming deltas (`llm.text_delta`, `llm.thinking_delta`, message
// start/end, `fact.message_appended`) are the bulk of the log and carry no
// introspection signal; everything else is copied verbatim.
const EVENT_TYPE_PREFIXES = ["fact.", "intent.", "judge.", "budget.", "edge."];
const EVENT_TYPES = [
  "cost.recorded",
  "agent.info",
  "agent.warning",
  "agent.start",
  "agent.end",
  "agent.turn_start",
  "agent.turn_end",
  "llm.start",
  "tool.execution_start",
  "tool.execution_end",
];
const EXCLUDED_EVENT_TYPES = ["fact.message_appended"];

const RUN_STATE_COLUMNS = [
  "run_id",
  "status",
  "current_node",
  "workflow_sha",
  "contract_version",
  "metrics",
  "priority",
  "enqueued_at",
  "node_started_at",
  "dispatch_started_at",
  "updated_at",
  "title",
  "cwd",
  "project_id",
  "project_name",
  "workflow_name",
  "workflow_scope",
  "base_git_ref",
  "final_head_ref",
  "change_stat",
  "inbox_status",
  "accepted_sha",
  "schedule_id",
  "in_checkout",
] as const;

const WINDOW_SCHEMA = `
CREATE TABLE run_state (
  ${RUN_STATE_COLUMNS.map((c) => `${c} ANY`).join(",\n  ")},
  PRIMARY KEY (run_id)
);
CREATE TABLE workflows (sha TEXT PRIMARY KEY, name TEXT, source TEXT, ir TEXT);
CREATE TABLE events (
  run_id TEXT, seq INTEGER, type TEXT, writer TEXT, payload TEXT, ts INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE messages (
  run_id TEXT, ordinal INTEGER, node_id TEXT, iteration INTEGER, pass INTEGER,
  role TEXT, bytes INTEGER,
  emit_reminder INTEGER, abort_call INTEGER, route_call INTEGER, emit_output_call INTEGER,
  PRIMARY KEY (run_id, ordinal)
);
`;

const WINDOW_INDEXES = `
CREATE INDEX idx_events_run_type ON events(run_id, type);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_messages_run_node ON messages(run_id, node_id);
`;

interface RunRow {
  run_id: string;
  workflow_sha: string;
  updated_at: number;
}

function selectWindowRuns(live: Database, args: Args): RunRow[] {
  const filters: string[] = [];
  const params: Record<string, string | number> = {};
  if (args.workflow) {
    filters.push("rs.workflow_name = $workflow");
    params.$workflow = args.workflow;
  }
  if (args.sinceMs !== null) {
    filters.push("rs.updated_at >= $since");
    params.$since = args.sinceMs;
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  return live
    .prepare(
      `SELECT rs.run_id, rs.workflow_sha, rs.updated_at
       FROM run_state rs ${where}
       ORDER BY rs.updated_at DESC LIMIT $limit`,
    )
    .all({ ...params, $limit: args.limit }) as RunRow[];
}

function buildWindowDb(live: Database, runs: RunRow[], path: string): Database {
  rmSync(path, { force: true });
  rmSync(`${path}-journal`, { force: true });
  const win = new Database(path, { create: true });
  win.exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  win.exec(WINDOW_SCHEMA);

  const cols = RUN_STATE_COLUMNS.join(", ");
  const selectRun = live.prepare(`SELECT ${cols} FROM run_state WHERE run_id = ?`);
  const insertRun = win.prepare(
    `INSERT INTO run_state (${cols}) VALUES (${RUN_STATE_COLUMNS.map((c) => `$${c}`).join(", ")})`,
  );
  const selectWorkflow = live.prepare("SELECT sha, name, source, ir FROM workflows WHERE sha = ?");
  const insertWorkflow = win.prepare("INSERT OR IGNORE INTO workflows (sha, name, source, ir) VALUES (?, ?, ?, ?)");

  const typeClauses = [
    ...EVENT_TYPE_PREFIXES.map((p) => `type LIKE '${p}%'`),
    `type IN (${EVENT_TYPES.map((t) => `'${t}'`).join(", ")})`,
  ];
  const selectEvents = live.prepare(
    `SELECT run_id, seq, type, writer, payload, ts FROM events
     WHERE run_id = ? AND (${typeClauses.join(" OR ")})
       AND type NOT IN (${EXCLUDED_EVENT_TYPES.map((t) => `'${t}'`).join(", ")})
     ORDER BY seq`,
  );
  const insertEvent = win.prepare(
    "INSERT INTO events (run_id, seq, type, writer, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Flags are substring tests over the serialised AgentMessage: cheap, and
  // the content itself never leaves the live store.
  const selectMessages = live.prepare(
    `SELECT run_id, ordinal, node_id, iteration, pass,
            json_extract(content, '$.role') AS role,
            length(content) AS bytes,
            instr(content, 'You ended your turn without calling') > 0 AS emit_reminder,
            instr(content, '"name":"abort"') > 0 AS abort_call,
            instr(content, '"name":"route"') > 0 AS route_call,
            instr(content, '"name":"emit_output"') > 0 AS emit_output_call
     FROM messages WHERE run_id = ? ORDER BY ordinal`,
  );
  const insertMessage = win.prepare(
    `INSERT INTO messages (run_id, ordinal, node_id, iteration, pass, role, bytes,
       emit_reminder, abort_call, route_call, emit_output_call)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const copyRun = win.transaction((run: RunRow) => {
    const row = selectRun.get(run.run_id) as Record<string, unknown> | null;
    if (row == null) return;
    const bound: Record<string, unknown> = {};
    for (const c of RUN_STATE_COLUMNS) bound[`$${c}`] = row[c] ?? null;
    insertRun.run(bound as never);
    const wf = selectWorkflow.get(run.workflow_sha) as { sha: string; name: string; source: string; ir: string } | null;
    if (wf != null) insertWorkflow.run(wf.sha, wf.name, wf.source, wf.ir);
    for (const e of selectEvents.all(run.run_id) as Array<Record<string, unknown>>) {
      insertEvent.run(
        e.run_id as string,
        e.seq as number,
        e.type as string,
        (e.writer as string | null) ?? null,
        e.payload as string,
        e.ts as number,
      );
    }
    for (const m of selectMessages.all(run.run_id) as Array<Record<string, unknown>>) {
      insertMessage.run(
        m.run_id as string,
        m.ordinal as number,
        (m.node_id as string | null) ?? null,
        (m.iteration as number | null) ?? null,
        (m.pass as number | null) ?? null,
        (m.role as string | null) ?? null,
        m.bytes as number,
        m.emit_reminder as number,
        m.abort_call as number,
        m.route_call as number,
        m.emit_output_call as number,
      );
    }
  });
  for (const run of runs) copyRun(run);
  win.exec(WINDOW_INDEXES);
  return win;
}

// ─────────────────────────── aggregates (SQL over window.db) ───────────────────────────

// Terminal status per run, folding the v4+ `fact.run_terminated{status,
// reason}` and the legacy per-status facts into one row.
const TERMINAL_VIEW = `
CREATE TEMP TABLE terminal AS
SELECT run_id, seq, ts,
  CASE type
    WHEN 'fact.run_terminated' THEN json_extract(payload, '$.status')
    WHEN 'fact.run_completed'  THEN 'completed'
    WHEN 'fact.run_halted'     THEN 'errored'
    WHEN 'fact.run_cancelled'  THEN 'aborted'
    WHEN 'fact.run_quarantined' THEN 'quarantined'
  END AS status,
  json_extract(payload, '$.reason') AS reason
FROM events
WHERE type IN ('fact.run_terminated','fact.run_completed','fact.run_halted','fact.run_cancelled','fact.run_quarantined')
  AND seq = (SELECT MAX(seq) FROM events e2 WHERE e2.run_id = events.run_id
             AND e2.type IN ('fact.run_terminated','fact.run_completed','fact.run_halted','fact.run_cancelled','fact.run_quarantined'));
`;

// Each pause paired with the next resume of the same run; `seconds` is the
// time the run sat parked for that reason (open pauses count to now).
const PAUSE_VIEW = `
CREATE TEMP TABLE pauses AS
SELECT p.run_id, p.seq, json_extract(p.payload, '$.reason') AS reason,
  json_extract(p.payload, '$.nodeId') AS node_id,
  (COALESCE((SELECT MIN(r.ts) FROM events r WHERE r.run_id = p.run_id AND r.type = 'fact.run_resumed' AND r.seq > p.seq),
            CAST(strftime('%s','now') AS INTEGER) * 1000) - p.ts) / 1000.0 AS seconds
FROM events p WHERE p.type = 'fact.run_paused';
`;

// One row per dispatch: how it was entered (`resume_of`), how it ended
// (the next node_completed / node_aborted for the same node), and its wall
// time. A dispatch still open has end_type NULL.
const DISPATCH_VIEW = `
CREATE TEMP TABLE dispatches AS
SELECT d.run_id, d.seq, d.ts,
  json_extract(d.payload, '$.nodeId') AS node_id,
  json_extract(d.payload, '$.iteration') AS iteration,
  COALESCE(json_extract(d.payload, '$.pass'), 0) AS pass,
  json_extract(d.payload, '$.resumeOf') AS resume_of,
  e.type AS end_type,
  json_extract(e.payload, '$.cause') AS abort_cause,
  COALESCE(json_extract(e.payload, '$.partialCostUsd'), 0) AS partial_cost_usd,
  CASE WHEN e.ts IS NULL THEN NULL ELSE (e.ts - d.ts) / 1000.0 END AS wall_seconds
FROM events d
LEFT JOIN events e ON e.run_id = d.run_id AND e.seq = (
  SELECT MIN(x.seq) FROM events x
  WHERE x.run_id = d.run_id AND x.seq > d.seq
    AND x.type IN ('fact.node_completed','fact.node_aborted')
    AND json_extract(x.payload, '$.nodeId') = json_extract(d.payload, '$.nodeId'))
WHERE d.type = 'fact.dispatch_started';
`;

// Per-node per-run cost and token attribution from cost.recorded.
const NODE_COST_VIEW = `
CREATE TEMP TABLE node_cost AS
SELECT run_id, json_extract(payload, '$.nodeId') AS node_id,
  SUM(COALESCE(json_extract(payload, '$.cost_usd'), 0)) AS cost_usd,
  SUM(COALESCE(json_extract(payload, '$.input_tokens'), 0) + COALESCE(json_extract(payload, '$.output_tokens'), 0)) AS fresh_tokens,
  SUM(COALESCE(json_extract(payload, '$.output_tokens'), 0)) AS output_tokens,
  SUM(COALESCE(json_extract(payload, '$.cache_read_tokens'), 0)) AS cache_read_tokens,
  SUM(COALESCE(json_extract(payload, '$.cache_write_tokens'), 0)) AS cache_write_tokens,
  COUNT(*) AS llm_calls
FROM events WHERE type = 'cost.recorded' AND json_extract(payload, '$.nodeId') IS NOT NULL
GROUP BY run_id, node_id;
`;

// Sequential pairing of start/end boundaries per (run, node) through row
// numbers — iteration is not a key (a retarget re-runs a node at the same
// iteration), order is.
const SPAN_VIEWS = `
CREATE TEMP TABLE node_spans AS
WITH s AS (
  SELECT run_id, json_extract(payload, '$.nodeId') AS node_id, ts,
    ROW_NUMBER() OVER (PARTITION BY run_id, json_extract(payload, '$.nodeId') ORDER BY seq) AS k
  FROM events WHERE type = 'fact.node_started'),
e AS (
  SELECT run_id, json_extract(payload, '$.nodeId') AS node_id, ts,
    ROW_NUMBER() OVER (PARTITION BY run_id, json_extract(payload, '$.nodeId') ORDER BY seq) AS k
  FROM events WHERE type = 'fact.node_completed')
SELECT s.run_id, s.node_id, SUM(MAX(0, e.ts - s.ts)) / 1000.0 AS wall_seconds, COUNT(*) AS completions
FROM s JOIN e ON e.run_id = s.run_id AND e.node_id = s.node_id AND e.k = s.k
GROUP BY s.run_id, s.node_id;

CREATE TEMP TABLE turn_spans AS
WITH s AS (
  SELECT run_id, json_extract(payload, '$.nodeId') AS node_id, ts,
    ROW_NUMBER() OVER (PARTITION BY run_id, json_extract(payload, '$.nodeId') ORDER BY seq) AS k
  FROM events WHERE type = 'agent.turn_start'),
e AS (
  SELECT run_id, json_extract(payload, '$.nodeId') AS node_id, ts,
    ROW_NUMBER() OVER (PARTITION BY run_id, json_extract(payload, '$.nodeId') ORDER BY seq) AS k
  FROM events WHERE type = 'agent.turn_end')
SELECT s.run_id, s.node_id, SUM(MAX(0, e.ts - s.ts)) / 1000.0 AS llm_seconds, COUNT(*) AS turns
FROM s JOIN e ON e.run_id = s.run_id AND e.node_id = s.node_id AND e.k = s.k
GROUP BY s.run_id, s.node_id;

CREATE TEMP TABLE tool_calls AS
SELECT s.run_id, json_extract(s.payload, '$.nodeId') AS node_id,
  json_extract(s.payload, '$.tool_name') AS tool,
  COALESCE(json_extract(e.payload, '$.is_error'), 0) AS is_error,
  CASE WHEN e.ts IS NULL THEN 0 ELSE MAX(0, e.ts - s.ts) END / 1000.0 AS seconds
FROM events s
LEFT JOIN events e ON e.run_id = s.run_id AND e.type = 'tool.execution_end'
  AND json_extract(e.payload, '$.tool_call_id') = json_extract(s.payload, '$.tool_call_id')
WHERE s.type = 'tool.execution_start' AND json_extract(s.payload, '$.tool_name') IS NOT NULL;
`;

// Judge answers flattened to one row per (run, node, question).
const JUDGE_VIEW = `
CREATE TEMP TABLE judge_answers AS
SELECT e.run_id, json_extract(e.payload, '$.nodeId') AS node_id, q.key AS question,
  json_extract(q.value, '$.type') AS kind,
  json_extract(q.value, '$.noul') AS noul,
  json_extract(q.value, '$.confidence') AS confidence,
  json_extract(e.payload, '$.decision.status') AS decision_status,
  json_extract(e.payload, '$.decision.route') AS decision_route
FROM events e, json_each(json_extract(e.payload, '$.answers')) q
WHERE e.type = 'judge.answered';
`;

const DERIVED_INDEXES = `
CREATE INDEX idx_t_terminal ON terminal(run_id);
CREATE INDEX idx_t_pauses ON pauses(run_id);
CREATE INDEX idx_t_dispatches ON dispatches(run_id, node_id, seq);
CREATE INDEX idx_t_node_cost ON node_cost(run_id, node_id);
CREATE INDEX idx_t_node_spans ON node_spans(run_id, node_id);
CREATE INDEX idx_t_turn_spans ON turn_spans(run_id, node_id);
CREATE INDEX idx_t_tool_calls ON tool_calls(run_id, node_id);
CREATE INDEX idx_t_judge ON judge_answers(run_id);
`;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function round(n: number, d = 4): number {
  return Number(n.toFixed(d));
}

function countsBy(rows: Array<{ k: string | null; n: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k ?? "unknown"] = r.n;
  return out;
}

type Row = Record<string, unknown>;

function q(db: Database, sql: string, ...params: Array<string | number>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function one(db: Database, sql: string, ...params: Array<string | number>): Row {
  return (db.prepare(sql).get(...params) as Row | null) ?? {};
}

const handlerTypesByWorkflowSha = new Map<string, Map<string, string>>();
function handlerTypesFor(sha: string, ir: string | null): Map<string, string> {
  const cached = handlerTypesByWorkflowSha.get(sha);
  if (cached) return cached;
  const map = new Map<string, string>();
  if (ir != null) {
    try {
      const graph = deserializeGraph(ir);
      for (const [id, node] of Object.entries(graph.nodes)) map.set(id, handlerOf(node));
    } catch {
      // unparseable IR → node_type null downstream
    }
  }
  handlerTypesByWorkflowSha.set(sha, map);
  return map;
}

function workflowAggregate(win: Database, workflow: string): Row {
  const runIds = q(win, "SELECT run_id FROM run_state WHERE COALESCE(workflow_name, '(unnamed)') = ?", workflow).map(
    (r) => r.run_id as string,
  );
  const inList = runIds.map((id) => `'${id}'`).join(", ");
  const W = `run_id IN (${inList})`;

  const costs = q(win, `SELECT json_extract(metrics,'$.totalCostUsd') AS c FROM run_state WHERE ${W}`)
    .map((r) => Number(r.c ?? 0))
    .sort((a, b) => a - b);
  const tokens = q(win, `SELECT json_extract(metrics,'$.billedTokens') AS t FROM run_state WHERE ${W}`)
    .map((r) => Number(r.t ?? 0))
    .sort((a, b) => a - b);
  const durations = q(
    win,
    `SELECT (COALESCE((SELECT ts FROM terminal t WHERE t.run_id = rs.run_id), rs.updated_at) - rs.enqueued_at) / 1000.0 AS d
     FROM run_state rs WHERE ${W}`,
  )
    .map((r) => Number(r.d ?? 0))
    .sort((a, b) => a - b);

  const versions = q(
    win,
    `SELECT substr(workflow_sha, 1, 8) AS sha8, COUNT(*) AS n_runs,
            datetime(MIN(enqueued_at) / 1000, 'unixepoch') AS first_seen,
            datetime(MAX(enqueued_at) / 1000, 'unixepoch') AS last_seen
     FROM run_state WHERE ${W} GROUP BY workflow_sha ORDER BY MIN(enqueued_at)`,
  );

  const outcome = one(
    win,
    `SELECT
       SUM(inbox_status = 'acted') AS acted,
       SUM(inbox_status = 'discarded') AS discarded,
       SUM(inbox_status = 'pending') AS pending,
       SUM(inbox_status IS NULL) AS no_inbox,
       SUM(CASE WHEN inbox_status = 'discarded' THEN json_extract(metrics,'$.totalCostUsd') ELSE 0 END) AS cost_discarded_usd,
       SUM(CASE WHEN inbox_status = 'acted' THEN json_extract(metrics,'$.totalCostUsd') ELSE 0 END) AS cost_acted_usd
     FROM run_state WHERE ${W}`,
  );
  const hoursToAction = q(
    win,
    `SELECT (a.ts - t.ts) / 3600000.0 AS h
     FROM events a JOIN terminal t ON t.run_id = a.run_id
     WHERE a.type IN ('fact.run_accepted','fact.run_discarded') AND a.${W}`,
  )
    .map((r) => Number(r.h))
    .filter((h) => h >= 0)
    .sort((a, b) => a - b);

  const pausesByReason = q(
    win,
    `SELECT reason AS k, COUNT(*) AS n, SUM(seconds) AS seconds, MAX(seconds) AS max_seconds
     FROM pauses WHERE ${W} GROUP BY reason ORDER BY n DESC`,
  );
  const providerRetries = one(
    win,
    `SELECT COUNT(*) AS n, SUM(json_extract(payload,'$.delayMs')) / 1000.0 AS delay_seconds_sum,
            MAX(json_extract(payload,'$.delayMs')) / 1000.0 AS max_delay_seconds
     FROM events WHERE type = 'fact.provider_retry_attempted' AND ${W}`,
  );
  const resumeOf = countsBy(
    q(win, `SELECT resume_of AS k, COUNT(*) AS n FROM dispatches WHERE ${W} GROUP BY resume_of`) as Array<{
      k: string | null;
      n: number;
    }>,
  );
  // The post-pause pathology: a resumed dispatch that ends in a fraction of
  // the time its predecessor on the same node ran before the pause.
  const shortResumes = q(
    win,
    `SELECT d.run_id, d.node_id, d.resume_of, d.wall_seconds AS resumed_seconds,
            p.wall_seconds AS prior_seconds, p.abort_cause AS prior_abort
     FROM dispatches d
     JOIN dispatches p ON p.run_id = d.run_id AND p.node_id = d.node_id
       AND p.seq = (SELECT MAX(x.seq) FROM dispatches x WHERE x.run_id = d.run_id AND x.node_id = d.node_id AND x.seq < d.seq)
     WHERE d.${W} AND d.resume_of IN ('paused','paused_auto','paused_human','crash')
       AND d.wall_seconds IS NOT NULL AND p.wall_seconds IS NOT NULL
       AND p.wall_seconds >= 600 AND d.wall_seconds < p.wall_seconds * 0.1
     ORDER BY p.wall_seconds DESC LIMIT 10`,
  );

  const terminal = countsBy(
    q(
      win,
      `SELECT status || CASE WHEN reason IS NULL THEN '' ELSE ':' || reason END AS k, COUNT(*) AS n
       FROM terminal WHERE ${W} GROUP BY k`,
    ) as Array<{ k: string | null; n: number }>,
  );
  const statusCounts = countsBy(
    q(win, `SELECT status AS k, COUNT(*) AS n FROM run_state WHERE ${W} GROUP BY status`) as Array<{
      k: string | null;
      n: number;
    }>,
  );
  const aborts = q(
    win,
    `SELECT json_extract(payload,'$.cause') AS cause, json_extract(payload,'$.nodeId') AS node_id,
            COUNT(*) AS n, SUM(COALESCE(json_extract(payload,'$.partialCostUsd'),0)) AS wasted_cost_usd
     FROM events WHERE type = 'fact.node_aborted' AND ${W} GROUP BY cause, node_id ORDER BY n DESC`,
  );
  const crashes = one(
    win,
    `SELECT SUM(type = 'fact.run_requeued_after_crash') AS requeued_after_crash,
            SUM(type = 'fact.handler_timeout_leaked') AS handler_timeout_leaked,
            SUM(type = 'budget.stop') AS budget_stops,
            SUM(type = 'budget.warn') AS budget_warns,
            SUM(type = 'intent.steering_requested') AS steers,
            SUM(type = 'intent.cancel_requested') AS cancels,
            SUM(type = 'intent.budget_adjusted') AS budget_raises,
            SUM(type = 'intent.goal_gate_adjusted') AS goal_gate_raises,
            SUM(type = 'intent.human_input') AS human_inputs
     FROM events WHERE ${W}`,
  );
  const reminders = q(
    win,
    `SELECT node_id, SUM(emit_reminder) AS reminders, SUM(abort_call) AS abort_calls,
            COUNT(DISTINCT run_id) AS runs
     FROM messages WHERE ${W} AND role IN ('user','assistant') GROUP BY node_id
     HAVING SUM(emit_reminder) > 0 OR SUM(abort_call) > 0 ORDER BY reminders DESC`,
  );
  const routes = q(
    win,
    `SELECT json_extract(payload,'$.nodeId') AS node_id, json_extract(payload,'$.route') AS route, COUNT(*) AS n
     FROM events WHERE type = 'fact.node_completed' AND json_extract(payload,'$.route') IS NOT NULL AND ${W}
     GROUP BY node_id, route ORDER BY node_id, n DESC`,
  );
  const humanRoutes = q(
    win,
    `SELECT json_extract(p.payload,'$.nodeId') AS node_id, json_extract(h.payload,'$.route') AS route, COUNT(*) AS n,
            AVG((h.ts - p.ts) / 3600000.0) AS mean_hours_waiting
     FROM events h JOIN events p ON p.run_id = h.run_id AND p.type = 'fact.run_paused'
       AND json_extract(p.payload,'$.reason') = 'human'
       AND p.seq = (SELECT MAX(x.seq) FROM events x WHERE x.run_id = h.run_id AND x.type = 'fact.run_paused' AND x.seq < h.seq)
     WHERE h.type = 'intent.human_input' AND h.${W}
     GROUP BY node_id, route ORDER BY node_id, n DESC`,
  );
  const judge = q(
    win,
    `SELECT node_id, question, kind, COUNT(*) AS n,
            AVG(noul) AS mean_noul,
            SUM(noul BETWEEN 0.3 AND 0.7) AS undecided,
            AVG(confidence) AS mean_confidence,
            SUM(decision_status = 'fail') AS decided_fail,
            SUM(decision_status = 'success') AS decided_success
     FROM judge_answers WHERE ${W} GROUP BY node_id, question ORDER BY node_id, question`,
  );
  const steerMessages = q(
    win,
    `SELECT run_id, substr(json_extract(payload,'$.text'), 1, 300) AS text
     FROM events WHERE type = 'intent.steering_requested' AND ${W} ORDER BY seq LIMIT 20`,
  );
  const warnings = q(
    win,
    `SELECT substr(json_extract(payload,'$.message'), 1, 120) AS k, COUNT(*) AS n
     FROM events WHERE type = 'agent.warning' AND ${W} GROUP BY k ORDER BY n DESC LIMIT 10`,
  );

  const shas = q(win, `SELECT DISTINCT workflow_sha AS sha FROM run_state WHERE ${W} ORDER BY enqueued_at`).map(
    (r) => r.sha as string,
  );
  const sha = shas[shas.length - 1] ?? "";
  const types = new Map<string, string>();
  for (const s of shas) {
    const ir = (one(win, "SELECT ir FROM workflows WHERE sha = ?", s).ir ?? null) as string | null;
    for (const [k, v] of handlerTypesFor(s, ir)) types.set(k, v);
  }

  const nodeProfiles = q(
    win,
    `WITH nodes AS (
       SELECT DISTINCT run_id, node_id FROM dispatches WHERE ${W}
       UNION SELECT DISTINCT run_id, node_id FROM node_cost WHERE ${W}
     )
     SELECT n.node_id,
       COUNT(DISTINCT n.run_id) AS in_runs,
       (SELECT COUNT(*) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W}) AS dispatches,
       (SELECT COUNT(*) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W} AND d.resume_of <> 'fresh') AS resumed_dispatches,
       (SELECT COUNT(*) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W} AND d.end_type = 'fact.node_aborted') AS aborted_dispatches,
       (SELECT SUM(d.partial_cost_usd) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W}) AS wasted_cost_usd,
       (SELECT AVG(c.cost_usd) FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS mean_cost_usd,
       (SELECT SUM(c.cost_usd) FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS sum_cost_usd,
       (SELECT AVG(c.fresh_tokens) FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS mean_fresh_tokens,
       (SELECT AVG(c.output_tokens) FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS mean_output_tokens,
       (SELECT AVG(c.llm_calls) FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS mean_llm_calls,
       (SELECT SUM(c.cache_read_tokens) * 1.0 / NULLIF(SUM(c.cache_read_tokens + c.cache_write_tokens + c.fresh_tokens), 0)
          FROM node_cost c WHERE c.node_id = n.node_id AND c.${W}) AS cache_read_ratio,
       (SELECT AVG(s) FROM (SELECT SUM(d.wall_seconds) AS s FROM dispatches d WHERE d.node_id = n.node_id AND d.${W} AND d.wall_seconds IS NOT NULL GROUP BY d.run_id)) AS mean_wall_seconds,
       (SELECT AVG(t.llm_seconds) FROM turn_spans t WHERE t.node_id = n.node_id AND t.${W}) AS mean_llm_seconds,
       (SELECT SUM(tc.seconds) / NULLIF(COUNT(DISTINCT tc.run_id), 0) FROM tool_calls tc WHERE tc.node_id = n.node_id AND tc.${W}) AS mean_tool_seconds,
       (SELECT COUNT(*) * 1.0 / NULLIF(COUNT(DISTINCT tc.run_id), 0) FROM tool_calls tc WHERE tc.node_id = n.node_id AND tc.${W}) AS mean_tool_calls,
       (SELECT SUM(tc.is_error) FROM tool_calls tc WHERE tc.node_id = n.node_id AND tc.${W}) AS tool_errors,
       (SELECT MAX(d.iteration) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W}) AS max_iteration,
       (SELECT MAX(d.pass) FROM dispatches d WHERE d.node_id = n.node_id AND d.${W}) AS max_pass,
       (SELECT SUM(m.emit_reminder) FROM messages m WHERE m.node_id = n.node_id AND m.${W}) AS emit_reminders,
       (SELECT SUM(m.bytes) / NULLIF(COUNT(DISTINCT m.run_id), 0) FROM messages m WHERE m.node_id = n.node_id AND m.${W}) AS mean_transcript_bytes,
       (SELECT GROUP_CONCAT(DISTINCT json_extract(e.payload,'$.modelName')) FROM events e
          WHERE e.type = 'fact.node_completed' AND json_extract(e.payload,'$.nodeId') = n.node_id AND e.${W}) AS models
     FROM nodes n WHERE substr(n.node_id, 1, 2) <> '__' GROUP BY n.node_id ORDER BY sum_cost_usd DESC`,
  ).map((p) => {
    const nodeId = p.node_id as string;
    const topTools = q(
      win,
      `SELECT tool, COUNT(*) * 1.0 / NULLIF((SELECT COUNT(DISTINCT run_id) FROM tool_calls WHERE node_id = ? AND ${W}), 0) AS mean_per_run,
              AVG(is_error) AS error_rate
       FROM tool_calls WHERE node_id = ? AND ${W} GROUP BY tool ORDER BY COUNT(*) DESC LIMIT 6`,
      nodeId,
      nodeId,
    );
    const meanWall = Number(p.mean_wall_seconds ?? 0);
    const meanLlm = Number(p.mean_llm_seconds ?? 0);
    const meanTool = Number(p.mean_tool_seconds ?? 0);
    return {
      node_id: nodeId,
      node_type: types.get(nodeId) ?? null,
      in_runs: p.in_runs,
      dispatches: p.dispatches,
      resumed_dispatches: p.resumed_dispatches,
      aborted_dispatches: p.aborted_dispatches,
      wasted_cost_usd: round(Number(p.wasted_cost_usd ?? 0)),
      mean_cost_usd: round(Number(p.mean_cost_usd ?? 0)),
      sum_cost_usd: round(Number(p.sum_cost_usd ?? 0)),
      mean_fresh_tokens: Math.round(Number(p.mean_fresh_tokens ?? 0)),
      mean_output_tokens: Math.round(Number(p.mean_output_tokens ?? 0)),
      mean_llm_calls: round(Number(p.mean_llm_calls ?? 0), 1),
      cache_read_ratio: round(Number(p.cache_read_ratio ?? 0), 3),
      mean_wall_seconds: round(meanWall, 1),
      mean_llm_seconds: round(meanLlm, 1),
      mean_tool_seconds: round(meanTool, 1),
      mean_dispatch_seconds: round(Math.max(0, meanWall - meanLlm - meanTool), 1),
      mean_tool_calls: round(Number(p.mean_tool_calls ?? 0), 1),
      tool_errors: Number(p.tool_errors ?? 0),
      top_tools: topTools.map((t) => ({
        tool: t.tool,
        mean_per_run: round(Number(t.mean_per_run ?? 0), 1),
        error_rate: round(Number(t.error_rate ?? 0), 3),
      })),
      max_iteration: Number(p.max_iteration ?? 0),
      max_pass: Number(p.max_pass ?? 0),
      emit_reminders: Number(p.emit_reminders ?? 0),
      mean_transcript_bytes: Math.round(Number(p.mean_transcript_bytes ?? 0)),
      models: typeof p.models === "string" ? (p.models as string).split(",") : [],
    };
  });

  return {
    workflow,
    n_runs: runIds.length,
    versions,
    status_counts: statusCounts,
    terminal,
    cost_usd: { p50: round(pct(costs, 50)), p90: round(pct(costs, 90)), sum: round(costs.reduce((a, b) => a + b, 0)) },
    billed_tokens: { p50: pct(tokens, 50), p90: pct(tokens, 90), sum: tokens.reduce((a, b) => a + b, 0) },
    duration_seconds: { p50: Math.round(pct(durations, 50)), p90: Math.round(pct(durations, 90)) },
    outcome: {
      acted: Number(outcome.acted ?? 0),
      discarded: Number(outcome.discarded ?? 0),
      pending: Number(outcome.pending ?? 0),
      no_inbox: Number(outcome.no_inbox ?? 0),
      cost_acted_usd: round(Number(outcome.cost_acted_usd ?? 0)),
      cost_discarded_usd: round(Number(outcome.cost_discarded_usd ?? 0)),
      median_hours_to_action: round(pct(hoursToAction, 50), 2),
    },
    pauses: pausesByReason.map((r) => ({
      reason: r.k,
      n: r.n,
      seconds_sum: Math.round(Number(r.seconds ?? 0)),
      max_seconds: Math.round(Number(r.max_seconds ?? 0)),
    })),
    provider_retries: {
      n: Number(providerRetries.n ?? 0),
      delay_seconds_sum: Math.round(Number(providerRetries.delay_seconds_sum ?? 0)),
      max_delay_seconds: Math.round(Number(providerRetries.max_delay_seconds ?? 0)),
    },
    dispatches_by_resume_of: resumeOf,
    short_resumes: shortResumes.map((r) => ({
      ...r,
      resumed_seconds: Math.round(Number(r.resumed_seconds)),
      prior_seconds: Math.round(Number(r.prior_seconds)),
    })),
    aborts: aborts.map((a) => ({ ...a, wasted_cost_usd: round(Number(a.wasted_cost_usd ?? 0)) })),
    operator: {
      requeued_after_crash: Number(crashes.requeued_after_crash ?? 0),
      handler_timeout_leaked: Number(crashes.handler_timeout_leaked ?? 0),
      budget_stops: Number(crashes.budget_stops ?? 0),
      budget_warns: Number(crashes.budget_warns ?? 0),
      budget_raises: Number(crashes.budget_raises ?? 0),
      goal_gate_raises: Number(crashes.goal_gate_raises ?? 0),
      steers: Number(crashes.steers ?? 0),
      cancels: Number(crashes.cancels ?? 0),
      human_inputs: Number(crashes.human_inputs ?? 0),
    },
    transcript_smells: reminders,
    route_choices: routes,
    human_routes: humanRoutes.map((r) => ({ ...r, mean_hours_waiting: round(Number(r.mean_hours_waiting ?? 0), 2) })),
    judge: judge.map((j) => ({
      ...j,
      mean_noul: j.mean_noul == null ? null : round(Number(j.mean_noul), 3),
      mean_confidence: j.mean_confidence == null ? null : round(Number(j.mean_confidence), 3),
    })),
    steer_messages: steerMessages,
    warnings,
    node_profiles: nodeProfiles,
    workflow_sha: sha,
  };
}

function runView(win: Database, runId: string): Row {
  const rs = one(
    win,
    `SELECT rs.run_id, rs.workflow_name, substr(rs.workflow_sha,1,8) AS sha8, rs.status, rs.inbox_status, rs.title,
            rs.current_node, rs.schedule_id IS NOT NULL AS scheduled,
            json_extract(rs.metrics,'$.totalCostUsd') AS cost_usd,
            json_extract(rs.metrics,'$.billedTokens') AS billed_tokens,
            (COALESCE(t.ts, rs.updated_at) - rs.enqueued_at) / 1000.0 AS duration_seconds,
            t.status AS terminal_status, t.reason AS terminal_reason
     FROM run_state rs LEFT JOIN terminal t ON t.run_id = rs.run_id WHERE rs.run_id = ?`,
    runId,
  );
  const pauses = q(win, "SELECT reason, node_id, seconds FROM pauses WHERE run_id = ? ORDER BY seq", runId).map(
    (p) => ({
      reason: p.reason,
      node_id: p.node_id,
      seconds: Math.round(Number(p.seconds)),
    }),
  );
  const dispatches = q(
    win,
    `SELECT d.node_id, d.iteration, d.pass, d.resume_of, d.end_type, d.abort_cause, d.wall_seconds, d.partial_cost_usd,
            (SELECT SUM(emit_reminder) FROM messages m WHERE m.run_id = d.run_id AND m.node_id = d.node_id) AS reminders
     FROM dispatches d WHERE d.run_id = ? ORDER BY d.seq`,
    runId,
  ).map((d) => ({
    node_id: d.node_id,
    iteration: d.iteration,
    pass: d.pass,
    resume_of: d.resume_of,
    ended:
      d.end_type == null ? "open" : d.end_type === "fact.node_completed" ? "completed" : `aborted:${d.abort_cause}`,
    wall_seconds: d.wall_seconds == null ? null : Math.round(Number(d.wall_seconds)),
    wasted_cost_usd: round(Number(d.partial_cost_usd ?? 0)),
  }));
  const perNode = q(
    win,
    `SELECT node_id, cost_usd, fresh_tokens, cache_read_tokens, llm_calls FROM node_cost WHERE run_id = ? ORDER BY cost_usd DESC`,
    runId,
  ).map((n) => ({
    node_id: n.node_id,
    cost_usd: round(Number(n.cost_usd)),
    fresh_tokens: Number(n.fresh_tokens),
    cache_read_tokens: Number(n.cache_read_tokens),
    llm_calls: Number(n.llm_calls),
  }));
  return {
    ...rs,
    cost_usd: round(Number(rs.cost_usd ?? 0)),
    duration_seconds: Math.round(Number(rs.duration_seconds ?? 0)),
    pauses,
    dispatches,
    per_node: perNode,
  };
}

// The lenses read this before writing a `check`; it is the one description
// of window.db and of the check contract the verifier enforces.
const SCHEMA_MD = `# window.db — the analyze window

A read-only SQLite copy of the runs in this window. Every number in
\`snapshot.json\` derives from it, and every hypothesis \`check\` runs against it.

## The check contract

A \`check\` is ONE \`SELECT\` (or \`WITH … SELECT\`) that returns EXACTLY ONE row
with a column named \`ok\`: 1 when the claim holds, 0 when it does not. No
semicolons, no writes. Extra columns are kept as evidence (first 5 rows, 600
chars), so return the numbers the claim rests on next to \`ok\`:

    SELECT COUNT(*) AS runs, SUM(json_extract(metrics,'$.totalCostUsd')) AS usd,
           (COUNT(*) >= 5 AND SUM(json_extract(metrics,'$.totalCostUsd')) > 100) AS ok
    FROM run_state WHERE workflow_name = 'review' AND inbox_status = 'discarded'

Scope every check to the workflow (and step) the claim names. A threshold
inside \`ok\` must be the one the claim states.

## Tables

- \`run_state(run_id, workflow_name, workflow_sha, status, inbox_status, title, current_node, metrics, enqueued_at, updated_at, node_started_at, schedule_id, base_git_ref, final_head_ref, accepted_sha, change_stat, in_checkout, cwd, project_name)\`
  — \`metrics\` is JSON: \`totalCostUsd\`, \`billedTokens\`, \`totalInputTokens\`, \`totalOutputTokens\`, \`totalCacheReadTokens\`, \`totalCacheWriteTokens\`, \`loopCounts\`, \`nodeCosts.<node>.{tokens,costUsd}\`, \`activeMs\`. Timestamps are ms since epoch. \`inbox_status\` is \`acted\` / \`discarded\` / \`pending\` / NULL (never entered the inbox).
- \`workflows(sha, name, source, ir)\` — the YAML \`source\` of every workflow version in the window.
- \`events(run_id, seq, type, writer, payload, ts)\` — \`payload\` is JSON. Streaming deltas and \`fact.message_appended\` are not copied. Types and the payload fields that matter:
  - \`fact.run_terminated\` {status: completed|aborted|errored, reason}; legacy \`fact.run_completed\` / \`fact.run_halted\` / \`fact.run_cancelled\`.
  - \`fact.run_paused\` {reason: budget|human|provider_retry|provider_error|provider_exhausted|goal_gate|max_retries|abort_loop|operator|engine_incompatible, nodeId, …}; \`fact.run_resumed\` {fromStatus}.
  - \`fact.dispatch_started\` {nodeId, iteration, pass, resumeOf: fresh|crash|paused|paused_auto|paused_human|quarantined} — one per attempt at a step.
  - \`fact.node_started\` {nodeId}; \`fact.node_completed\` {nodeId, iteration, tokens, costUsd, nextNode, route?, modelName?, outcomeStatus?}; \`fact.node_aborted\` {nodeId, cause: aborted|timeout|provider_pause, partialCostUsd, partialTokens}.
  - \`fact.provider_retry_attempted\` {nodeId, attempt, httpStatus, delayMs}; \`fact.run_requeued_after_crash\` {prevNode}; \`fact.handler_timeout_leaked\` {nodeId}.
  - \`fact.fanout_started\` {nodeId, branches[]}; \`fact.fanout_joined\` {nodeId, branchesCompleted}; \`fact.run_accepted\` {sha}; \`fact.run_discarded\`; \`fact.snapshot_recorded\`.
  - \`intent.run_enqueued\` {workflowName, title, routing.inputs}; \`intent.human_input\` {route, note}; \`intent.steering_requested\` {text}; \`intent.cancel_requested\`; \`intent.budget_adjusted\`; \`intent.goal_gate_adjusted\`; \`intent.resume\`.
  - \`cost.recorded\` {nodeId, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, stop_reason} — one per LLM call.
  - \`agent.turn_start\` / \`agent.turn_end\` {nodeId}; \`tool.execution_start\` {nodeId, tool_name, tool_call_id, args} / \`tool.execution_end\` {tool_call_id, is_error}; \`agent.info\` {event: thread_rehydrated, …}; \`agent.warning\` {message}.
  - \`judge.requested\` {nodeId, questionIds, stateBytes}; \`judge.answered\` {nodeId, answers.<q>.{type,noul|choice|score,confidence}, decision.{kind,status|route}}.
  - \`budget.warn\` / \`budget.stop\` {nodeId, scope, metric, limit, actual}; \`edge.selected\` {from, to, rule}.
- \`messages(run_id, ordinal, node_id, iteration, pass, role, bytes, emit_reminder, abort_call, route_call, emit_output_call)\` — transcript METADATA only, no content. \`emit_reminder\` = 1 on the corrective "call emit_output now" user message; \`abort_call\` / \`route_call\` / \`emit_output_call\` = 1 on an assistant message carrying that tool call.

Use \`json_extract(payload, '$.field')\`. Join events to runs on \`run_id\`. A step's attempts are its \`fact.dispatch_started\` rows; its wall time is the next \`fact.node_completed\` / \`fact.node_aborted\` for the same \`nodeId\` minus the dispatch \`ts\`.
`;

// ─────────────────────────── main ───────────────────────────

const args = parseArgs(process.argv.slice(2));
const t0 = Date.now();
const live = new Database(args.storePath, { readonly: true });
const runs = selectWindowRuns(live, args);
mkdirSync(args.out, { recursive: true });
const windowPath = join(args.out, "window.db");
const win = buildWindowDb(live, runs, windowPath);
live.close();

const tCopy = Date.now();
win.exec(TERMINAL_VIEW + PAUSE_VIEW + DISPATCH_VIEW + NODE_COST_VIEW + SPAN_VIEWS + JUDGE_VIEW + DERIVED_INDEXES);
const tDerive = Date.now();

const workflowNames = q(
  win,
  "SELECT COALESCE(workflow_name, '(unnamed)') AS w, COUNT(*) AS n FROM run_state GROUP BY w ORDER BY n DESC",
).map((r) => r.w as string);
const byWorkflow = workflowNames.map((w) => workflowAggregate(win, w));
const runsOut = runs.map((r) => runView(win, r.run_id));

const totals = one(
  win,
  `SELECT COUNT(*) AS n_runs,
          SUM(json_extract(metrics,'$.totalCostUsd')) AS sum_cost_usd,
          SUM(json_extract(metrics,'$.billedTokens')) AS sum_billed_tokens,
          SUM(inbox_status = 'acted') AS acted, SUM(inbox_status = 'discarded') AS discarded,
          SUM(inbox_status = 'pending') AS pending,
          SUM(CASE WHEN inbox_status = 'discarded' THEN json_extract(metrics,'$.totalCostUsd') ELSE 0 END) AS cost_discarded_usd
   FROM run_state`,
);
const eventRows = Number(one(win, "SELECT COUNT(*) AS n FROM events").n ?? 0);
const messageRows = Number(one(win, "SELECT COUNT(*) AS n FROM messages").n ?? 0);
win.close();

const snapshot = {
  collected_at: new Date().toISOString(),
  store_path: args.storePath,
  window_db: windowPath,
  window_db_rows: { events: eventRows, messages: messageRows },
  collect_seconds: round((Date.now() - t0) / 1000, 1),
  phase_seconds: {
    copy: round((tCopy - t0) / 1000, 1),
    derive: round((tDerive - tCopy) / 1000, 1),
    aggregate: round((Date.now() - tDerive) / 1000, 1),
  },
  filters: {
    limit: args.limit,
    workflow: args.workflow,
    since_days: args.sinceMs ? Math.round((Date.now() - args.sinceMs) / 86400_000) : null,
  },
  totals: {
    n_runs: Number(totals.n_runs ?? 0),
    distinct_workflows: byWorkflow.length,
    sum_cost_usd: round(Number(totals.sum_cost_usd ?? 0)),
    sum_billed_tokens: Number(totals.sum_billed_tokens ?? 0),
    acted: Number(totals.acted ?? 0),
    discarded: Number(totals.discarded ?? 0),
    pending: Number(totals.pending ?? 0),
    cost_discarded_usd: round(Number(totals.cost_discarded_usd ?? 0)),
  },
  by_workflow: byWorkflow,
  runs: runsOut,
};

// Pretty-printed: lens steps read it with `read`, which is line-oriented.
writeFileSync(join(args.out, "snapshot.json"), JSON.stringify(snapshot, null, 2));
writeFileSync(join(args.out, "SCHEMA.md"), SCHEMA_MD);
const outPath = process.env.FRAGUA_OUTPUT;
if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify({
      snapshot: join(args.out, "snapshot.json"),
      window_db: windowPath,
      n_runs: snapshot.totals.n_runs,
      since_days: snapshot.filters.since_days ?? 0,
      sum_cost_usd: snapshot.totals.sum_cost_usd,
      workflows: byWorkflow.map((w) => ({
        workflow: w.workflow as string,
        n_runs: w.n_runs as number,
        sum_cost_usd: (w.cost_usd as { sum: number }).sum,
        acted: (w.outcome as { acted: number }).acted,
        discarded: (w.outcome as { discarded: number }).discarded,
        analysed: (w.n_runs as number) >= 3,
      })),
    }),
  );
}
process.stdout.write(
  `analyze: ${snapshot.totals.n_runs} runs, ${byWorkflow.length} workflows, ${eventRows} events, ${messageRows} messages → ${args.out} in ${snapshot.collect_seconds}s\n`,
);
