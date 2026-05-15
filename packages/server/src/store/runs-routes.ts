// Store-backed /runs/* summary + detail reads for the web UI.
//
// Everything a RunSummary / RunDetail carries is derived from
// run_state + the event log. Workflow name/source comes from the
// workflows table (saveWorkflow writes DOT on enqueue).

import { type IEventStore, isTerminal as isTerminalStatus, type RunStatus } from "@swarm/store";
import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";
import { runStateToDetail, runSummaryRowToSummary } from "./runs-adapter.ts";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations } from "./steps.ts";

export interface RunsRoutesOpts {
  store: IEventStore;
  /** Optional workflow reader for resolving workflow display names. */
  workflowReader?: WorkflowReader;
}

export function storeRunsRoutes(opts: RunsRoutesOpts): Hono {
  const app = new Hono();
  const { store } = opts;

  app.get("/runs", (c) => {
    // Query params (all optional, all enforced server-side):
    //   ?status=a,b,c                 — narrow to specific lifecycle statuses.
    //   ?cwd=<path>                   — narrow to a single project root.
    //   ?order=oldest                 — surface longest-waiting first (Inbox).
    //   ?limit=N                      — cap the result, clamped to [1, 200].
    //   ?includeChildAttention=true   — widen status filter to "self OR
    //                                   descendant matches". Used by
    //                                   the Inbox so a parent whose child
    //                                   paused on budget still surfaces.
    //                                   No-op without ?status. Sub-runs
    //                                   themselves are never returned
    //                                   (topLevelOnly stays on).
    // Unknown statuses are dropped silently — a typo shouldn't 400 a
    // list endpoint that older clients hit on every page load.
    const statusParam = c.req.query("status");
    const statuses = statusParam !== undefined ? parseStatusList(statusParam) : undefined;
    const cwdParam = c.req.query("cwd");
    const order: "newest" | "oldest" = c.req.query("order") === "oldest" ? "oldest" : "newest";
    const limit = parseLimit(c.req.query("limit"));
    const includeChildAttention = c.req.query("includeChildAttention") === "true";
    const queryOpts: Parameters<typeof store.listRunSummaryRows>[0] = { order, topLevelOnly: true };
    if (statuses !== undefined) queryOpts.statuses = statuses;
    if (cwdParam !== undefined && cwdParam.length > 0) queryOpts.cwd = cwdParam;
    if (limit !== undefined) queryOpts.limit = limit;
    if (includeChildAttention && statuses !== undefined) queryOpts.includeChildAttention = true;
    return c.json(store.listRunSummaryRows(queryOpts).map(runSummaryRowToSummary));
  });

  app.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    // Uncapped — `runStateToDetail` derives `nodes` + `selectedEdges`
    // from the event log; capping the input dropped later nodes on big
    // runs. The derivations themselves filter to a handful of event
    // types per walk, so total work stays bounded.
    const parentEvents = store.getEvents(runId);
    const events = store.getEventsFeedWithDescendants(runId);
    const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
    const name = wf?.name;
    const source = wf?.dotSource;
    // Pull descendant-derived projections so the run-detail page can
    // light branches on the graph and render the digest in its header
    // without a second round trip. Each is one cheap SQL query and
    // collapses to a no-op when the run has no children.
    const effectiveActiveNodes = store.activeDescendantNodes(runId);
    const digestRow = store.childStatusDigest(runId);
    const detailOpts: Parameters<typeof runStateToDetail>[4] = {};
    if (effectiveActiveNodes.length > 0) detailOpts.effectiveActiveNodes = effectiveActiveNodes;
    if (digestRow != null) {
      detailOpts.childStatusDigest = {
        total: digestRow.total,
        running: digestRow.running,
        runningChildren: digestRow.runningChildren,
        paused: digestRow.paused,
        pausedHitl: digestRow.pausedHitl,
        pausedAuto: digestRow.pausedAuto,
        queued: digestRow.queued,
        completed: digestRow.completed,
        cancelled: digestRow.cancelled,
        halted: digestRow.halted,
        quarantined: digestRow.quarantined,
      };
    }
    const detail = runStateToDetail(state, events, name, source, detailOpts);
    detail.lastEventSeq = parentEvents.at(-1)?.seq ?? 0;
    return c.json(detail);
  });

  // Sub-runs view for a parent — P5 of docs/proposals/parallel.md.
  // Returns the summary row for every run whose `parent_run_id`
  // matches `:id`, sorted by `parallel_index`. The UI renders this as
  // a "child runs" section on the parent's run-detail page.
  app.get("/runs/:id/children", (c) => {
    const parentRunId = c.req.param("id");
    // Discover child run-ids via the SQL helper. Each child's full
    // summary is built from its own state + event tail. We also look
    // up the parent's title so sub-runs inherit it (P5 — operator
    // surface treats fan-outs as one logical run).
    const children = store
      .listRunSummaryRows({ parentRunId })
      .map(runSummaryRowToSummary)
      .sort((a, b) => (a.parallelIndex ?? 0) - (b.parallelIndex ?? 0));
    return c.json({ children });
  });

  // Full-fidelity event log. Returns raw store events as-is (fact.* and
  // intent.* payloads); the web adapter translates. Uncapped — this is
  // the canonical "give me everything that happened" endpoint, used for
  // ad-hoc debugging (`curl /api/runs/:id/events.json | jq …`) and as
  // the source of truth for any post-hoc reducer. Per-step / per-message
  // shapes have their own narrowed endpoints (`/messages`, `/steps`).
  app.get("/runs/:id/events.json", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found" }, 404);
    }
    // `?include=descendants` returns the parent + every sub-run's
    // events merged into one (ts, runId, seq)-ordered stream, with
    // each sub-run row carrying its branch linkage. D2 of
    // `docs/proposals/parallel.md`. The web run-detail page uses this
    // so the conversation, graph, and cost surfaces stay coherent
    // when parallel sub-runs are involved. Default (no param) is the
    // simple per-run query for backward compat and lightweight tools.
    if (c.req.query("include") === "descendants") {
      return c.json(store.getEventsFeedWithDescendants(runId));
    }
    return c.json(store.getEvents(runId));
  });

  app.get("/runs/:id/steps", (c) => {
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    // Two-pass projection:
    //   1. eventsToSteps walks the full event log to extract per-step
    //      static fields (prompt, system_prompt, messages, tools,
    //      context_files, finalText built from text_deltas, …).
    //   2. getStepAggregates runs a SQL window aggregation that sums
    //      cost / token totals per step, keyed by `startSeq`. This is
    //      the single source of truth for numerical totals — folding
    //      cost.recorded events in TypeScript was systematically
    //      under-counting because the agent fires multiple cost events
    //      per step (one per assistant message) and the previous
    //      reducer dropped everything after the first llm.done.
    const events = store.getEventsFeedWithDescendants(runId);
    const eventsByRun = new Map<string, typeof events>();
    for (const event of events) {
      const originRunId = event.originRunId ?? event.runId;
      const bucket = eventsByRun.get(originRunId) ?? [];
      bucket.push(event);
      eventsByRun.set(originRunId, bucket);
    }
    // Sub-run branch metadata: each child run carries its branch root
    // (parent_node_id) + ordinal (parallel_index) on run_state. Stamp
    // them onto every step from a sub-run so CostInspector can nest
    // sub-run rows under their parallel parent — without this, sub-run
    // steps land at top-level with null parentNodeId. The parent run
    // itself has no entry; its own steps already carry parentNodeId
    // from inline branch events when applicable.
    const subRunMeta = new Map<string, { parentNodeId: string; parallelIndex: number }>();
    for (const originRunId of eventsByRun.keys()) {
      if (originRunId === runId) continue;
      const child = store.getState(originRunId);
      if (child?.parentNodeId != null && child.parallelIndex != null) {
        subRunMeta.set(originRunId, {
          parentNodeId: child.parentNodeId,
          parallelIndex: child.parallelIndex,
        });
      }
    }
    const merged = Array.from(eventsByRun.entries())
      .flatMap(([originRunId, originEvents]) => {
        const meta = subRunMeta.get(originRunId);
        const steps = attachStepAggregates(
          eventsToSteps(originEvents.map((event) => ({ ...event, originRunId }))),
          store.getStepAggregates(originRunId),
        );
        if (meta == null) return steps;
        // Stamp sub-run's parallel parent on every step that doesn't
        // already carry one (some sub-run steps may come from a
        // nested toolCall — preserve those).
        return steps.map((s) =>
          s.parentNodeId == null ? { ...s, parentNodeId: meta.parentNodeId, parallelIndex: meta.parallelIndex } : s,
        );
      })
      .sort(
        (a, b) =>
          Date.parse(a.startedAt) - Date.parse(b.startedAt) ||
          a.originRunId?.localeCompare(b.originRunId ?? "") ||
          a.startSeq - b.startSeq,
      )
      .map((step, stepIdx) => ({ ...step, stepIdx }));
    // Fill `durationMs` for orphan steps (no `llm.done` in the window).
    // Each step's effective end is the next step's `startedAt`, falling
    // back to the run's last event timestamp when the run is terminal.
    // The truly-still-running last step on a live run keeps `durationMs`
    // undefined so the client ticks `now - startedAt`.
    const lastEventTs = events.length > 0 ? Math.max(...events.map((event) => event.ts)) : undefined;
    const filled = fillOrphanDurations(merged, {
      lastEventTs,
      runIsTerminal: isTerminalStatus(state.status),
    });
    return c.json(filled);
  });

  // LLM-visible message transcript (§I9). Sourced from the messages
  // table, populated by PiCodergenBackend as each agent turn ends.
  // Optional `?nodeId=` filter for per-thread history; `?sinceOrdinal=`
  // for resume-style pagination. AgentMessage JSON round-trips
  // losslessly — the messages table is the source of truth for
  // rehydrating prior turns across daemon restarts at fidelity=full.
  //
  // Returns the *narrow* wire shape: `{ ordinal, nodeId, content }` —
  // `runId` (already pinned by the URL) and `iteration` (unused by the
  // web UI) are skipped at the SQL projection layer, not in JS, so
  // SQLite never materialises them into a row buffer.
  //
  // No `limit` is applied — the transcript view shows the full list.
  // Clients that need paging pass `?sinceOrdinal=<last>`.
  app.get("/runs/:id/messages", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    const nodeIdParam = c.req.query("nodeId");
    const sinceParam = c.req.query("sinceOrdinal");
    const limitParam = c.req.query("limit");
    const includeParam = c.req.query("include");
    // `?include=descendants` merges parent + sub-run messages, each
    // row stamped with `originRunId`. P8 of the sub-runs UI plan —
    // drives the conversation surface for parents with parallel
    // sub-runs. The per-node filter is incompatible with the merge
    // (different runs have independent node ids; merging would mix
    // unrelated streams), and per-run ordinals are independent too,
    // so descendants mode ignores both `?nodeId` and `?sinceOrdinal`.
    if (includeParam === "descendants") {
      const opts: Parameters<typeof store.getMessagesNarrowWithDescendants>[1] = {};
      if (limitParam) {
        const n = Number(limitParam);
        if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
      }
      return c.json(store.getMessagesNarrowWithDescendants(runId, opts));
    }
    const opts: Parameters<typeof store.getMessagesNarrow>[1] = {};
    if (nodeIdParam) opts.nodeId = nodeIdParam;
    if (sinceParam) {
      const n = Number(sinceParam);
      if (Number.isFinite(n) && n >= 0) opts.sinceOrdinal = Math.floor(n);
    }
    if (limitParam) {
      const n = Number(limitParam);
      if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
    }
    return c.json(store.getMessagesNarrow(runId, opts));
  });

  return app;
}

const VALID_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "queued",
  "running",
  "running_children",
  "paused",
  "paused_hitl",
  "paused_auto",
  "completed",
  "cancelled",
  "halted",
  "quarantined",
]);

const LIMIT_MAX = 200;

/** Parse + clamp `?limit=N`. Non-numeric or `<= 0` returns undefined
 * (no cap). The clamp guards against a malformed client asking the
 * server for an unbounded scan. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), LIMIT_MAX);
}

/** Parse `?status=a,b,c` into a deduped list of valid `RunStatus`
 * literals. Empty + invalid tokens are dropped. */
function parseStatusList(raw: string): RunStatus[] {
  const out = new Set<RunStatus>();
  for (const token of raw.split(",")) {
    const t = token.trim() as RunStatus;
    if (VALID_STATUSES.has(t)) out.add(t);
  }
  return [...out];
}
