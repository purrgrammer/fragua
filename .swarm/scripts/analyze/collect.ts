#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { resolve } from "node:path";

interface Args {
  storePath: string;
  limit: number;
  workflow: string | null;
  sinceMs: number | null;
}

function parseArgs(argv: string[]): Args {
  let storePath = ".swarm/swarm.db";
  let limit = 30;
  let workflow: string | null = null;
  let sinceMs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--db" && next) { storePath = next; i++; }
    else if (a === "--limit" && next) { limit = Number(next); i++; }
    else if (a === "--workflow" && next) { workflow = next; i++; }
    else if (a === "--since-days" && next) {
      sinceMs = Date.now() - Number(next) * 86400_000; i++;
    }
  }
  return { storePath: resolve(storePath), limit, workflow, sinceMs };
}

interface RunRow {
  run_id: string;
  workflow_name: string;
  workflow_sha: string;
  status: string;
  current_node: string | null;
  enqueued_at: number;
  updated_at: number;
  node_started_at: number | null;
  metrics: string;
  routing: string;
  title: string | null;
}

interface NodeCost { tokens: number; costUsd: number }
interface Metrics {
  totalCostUsd?: number;
  billedTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  loopCounts?: Record<string, number>;
  nodeCosts?: Record<string, NodeCost>;
  models?: Record<string, NodeCost>;
  activeMs?: number;
}

const TERMINAL_TYPES = new Set([
  "fact.run_completed",
  "fact.run_halted",
  "fact.run_cancelled",
  "fact.run_quarantined",
  "fact.run_paused_hitl",
]);

const args = parseArgs(process.argv.slice(2));
const db = new Database(args.storePath, { readonly: true });

const filters: string[] = [];
const params: Record<string, string | number> = {};
if (args.workflow) {
  filters.push("w.name = $workflow");
  params.$workflow = args.workflow;
}
if (args.sinceMs !== null) {
  filters.push("rs.updated_at >= $since");
  params.$since = args.sinceMs;
}
const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

const runs = db.prepare(`
  SELECT
    rs.run_id, w.name AS workflow_name, rs.workflow_sha,
    rs.status, rs.current_node,
    rs.enqueued_at, rs.updated_at, rs.node_started_at,
    rs.metrics, rs.routing, rs.title
  FROM run_state rs
  JOIN workflows w ON rs.workflow_sha = w.sha
  ${whereClause}
  ORDER BY rs.updated_at DESC
  LIMIT $limit
`).all({ ...params, $limit: args.limit }) as RunRow[];

interface PerNodeSummary {
  node_id: string;
  loop_count: number;
  tokens: number;
  cost_usd: number;
  models: string[];
  wall_seconds: number;
  tool_calls: { tool: string; n: number; n_errors: number }[];
  tool_call_total: number;
}

interface SteerSummary {
  seq: number;
  ts: number;
  text: string;
}

interface RunSummary {
  run_id: string;
  workflow: string;
  workflow_sha: string;
  status: string;
  current_node: string | null;
  enqueued_at: number;
  updated_at: number;
  duration_seconds: number;
  total_cost_usd: number;
  billed_tokens: number;
  fresh_tokens: number;
  cache_read_tokens: number;
  active_seconds: number;
  models: string[];
  terminal_fact: { type: string; payload: unknown } | null;
  intent_counts: Record<string, number>;
  node_aborts: { node_id: string; cause: string; iteration: number }[];
  goal_gate_retries: number;
  per_node: PerNodeSummary[];
  steers: SteerSummary[];
  tool_call_total: number;
  input_preview: string | null;
}

const summaries: RunSummary[] = [];

