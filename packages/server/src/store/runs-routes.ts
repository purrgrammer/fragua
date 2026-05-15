// Store-backed /runs/* summary + detail reads for the web UI.
//
// Everything a RunSummary / RunDetail carries is derived from
// run_state + the event log. Workflow name/source comes from the
// workflows table (saveWorkflow writes DOT on enqueue).

import { type IEventStore, isTerminal as isTerminalStatus, type RunStatus } from "@swarm/store";
import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";
import { listRuns, runStateToDetail, runStateToSummary } from "./runs-adapter.ts";
import { attachStepAggregates, eventsToSteps, fillOrphanDurations } from "./steps.ts";

export interface RunsRoutesOpts {
  store: IEventStore;
  /** Optional workflow reader for resolving workflow display names. */
  workflowReader?: WorkflowReader;
}

export function storeRunsRoutes(opts: RunsRoutesOpts): Hono {
  const app = new Hono();
  const { store } = opts;

  async function workflowName(sha: string): Promise<string | undefined> {
    const row = store.getWorkflow(sha);
    if (row != null) return row.name;
    if (opts.workflowReader != null) {
      const list = await opts.workflowReader.list();
      const match = list.find((w) => w.sha === sha.slice(0, 7) || w.sha === sha);
      return match?.name;
    }
    return undefined;
  }

  app.get("/runs", async (c) => {
    // Query params (all optional, all enforced server-side):
    //   ?status=a,b,c — narrow to specific lifecycle statuses.
    //   ?cwd=<path>   — narrow to a single project root (exact match
    //                    against `run_state.cwd`). Powers per-project
    //                    views; absent runs (NULL cwd) are unreachable.
    //   ?order=oldest — surface longest-waiting first (Inbox semantics).
    //                    Default is newest-first by updated_at.
    //   ?limit=N      — cap the result. Clamped to [1, 200] so a
    //                    malformed client can't ask for everything.
    // Unknown statuses are dropped silently — a typo shouldn't 400 a
    // list endpoint that older clients hit on every page load.
    const statusParam = c.req.query("status");
    const statuses = statusParam !== undefined ? parseStatusList(statusParam) : undefined;
    const cwdParam = c.req.query("cwd");
    const order: "newest" | "oldest" = c.req.query("order") === "oldest" ? "oldest" : "newest";
    const limit = parseLimit(c.req.query("limit"));
    const opts: Parameters<typeof listRuns>[1] = { order };
    if (statuses !== undefined) opts.statuses = statuses;
    if (cwdParam !== undefined && cwdParam.length > 0) opts.cwd = cwdParam;
    if (limit !== undefined) opts.limit = limit;
    const ids = listRuns(store, opts);
    const summaries = [];
    for (const runId of ids) {
      const state = store.getState(runId);
      if (state == null) continue;
      // Hide sub-runs from the top-level list (P5 of
      // docs/proposals/parallel.md). Operators see fan-outs as one
      // logical run; sub-runs surface as nested branches on the
      // parent's detail page. Without this filter every sub-run
      // shows up as a sibling row in the Running tab.
      if (state.parentRunId != null) continue;
      const events = store.getEvents(runId, { limit: 5000 });
      // Conversation runs carry no workflow_sha; skip the lookup.
      const name = state.workflowSha != null ? await workflowName(state.workflowSha) : undefined;
      summaries.push(runStateToSummary(state, events, name));
    }
    return c.json(summaries);
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
    const events = store.getEvents(runId);
    const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
    const name = wf?.name;
    const source = wf?.dotSource;
    return c.json(runStateToDetail(state, events, name, source));
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
    const parentState = store.getState(parentRunId);
    const parentTitle =
      parentState?.title && parentState.title.length > 0 ? parentState.title : undefined;
    const childRunIds = store.listRunIds({ parentRunId });
    const children = childRunIds
      .map((childId) => {
        const childState = store.getState(childId);
        if (childState == null) return null;
        const childEvents = store.getEvents(childId);
        const childWf = childState.workflowSha != null ? store.getWorkflow(childState.workflowSha) : null;
        return runStateToSummary(childState, childEvents, childWf?.name, parentTitle);
      })
      .filter((s): s is NonNullable<typeof s> => s != null)
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
      return c.json(store.getEventsWithDescendants(runId));
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
    const events = store.getEvents(runId);
    const baseSteps = eventsToSteps(events);
    const aggregates = store.getStepAggregates(runId);
    const merged = attachStepAggregates(baseSteps, aggregates);
    // Fill `durationMs` for orphan steps (no `llm.done` in the window).
    // Each step's effective end is the next step's `startedAt`, falling
    // back to the run's last event timestamp when the run is terminal.
    // The truly-still-running last step on a live run keeps `durationMs`
    // undefined so the client ticks `now - startedAt`.
    const lastEventTs = events.length > 0 ? events[events.length - 1]!.ts : undefined;
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
