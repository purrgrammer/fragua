// Store-backed /runs/* summary + detail reads for the web UI.
//
// Everything a RunSummary / RunDetail carries is derived from
// run_state + the event log. Workflow name/source comes from the
// workflows table (saveWorkflow writes the source on enqueue).

import { type IEventStore, isTerminal as isTerminalStatus, type RunStatus } from "@fragua/store";
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
    //   ?project_id=<id>              — narrow to a project by IDENTITY
    //                                   (portable; folds clones/imports).
    //   ?cwd=<path>                   — narrow to a single project LOCATION.
    //   ?inbox=pending|acted|discarded — narrow to a worktree inbox status.
    //   ?order=oldest                 — surface longest-waiting first (Inbox).
    //   ?limit=N                      — cap the result, clamped to [1, 200].
    // Unknown statuses are dropped silently — a typo shouldn't 400 a
    // list endpoint that older clients hit on every page load.
    const statusParam = c.req.query("status");
    const statuses = statusParam !== undefined ? parseStatusList(statusParam) : undefined;
    const cwdParam = c.req.query("cwd");
    const projectIdParam = c.req.query("project_id");
    const order: "newest" | "oldest" = c.req.query("order") === "oldest" ? "oldest" : "newest";
    const limit = parseLimit(c.req.query("limit"));
    const inboxParam = c.req.query("inbox");
    const queryOpts: Parameters<typeof store.listRunSummaryRows>[0] = { order };
    if (statuses !== undefined) queryOpts.statuses = statuses;
    if (cwdParam !== undefined && cwdParam.length > 0) queryOpts.cwd = cwdParam;
    if (projectIdParam !== undefined && projectIdParam.length > 0) queryOpts.projectId = projectIdParam;
    if (limit !== undefined) queryOpts.limit = limit;
    if (inboxParam === "pending" || inboxParam === "acted" || inboxParam === "discarded") {
      queryOpts.inbox = inboxParam;
    }
    return c.json(store.listRunSummaryRows(queryOpts).map(runSummaryRowToSummary));
  });

  app.get("/runs/:id", async (c) => {
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    const events = store.getEvents(runId);
    const wf = state.workflowSha != null ? store.getWorkflow(state.workflowSha) : null;
    const name = wf?.name;
    const source = wf?.source;
    const detail = runStateToDetail(state, events, name, source);
    detail.lastEventSeq = events.at(-1)?.seq ?? 0;
    return c.json(detail);
  });

  // Full event log. Returns raw store events as-is (fact.* and
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
    const steps = attachStepAggregates(eventsToSteps(events), store.getStepAggregates(runId)).map((step, stepIdx) => ({
      ...step,
      stepIdx,
    }));
    // Fill `durationMs` for orphan steps (no `llm.done` in the window).
    // Each step's effective end is the next step's `startedAt`, falling
    // back to the run's last event timestamp when the run is terminal.
    // The truly-still-running last step on a live run keeps `durationMs`
    // undefined so the client ticks `now - startedAt`.
    const lastEventTs = events.length > 0 ? Math.max(...events.map((event) => event.ts)) : undefined;
    const filled = fillOrphanDurations(steps, {
      lastEventTs,
      runIsTerminal: isTerminalStatus(state.status),
    });
    return c.json(filled);
  });

  // LLM-visible message transcript (§I9). Sourced from the messages
  // table, populated by PiLlmBackend as each agent turn ends.
  // Optional `?nodeId=` filter for per-thread history; `?sinceOrdinal=`
  // for resume-style pagination. AgentMessage JSON round-trips
  // losslessly — the messages table is the source of truth for
  // rehydrating prior turns on threaded nodes across daemon restarts.
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
  "paused",
  "paused_human",
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