for (const r of runs) {
  const metrics: Metrics = JSON.parse(r.metrics);
  const routing: Record<string, unknown> = JSON.parse(r.routing);

  const terminalRow = db.prepare(`
    SELECT type, payload FROM events
    WHERE run_id = ? AND type IN (
      'fact.run_completed','fact.run_halted','fact.run_cancelled',
      'fact.run_quarantined','fact.run_paused_hitl'
    )
    ORDER BY seq DESC LIMIT 1
  `).get(r.run_id) as { type: string; payload: string } | undefined;

  const intentRows = db.prepare(`
    SELECT type, COUNT(*) AS n
    FROM events
    WHERE run_id = ? AND type LIKE 'intent.%'
    GROUP BY type
  `).all(r.run_id) as { type: string; n: number }[];

  const intentCounts: Record<string, number> = {};
  for (const ir of intentRows) intentCounts[ir.type] = ir.n;

  const abortRows = db.prepare(`
    SELECT payload FROM events
    WHERE run_id = ? AND type = 'fact.node_aborted'
    ORDER BY seq
  `).all(r.run_id) as { payload: string }[];

  const nodeAborts = abortRows.map(a => {
    const p = JSON.parse(a.payload) as { nodeId?: string; cause?: string; iteration?: number };
    return {
      node_id: p.nodeId ?? "?",
      cause: p.cause ?? "?",
      iteration: p.iteration ?? 0,
    };
  });

  const goalGates = (routing as { goal_gates?: Record<string, unknown> }).goal_gates;
  const goalGateRetries = goalGates && typeof goalGates === "object"
    ? (goalGates as { __retries?: number }).__retries ?? 0
    : 0;

  const nodeCompletedRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'fact.node_completed'
    ORDER BY seq
  `).all(r.run_id) as { ts: number; payload: string }[];

  const nodeStartedRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'fact.node_started'
    ORDER BY seq
  `).all(r.run_id) as { ts: number; payload: string }[];

  const startTsByNodeIter = new Map<string, number>();
  for (const ns of nodeStartedRows) {
    const p = JSON.parse(ns.payload) as { nodeId?: string; iteration?: number };
    if (p.nodeId) startTsByNodeIter.set(`${p.nodeId}:${p.iteration ?? 0}`, ns.ts);
  }

  const wallMsByNode = new Map<string, number>();
  const modelsByNode = new Map<string, Set<string>>();
  for (const nc of nodeCompletedRows) {
    const p = JSON.parse(nc.payload) as { nodeId?: string; iteration?: number; modelName?: string };
    if (!p.nodeId) continue;
    const startTs = startTsByNodeIter.get(`${p.nodeId}:${p.iteration ?? 0}`);
    if (startTs !== undefined) {
      wallMsByNode.set(p.nodeId, (wallMsByNode.get(p.nodeId) ?? 0) + (nc.ts - startTs));
    }
    if (p.modelName) {
      const set = modelsByNode.get(p.nodeId) ?? new Set();
      set.add(p.modelName);
      modelsByNode.set(p.nodeId, set);
    }
  }

  const toolRows = db.prepare(`
    SELECT payload FROM events
    WHERE run_id = ? AND type = 'tool.execution_end'
  `).all(r.run_id) as { payload: string }[];

  const toolsByNode = new Map<string, Map<string, { n: number; n_errors: number }>>();
  let runToolTotal = 0;
  for (const tr of toolRows) {
    const p = JSON.parse(tr.payload) as { nodeId?: string; tool_name?: string; is_error?: boolean };
    if (!p.nodeId || !p.tool_name) continue;
    runToolTotal++;
    const inner = toolsByNode.get(p.nodeId) ?? new Map();
    const slot = inner.get(p.tool_name) ?? { n: 0, n_errors: 0 };
    slot.n++;
    if (p.is_error) slot.n_errors++;
    inner.set(p.tool_name, slot);
    toolsByNode.set(p.nodeId, inner);
  }

  const steerRows = db.prepare(`
    SELECT seq, ts, payload FROM events
    WHERE run_id = ? AND type = 'intent.steering_requested'
    ORDER BY seq
  `).all(r.run_id) as { seq: number; ts: number; payload: string }[];

  const steers: SteerSummary[] = steerRows.map(s => {
    const p = JSON.parse(s.payload) as { text?: string };
    return { seq: s.seq, ts: s.ts, text: (p.text ?? "").slice(0, 500) };
  });

  const perNode: PerNodeSummary[] = [];
  const allNodeIds = new Set<string>([
    ...Object.keys(metrics.loopCounts ?? {}),
    ...Object.keys(metrics.nodeCosts ?? {}),
    ...wallMsByNode.keys(),
    ...modelsByNode.keys(),
    ...toolsByNode.keys(),
  ]);
  for (const nid of allNodeIds) {
    const tools = toolsByNode.get(nid);
    const toolList = tools
      ? [...tools.entries()]
          .map(([tool, v]) => ({ tool, n: v.n, n_errors: v.n_errors }))
          .sort((a, b) => b.n - a.n)
      : [];
    perNode.push({
      node_id: nid,
      loop_count: metrics.loopCounts?.[nid] ?? 0,
      tokens: metrics.nodeCosts?.[nid]?.tokens ?? 0,
      cost_usd: metrics.nodeCosts?.[nid]?.costUsd ?? 0,
      models: [...(modelsByNode.get(nid) ?? [])],
      wall_seconds: Math.round((wallMsByNode.get(nid) ?? 0) / 1000),
      tool_calls: toolList,
      tool_call_total: toolList.reduce((a, t) => a + t.n, 0),
    });
  }
  perNode.sort((a, b) => b.cost_usd - a.cost_usd);

  const billed = metrics.billedTokens ?? 0;
  const fresh = (metrics.totalInputTokens ?? 0) + (metrics.totalOutputTokens ?? 0);
  const cacheRead = metrics.totalCacheReadTokens ?? 0;

  summaries.push({
    run_id: r.run_id,
    workflow: r.workflow_name,
    workflow_sha: r.workflow_sha,
    status: r.status,
    current_node: r.current_node,
    enqueued_at: r.enqueued_at,
    updated_at: r.updated_at,
    duration_seconds: Math.round((r.updated_at - r.enqueued_at) / 1000),
    total_cost_usd: metrics.totalCostUsd ?? 0,
    billed_tokens: billed,
    fresh_tokens: fresh,
    cache_read_tokens: cacheRead,
    active_seconds: Math.round((metrics.activeMs ?? 0) / 1000),
    models: Object.keys(metrics.models ?? {}),
    terminal_fact: terminalRow
      ? { type: terminalRow.type, payload: JSON.parse(terminalRow.payload) }
      : null,
    intent_counts: intentCounts,
    node_aborts: nodeAborts,
    goal_gate_retries: goalGateRetries,
    per_node: perNode,
    steers,
    tool_call_total: runToolTotal,
    input_preview: typeof routing.input === "string"
      ? (routing.input as string).slice(0, 240)
      : null,
  });
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

