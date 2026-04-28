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
    // Optional `?status=a,b,c` narrows the result to specific lifecycle
    // statuses (Inbox / Running queries care only about a small slice).
    // Unknown statuses are dropped silently — old clients should never
    // send them, and a typo shouldn't 400 a list endpoint.
    const statusParam = c.req.query("status");
    const statuses = statusParam !== undefined ? parseStatusList(statusParam) : undefined;
    const ids = listRuns(store, statuses !== undefined ? { statuses } : {});
    const summaries = [];
    for (const runId of ids) {
      const state = store.getState(runId);
      if (state == null) continue;
      const events = store.getEvents(runId, { limit: 5000 });
      const name = await workflowName(state.workflowSha);
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
    const wf = store.getWorkflow(state.workflowSha);
    const name = wf?.name;
    const source = wf?.dotSource;
    return c.json(runStateToDetail(state, events, name, source));
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
  "paused_hitl",
  "paused_provider_error",
  "completed",
  "cancelled",
  "halted",
  "quarantined",
]);

/** Parse `?status=a,b,c` into a deduped list of valid `RunStatus`
 * literals. Empty + invalid tokens are dropped. */
function parseStatusList(raw: string): RunStatus[] {
  const out: RunStatus[] = [];
  const seen = new Set<string>();
  for (const token of raw.split(",")) {
    const t = token.trim();
    if (t === "" || seen.has(t)) continue;
    seen.add(t);
    if (VALID_STATUSES.has(t as RunStatus)) out.push(t as RunStatus);
  }
  return out;
}
