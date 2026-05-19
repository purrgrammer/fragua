#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { HANDLER_BY_SHAPE, parseDotSource } from "@swarm/core";

interface Args {
  storePath: string;
  limit: number;
  workflow: string | null;
  sinceMs: number | null;
}

function defaultStorePath(): string {
  const project = resolve(process.cwd(), ".swarm/swarm.db");
  // Empty/stray project DBs sometimes appear (test fixtures, mis-init).
  // Treat as absent unless populated — falls through to the harness store
  // so `swarm run analyze` from a project root keeps working.
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

function parseArgs(argv: string[]): Args {
  let storePath: string | null = null;
  // Defaults tuned for "what's been going on this week":
  //   --since-days 7  — picks up low-traffic drift workflows that run 1–2×/week.
  //                     (Previously null; combined with limit=30 this dropped
  //                     them below the 3-run analysis threshold.)
  //   --limit 200     — hard cap on rows so cost stays bounded for high-traffic
  //                     projects. Override either via $ARGUMENTS.
  let limit = 200;
  let workflow: string | null = null;
  let sinceMs: number | null = Date.now() - 7 * 86400_000;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--db" && next) { storePath = next; i++; }
    else if (a === "--limit" && next) { limit = Number(next); i++; }
    else if (a === "--workflow" && next) { workflow = next; i++; }
    else if (a === "--since-days" && next) {
      sinceMs = Date.now() - Number(next) * 86400_000; i++;
    }
    else if (a === "--no-since") { sinceMs = null; }
  }
  return { storePath: resolve(storePath ?? defaultStorePath()), limit, workflow, sinceMs };
}

interface RunRow {
  run_id: string;
  workflow_name: string;
  workflow_sha: string;
  dot_source: string;
  status: string;
  current_node: string | null;
  enqueued_at: number;
  updated_at: number;
  node_started_at: number | null;
  metrics: string;
  routing: string;
  title: string | null;
}

