// Store-backed /runs/* summary + detail reads for the web UI.
//
// Everything a RunSummary / RunDetail carries is derived from
// run_state + the event log. The projection logic lives in the shared read
// plane (`@fragua/core/read-plane`); these handlers parse query params and
// delegate to `readPlane.*`, so the HTTP surface and any other read client
// share one projection.

import { makeReadPlane } from "@fragua/core/read-plane";
import type { IEventStore, RunStatus } from "@fragua/store";
import { RUN_STATUSES } from "@fragua/types";
import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";

export interface RunsRoutesOpts {
  store: IEventStore;
  /** Optional workflow reader for resolving workflow display names. */
  workflowReader?: WorkflowReader;
}

export function storeRunsRoutes(opts: RunsRoutesOpts): Hono {
  const app = new Hono();
  const { store } = opts;
  const readPlane = makeReadPlane({ store });

  app.get("/runs", (c) => {
    // Query params (all optional, all enforced server-side):
    //   ?status=a,b,c                 — narrow to specific lifecycle statuses.
    //   ?project_id=<id>              — narrow to a project by IDENTITY
    //                                   (portable; folds clones/imports).
    //   ?cwd=<path>                   — narrow to a single project LOCATION.
    //   ?inbox=pending|acted|discarded — narrow to a worktree inbox status.
    //   ?order=oldest                 — surface longest-waiting first (Inbox).
    //   ?limit=N                      — cap the result, clamped to [1, 200].
    //   ?exclude_imported=true        — omit imported (inert) runs; used by
    //                                   the Inbox to keep worklist clean.
    // Unknown statuses are dropped silently — a typo shouldn't 400 a
    // list endpoint that older clients hit on every page load.
    const statusParam = c.req.query("status");
    const statuses = statusParam !== undefined ? parseStatusList(statusParam) : undefined;
    const cwdParam = c.req.query("cwd");
    const projectIdParam = c.req.query("project_id");
    const order: "newest" | "oldest" = c.req.query("order") === "oldest" ? "oldest" : "newest";
    const limit = parseLimit(c.req.query("limit"));
    const inboxParam = c.req.query("inbox");
    const excludeImportedParam = c.req.query("exclude_imported");
    const queryOpts: Parameters<typeof store.listRunSummaryRows>[0] = { order };
    if (statuses !== undefined) queryOpts.statuses = statuses;
    if (cwdParam !== undefined && cwdParam.length > 0) queryOpts.cwd = cwdParam;
    if (projectIdParam !== undefined && projectIdParam.length > 0) queryOpts.projectId = projectIdParam;
    if (limit !== undefined) queryOpts.limit = limit;
    if (inboxParam === "pending" || inboxParam === "acted" || inboxParam === "discarded") {
      queryOpts.inbox = inboxParam;
    }
    if (excludeImportedParam === "true") queryOpts.excludeImported = true;
    return c.json(readPlane.runSummaries(queryOpts));
  });

  app.get("/runs/:id", (c) => {
    const runId = c.req.param("id");
    const detail = readPlane.runDetail(runId);
    if (detail == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
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
    const events = readPlane.events(runId);
    if (events == null) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json(events);
  });

  app.get("/runs/:id/steps", (c) => {
    const runId = c.req.param("id");
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
    const steps = readPlane.steps(runId);
    if (steps == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json(steps);
  });

  // LLM-visible message transcript (§I9). Sourced from the messages
  // table, populated by PiLlmBackend as each agent turn ends.
  // Optional `?nodeId=` filter for per-thread history; `?sinceOrdinal=`
  // for resume-style pagination. AgentMessage JSON round-trips
  // losslessly — the messages table is the source of truth for
  // rehydrating prior turns on threaded nodes across daemon restarts.
  //
  // Returns the *narrow* wire shape: `{ ordinal, nodeId, iteration, content }` —
  // `runId` is omitted (already pinned by the URL). `iteration` is included
  // so the web transcript can align looped-node sections to their
  // per-iteration nodeState.
  //
  // No `limit` is applied — the transcript view shows the full list.
  // Clients that need paging pass `?sinceOrdinal=<last>`.
  app.get("/runs/:id/messages", (c) => {
    const runId = c.req.param("id");
    const nodeIdParam = c.req.query("nodeId");
    const sinceParam = c.req.query("sinceOrdinal");
    const limitParam = c.req.query("limit");
    const opts: Parameters<typeof readPlane.messages>[1] = {};
    if (nodeIdParam) opts.nodeId = nodeIdParam;
    if (sinceParam) {
      const n = Number(sinceParam);
      if (Number.isFinite(n) && n >= 0) opts.sinceOrdinal = Math.floor(n);
    }
    if (limitParam) {
      const n = Number(limitParam);
      if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
    }
    const messages = readPlane.messages(runId, opts);
    if (messages == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    return c.json(messages);
  });

  return app;
}

const VALID_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(RUN_STATUSES);

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