interface NodeProfile {
  node_id: string;
  in_runs: number;
  models: string[];
  mean_cost_usd: number;
  mean_tokens: number;
  mean_wall_seconds: number;
  mean_tool_calls: number;
  top_tools: { tool: string; mean_per_run: number; error_rate: number }[];
  max_loop_count: number;
}

interface WorkflowAggregate {
  workflow: string;
  n_runs: number;
  status_counts: Record<string, number>;
  cost_usd: { p50: number; p90: number; sum: number };
  billed_tokens: { p50: number; p90: number; sum: number };
  duration_seconds: { p50: number; p90: number };
  halt_reasons: Record<string, number>;
  total_steers: number;
  total_pauses: number;
  total_cancels: number;
  total_goal_gate_retries: number;
  total_aborts: number;
  total_tool_calls: number;
  total_tool_errors: number;
  abort_causes: Record<string, number>;
  abort_hotspots: { node_id: string; n: number }[];
  high_iteration_nodes: { node_id: string; max_loop: number; in_runs: number }[];
  node_profiles: NodeProfile[];
  steer_messages: { run_id: string; text: string }[];
  models_used: string[];
}

const byWorkflow = new Map<string, RunSummary[]>();
for (const s of summaries) {
  const arr = byWorkflow.get(s.workflow) ?? [];
  arr.push(s);
  byWorkflow.set(s.workflow, arr);
}