// nodeId -> handler type ("codergen" | "tool" | "start" | "exit" | ...),
// derived from the workflow DOT. Cached per workflow_sha — the same graph
// underlies every run on that sha. Unparseable workflows yield an empty
// map; affected nodes get handler_type: null.
const handlerTypesByWorkflowSha = new Map<string, Map<string, string>>();
function handlerTypesFor(sha: string, dotSource: string): Map<string, string> {
  const cached = handlerTypesByWorkflowSha.get(sha);
  if (cached) return cached;
  const map = new Map<string, string>();
  try {
    const graph = parseDotSource(dotSource);
    for (const [id, node] of Object.entries(graph.nodes)) {
      map.set(id, HANDLER_BY_SHAPE[node.shape]);
    }
  } catch {
    // leave empty — handler_type falls back to null downstream
  }
  handlerTypesByWorkflowSha.set(sha, map);
  return map;
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
  "fact.run_paused_human",
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
    rs.run_id, w.name AS workflow_name, rs.workflow_sha, w.dot_source,
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
  handler_type: string | null;
  loop_count: number;
  tokens: number;
  cost_usd: number;
  // True when tokens/cost_usd came from un-flushed `cost.recorded` events
  // because the node has no `fact.node_completed`/`fact.node_aborted` yet
  // — i.e. the node is still in flight. Lets the analyzer reason about
  // long-running executions before they terminate.
  partial: boolean;
  models: string[];
  wall_seconds: number;
  llm_seconds: number;
  tool_seconds: number;
  // wall_seconds not explained by LLM or tool work: scheduler backlog,
  // provisioner / worktree setup, dispatch + network. max(0, …) — the
  // three series are paired independently and can round past each other.
  dispatch_seconds: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
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
      'fact.run_quarantined','fact.run_paused_human'
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

  // Pair starts and ends by per-node sequential order, NOT by `(nodeId,
  // iteration)`. Goal-gate retargets re-run a downstream node with
  // `iteration: 0` both times — only the retarget target's iteration
  // bumps. Keying on `(nodeId, iteration)` lets the second start ts
  // overwrite the first in the map, and the first node_completed then
  // sums against a future timestamp = negative wall.
  const startsByNode = new Map<string, number[]>();
  for (const ns of nodeStartedRows) {
    const p = JSON.parse(ns.payload) as { nodeId?: string };
    if (!p.nodeId) continue;
    const list = startsByNode.get(p.nodeId) ?? [];
    list.push(ns.ts);
    startsByNode.set(p.nodeId, list);
  }
  const cursorByNode = new Map<string, number>();
  const wallMsByNode = new Map<string, number>();
  const modelsByNode = new Map<string, Set<string>>();
  for (const nc of nodeCompletedRows) {
    const p = JSON.parse(nc.payload) as { nodeId?: string; modelName?: string };
    if (!p.nodeId) continue;
    const starts = startsByNode.get(p.nodeId);
    if (starts !== undefined) {
      const idx = cursorByNode.get(p.nodeId) ?? 0;
      const startTs = starts[idx];
      if (startTs !== undefined) {
        wallMsByNode.set(p.nodeId, (wallMsByNode.get(p.nodeId) ?? 0) + (nc.ts - startTs));
        cursorByNode.set(p.nodeId, idx + 1);
      }
    }
    if (p.modelName) {
      const set = modelsByNode.get(p.nodeId) ?? new Set();
      set.add(p.modelName);
      modelsByNode.set(p.nodeId, set);
    }
  }

  // Read tool.execution_start (not _end) for tool_name. Result-bearing
  // events frequently exceed the 4 KB payload cap and lose tool_name on
  // truncation; start events carry only the args (small) and are
  // truncated <2% of the time vs. ~34% for ends. Pair with ends for
  // is_error by tool_call_id when both are intact; otherwise the call
  // counts but its outcome is unknown.
  const toolStartRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'tool.execution_start'
  `).all(r.run_id) as { ts: number; payload: string }[];
  const toolEndRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'tool.execution_end'
  `).all(r.run_id) as { ts: number; payload: string }[];

  const errorByCallId = new Map<string, boolean>();
  const endTsByCallId = new Map<string, number>();
  for (const te of toolEndRows) {
    const p = JSON.parse(te.payload) as { tool_call_id?: string; is_error?: boolean };
    if (typeof p.tool_call_id === "string") {
      errorByCallId.set(p.tool_call_id, !!p.is_error);
      endTsByCallId.set(p.tool_call_id, te.ts);
    }
  }

  const toolsByNode = new Map<string, Map<string, { n: number; n_errors: number }>>();
  const toolMsByNode = new Map<string, number>();
  let runToolTotal = 0;
  for (const ts of toolStartRows) {
    const p = JSON.parse(ts.payload) as {
      nodeId?: string;
      tool_name?: string;
      tool_call_id?: string;
    };
    if (!p.nodeId || !p.tool_name) continue;
    runToolTotal++;
    const inner = toolsByNode.get(p.nodeId) ?? new Map();
    const slot = inner.get(p.tool_name) ?? { n: 0, n_errors: 0 };
    slot.n++;
    if (typeof p.tool_call_id === "string") {
      if (errorByCallId.get(p.tool_call_id) === true) slot.n_errors++;
      const endTs = endTsByCallId.get(p.tool_call_id);
      if (endTs !== undefined && endTs >= ts.ts) {
        toolMsByNode.set(p.nodeId, (toolMsByNode.get(p.nodeId) ?? 0) + (endTs - ts.ts));
      }
    }
    inner.set(p.tool_name, slot);
    toolsByNode.set(p.nodeId, inner);
  }

  // LLM "active" time per node — sum of agent.turn_end - agent.turn_start
  // pairs. Pair sequentially per nodeId (same approach as the wall_ms
  // pairing above) — turn boundaries within a node are strictly serial
  // even when sibling parallel-branch nodes overlap globally.
  const turnStartRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'agent.turn_start'
    ORDER BY seq
  `).all(r.run_id) as { ts: number; payload: string }[];
  const turnEndRows = db.prepare(`
    SELECT ts, payload FROM events
    WHERE run_id = ? AND type = 'agent.turn_end'
    ORDER BY seq
  `).all(r.run_id) as { ts: number; payload: string }[];
  const turnStartsByNode = new Map<string, number[]>();
  for (const tr of turnStartRows) {
    const p = JSON.parse(tr.payload) as { nodeId?: string };
    if (!p.nodeId) continue;
    const list = turnStartsByNode.get(p.nodeId) ?? [];
    list.push(tr.ts);
    turnStartsByNode.set(p.nodeId, list);
  }
  const turnCursorByNode = new Map<string, number>();
  const llmMsByNode = new Map<string, number>();
  for (const tr of turnEndRows) {
    const p = JSON.parse(tr.payload) as { nodeId?: string };
    if (!p.nodeId) continue;
    const starts = turnStartsByNode.get(p.nodeId);
    if (starts === undefined) continue;
    const idx = turnCursorByNode.get(p.nodeId) ?? 0;
    const startTs = starts[idx];
    if (startTs !== undefined && tr.ts >= startTs) {
      llmMsByNode.set(p.nodeId, (llmMsByNode.get(p.nodeId) ?? 0) + (tr.ts - startTs));
      turnCursorByNode.set(p.nodeId, idx + 1);
    }
  }

  // Per-node cache token attribution from cost.recorded payloads. Run-
  // level totals already live in metrics.totalCacheReadTokens; per-node
  // breakdown isn't projected anywhere, so we sum it here from raw events.
  const costRows = db.prepare(`
    SELECT payload FROM events
    WHERE run_id = ? AND type = 'cost.recorded'
  `).all(r.run_id) as { payload: string }[];
  const cacheReadByNode = new Map<string, number>();
  const cacheWriteByNode = new Map<string, number>();
  // Per-node fresh tokens (input+output) and cost summed straight from
  // cost.recorded — populated even for in-flight nodes that have no
  // fact.node_completed yet, so metrics.nodeCosts hasn't projected them.
  const liveTokensByNode = new Map<string, number>();
  const liveCostByNode = new Map<string, number>();
  for (const cr of costRows) {
    const p = JSON.parse(cr.payload) as {
      nodeId?: string;
      input_tokens?: number;
      output_tokens?: number;
      cost_usd?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };
    if (!p.nodeId) continue;
    if (typeof p.cache_read_tokens === "number") {
      cacheReadByNode.set(p.nodeId, (cacheReadByNode.get(p.nodeId) ?? 0) + p.cache_read_tokens);
    }
    if (typeof p.cache_write_tokens === "number") {
      cacheWriteByNode.set(p.nodeId, (cacheWriteByNode.get(p.nodeId) ?? 0) + p.cache_write_tokens);
    }
    const fresh = (p.input_tokens ?? 0) + (p.output_tokens ?? 0);
    if (fresh > 0) liveTokensByNode.set(p.nodeId, (liveTokensByNode.get(p.nodeId) ?? 0) + fresh);
    if (typeof p.cost_usd === "number") {
      liveCostByNode.set(p.nodeId, (liveCostByNode.get(p.nodeId) ?? 0) + p.cost_usd);
    }
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

  const handlerTypes = handlerTypesFor(r.workflow_sha, r.dot_source);

  const perNode: PerNodeSummary[] = [];
  const allNodeIds = new Set<string>([
    ...Object.keys(metrics.loopCounts ?? {}),
    ...Object.keys(metrics.nodeCosts ?? {}),
    ...wallMsByNode.keys(),
    ...llmMsByNode.keys(),
    ...toolMsByNode.keys(),
    ...modelsByNode.keys(),
    ...toolsByNode.keys(),
    ...cacheReadByNode.keys(),
    ...cacheWriteByNode.keys(),
    ...liveTokensByNode.keys(),
  ]);
  for (const nid of allNodeIds) {
    const tools = toolsByNode.get(nid);
    const toolList = tools
      ? [...tools.entries()]
          .map(([tool, v]) => ({ tool, n: v.n, n_errors: v.n_errors }))
          .sort((a, b) => b.n - a.n)
      : [];
    // Sub-agent execution contexts ("__subagent:<hash>") aren't DOT nodes:
    // their cost.recorded rolls into the parent's fact.node_completed and
    // never projects to metrics.nodeCosts. The cost.recorded sum is their
    // only — and final — accounting, so they're never "partial".
    const isSubagent = nid.startsWith("__subagent:");
    // metrics.nodeCosts projects on fact.node_completed / fact.node_aborted.
    // Absent there but present in cost.recorded => the node is still running;
    // fall back to the live sums and flag the figures partial.
    const flushed = metrics.nodeCosts?.[nid];
    const partial = !isSubagent && flushed === undefined && liveTokensByNode.has(nid);
    const wall = Math.round((wallMsByNode.get(nid) ?? 0) / 1000);
    const llm = Math.round((llmMsByNode.get(nid) ?? 0) / 1000);
    const tool = Math.round((toolMsByNode.get(nid) ?? 0) / 1000);
    perNode.push({
      node_id: nid,
      handler_type: isSubagent ? "subagent" : handlerTypes.get(nid) ?? null,
      loop_count: metrics.loopCounts?.[nid] ?? 0,
      tokens: flushed?.tokens ?? liveTokensByNode.get(nid) ?? 0,
      cost_usd: flushed?.costUsd ?? liveCostByNode.get(nid) ?? 0,
      partial,
      models: [...(modelsByNode.get(nid) ?? [])],
      wall_seconds: wall,
      llm_seconds: llm,
      tool_seconds: tool,
      dispatch_seconds: Math.max(0, wall - llm - tool),
      cache_read_tokens: cacheReadByNode.get(nid) ?? 0,
      cache_write_tokens: cacheWriteByNode.get(nid) ?? 0,
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
  node_type: string | null;
  in_runs: number;
  // Count of this node's runs whose tokens/cost were still partial (node
  // in flight) at collection time — see PerNodeSummary.partial.
  partial_in_runs: number;
  models: string[];
  mean_cost_usd: number;
  mean_tokens: number;
  mean_wall_seconds: number;
  mean_llm_seconds: number;
  mean_tool_seconds: number;
  mean_dispatch_seconds: number;
  mean_cache_read_tokens: number;
  cache_read_ratio: number;
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
    partialRuns: number;
    handlerType: string | null;
    cost: number;
    tokens: number;
    wallSeconds: number;
    llmSeconds: number;
    toolSeconds: number;
    dispatchSeconds: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
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
        n: 0, partialRuns: 0, handlerType: null as string | null,
        cost: 0, tokens: 0, wallSeconds: 0, llmSeconds: 0, toolSeconds: 0,
        dispatchSeconds: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0, maxLoop: 0,
        models: new Set<string>(), toolUse: new Map<string, { n: number; n_errors: number }>(),
      };
      slot.n++;
      if (pn.partial) slot.partialRuns++;
      if (pn.handler_type) slot.handlerType = pn.handler_type;
      slot.cost += pn.cost_usd;
      slot.tokens += pn.tokens;
      slot.wallSeconds += pn.wall_seconds;
      slot.llmSeconds += pn.llm_seconds;
      slot.toolSeconds += pn.tool_seconds;
      slot.dispatchSeconds += pn.dispatch_seconds;
      slot.cacheReadTokens += pn.cache_read_tokens;
      slot.cacheWriteTokens += pn.cache_write_tokens;
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
    .map(([node_id, v]) => {
      const cacheRead = v.cacheReadTokens;
      const fresh = v.tokens;
      const denom = cacheRead + fresh;
      return {
        node_id,
        node_type: v.handlerType,
        in_runs: v.n,
        partial_in_runs: v.partialRuns,
        models: [...v.models],
        mean_cost_usd: Number((v.cost / v.n).toFixed(4)),
        mean_tokens: Math.round(v.tokens / v.n),
        mean_wall_seconds: Math.round(v.wallSeconds / v.n),
        mean_llm_seconds: Math.round(v.llmSeconds / v.n),
        mean_tool_seconds: Math.round(v.toolSeconds / v.n),
        mean_dispatch_seconds: Math.round(v.dispatchSeconds / v.n),
        mean_cache_read_tokens: Math.round(cacheRead / v.n),
        cache_read_ratio: denom === 0 ? 0 : Number((cacheRead / denom).toFixed(3)),
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
      };
    })
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

process.stdout.write(JSON.stringify(report));
db.close();