const aggregates: WorkflowAggregate[] = [];
for (const [wf, runs] of byWorkflow) {
  const statusCounts: Record<string, number> = {};
  const haltReasons: Record<string, number> = {};
  const abortCauses: Record<string, number> = {};
  const abortNode: Record<string, number> = {};
  const nodeAcc = new Map<string, {
    n: number;
    cost: number;
    tokens: number;
    wallSeconds: number;
    toolCalls: number;
    maxLoop: number;
    models: Set<string>;
    toolUse: Map<string, { n: number; n_errors: number }>;
  }>();
  const models = new Set<string>();
  const steerMessages: { run_id: string; text: string }[] = [];
  let steers = 0, pauses = 0, cancels = 0, gates = 0, aborts = 0;
  let toolCallTotal = 0, toolErrorTotal = 0;

  for (const r of runs) {
    statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    if (r.terminal_fact?.type === "fact.run_halted") {
      const reason = (r.terminal_fact.payload as { reason?: string }).reason ?? "unknown";
      haltReasons[reason] = (haltReasons[reason] ?? 0) + 1;
    }
    for (const a of r.node_aborts) {
      aborts++;
      abortCauses[a.cause] = (abortCauses[a.cause] ?? 0) + 1;
      abortNode[a.node_id] = (abortNode[a.node_id] ?? 0) + 1;
    }
    steers += r.intent_counts["intent.steering_requested"] ?? 0;
    pauses += r.intent_counts["intent.pause_requested"] ?? 0;
    cancels += r.intent_counts["intent.cancel_requested"] ?? 0;
    gates += r.goal_gate_retries;
    toolCallTotal += r.tool_call_total;
    for (const s of r.steers) steerMessages.push({ run_id: r.run_id, text: s.text });
    for (const m of r.models) models.add(m);
    for (const pn of r.per_node) {
      const slot = nodeAcc.get(pn.node_id) ?? {
        n: 0, cost: 0, tokens: 0, wallSeconds: 0, toolCalls: 0, maxLoop: 0,
        models: new Set<string>(), toolUse: new Map<string, { n: number; n_errors: number }>(),
      };
      slot.n++;
      slot.cost += pn.cost_usd;
      slot.tokens += pn.tokens;
      slot.wallSeconds += pn.wall_seconds;
      slot.toolCalls += pn.tool_call_total;
      slot.maxLoop = Math.max(slot.maxLoop, pn.loop_count);
      for (const m of pn.models) slot.models.add(m);
      for (const t of pn.tool_calls) {
        const u = slot.toolUse.get(t.tool) ?? { n: 0, n_errors: 0 };
        u.n += t.n;
        u.n_errors += t.n_errors;
        slot.toolUse.set(t.tool, u);
        toolErrorTotal += t.n_errors;
      }
      nodeAcc.set(pn.node_id, slot);
    }
  }

  const costs = runs.map(r => r.total_cost_usd);
  const tokens = runs.map(r => r.billed_tokens);
  const durations = runs.map(r => r.duration_seconds);

  const high_iteration_nodes = [...nodeAcc.entries()]
    .filter(([, v]) => v.maxLoop > 1)
    .map(([node_id, v]) => ({ node_id, max_loop: v.maxLoop, in_runs: v.n }))
    .sort((a, b) => b.max_loop - a.max_loop)
    .slice(0, 5);

  const node_profiles: NodeProfile[] = [...nodeAcc.entries()]
    .map(([node_id, v]) => ({
      node_id,
      in_runs: v.n,
      models: [...v.models],
      mean_cost_usd: Number((v.cost / v.n).toFixed(4)),
      mean_tokens: Math.round(v.tokens / v.n),
      mean_wall_seconds: Math.round(v.wallSeconds / v.n),
      mean_tool_calls: Number((v.toolCalls / v.n).toFixed(1)),
      max_loop_count: v.maxLoop,
      top_tools: [...v.toolUse.entries()]
        .map(([tool, u]) => ({
          tool,
          mean_per_run: Number((u.n / v.n).toFixed(1)),
          error_rate: u.n === 0 ? 0 : Number((u.n_errors / u.n).toFixed(2)),
        }))
        .sort((a, b) => b.mean_per_run - a.mean_per_run)
        .slice(0, 5),
    }))
    .sort((a, b) => b.mean_cost_usd - a.mean_cost_usd);

  const abort_hotspots = Object.entries(abortNode)
    .map(([node_id, n]) => ({ node_id, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);

  aggregates.push({
    workflow: wf,
    n_runs: runs.length,
    status_counts: statusCounts,
    cost_usd: {
      p50: Number(pct(costs, 50).toFixed(4)),
      p90: Number(pct(costs, 90).toFixed(4)),
      sum: Number(costs.reduce((a, b) => a + b, 0).toFixed(4)),
    },
    billed_tokens: {
      p50: pct(tokens, 50),
      p90: pct(tokens, 90),
      sum: tokens.reduce((a, b) => a + b, 0),
    },
    duration_seconds: { p50: pct(durations, 50), p90: pct(durations, 90) },
    halt_reasons: haltReasons,
    total_steers: steers,
    total_pauses: pauses,
    total_cancels: cancels,
    total_goal_gate_retries: gates,
    total_aborts: aborts,
    total_tool_calls: toolCallTotal,
    total_tool_errors: toolErrorTotal,
    abort_causes: abortCauses,
    abort_hotspots,
    high_iteration_nodes,
    node_profiles,
    steer_messages: steerMessages,
    models_used: [...models],
  });
}

aggregates.sort((a, b) => b.n_runs - a.n_runs);

const report = {
  collected_at: new Date().toISOString(),
  store_path: args.storePath,
  filters: {
    limit: args.limit,
    workflow: args.workflow,
    since_days: args.sinceMs ? Math.round((Date.now() - args.sinceMs) / 86400_000) : null,
  },
  totals: {
    n_runs: summaries.length,
    distinct_workflows: aggregates.length,
    sum_cost_usd: Number(summaries.reduce((a, r) => a + r.total_cost_usd, 0).toFixed(4)),
    sum_billed_tokens: summaries.reduce((a, r) => a + r.billed_tokens, 0),
  },
  by_workflow: aggregates,
  runs: summaries,
};

process.stdout.write(JSON.stringify(report, null, 2));
db.close();
