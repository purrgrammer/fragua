// Store-backed /runs/* summary + detail reads for the web UI.
//
// Everything a RunSummary / RunDetail carries is derived from
// run_state + the event log. Workflow name/source comes from the
// workflows table (saveWorkflow writes DOT on enqueue).

import type { IEventStore } from "@swarm/store";
import { Hono } from "hono";
import type { WorkflowReader } from "../ports.ts";
import { listRuns, runStateToDetail, runStateToSummary } from "./runs-adapter.ts";
import { eventsToSteps } from "./steps.ts";

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
    const ids = listRuns(store);
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
    const events = store.getEvents(runId, { limit: 10_000 });
    const wf = store.getWorkflow(state.workflowSha);
    const name = wf?.name;
    const source = wf?.dotSource;
    return c.json(runStateToDetail(state, events, name, source));
  });

  // Bulk events endpoint the UI mounts on detail. Returns raw store events
  // as-is (fact.* and intent.* payloads); the web adapter translates.
  app.get("/runs/:id/events.json", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json(store.getEvents(runId, { limit: 10_000 }));
  });

  app.get("/runs/:id/steps", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    const events = store.getEvents(runId, { limit: 10_000 });
    return c.json(eventsToSteps(events));
  });

  // LLM-visible message transcript (§I9). Sourced from the messages
  // table, populated by PiCodergenBackend as each agent turn ends.
  // Optional `?nodeId=` filter for per-thread history; `?sinceOrdinal=`
  // for resume-style pagination. Plaintext only — §3.6's
  // fidelity=full → summary:high degrade on resume means we never
  // need structured AgentMessage shapes to cross a daemon boundary.
  app.get("/runs/:id/messages", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found", code: "not_found", details: { runId } }, 404);
    }
    // No silent cap: a finished run's transcript is the point of this
    // endpoint. Clients that need paging can use `?sinceOrdinal=`. The
    // store's default `limit` still applies when `?limit=` is unset,
    // but we bump it here so a long run isn't truncated mid-read.
    const nodeIdParam = c.req.query("nodeId");
    const sinceParam = c.req.query("sinceOrdinal");
    const limitParam = c.req.query("limit");
    const opts: Parameters<typeof store.getMessages>[1] = { limit: Number.MAX_SAFE_INTEGER };
    if (nodeIdParam) opts.nodeId = nodeIdParam;
    if (sinceParam) {
      const n = Number(sinceParam);
      if (Number.isFinite(n) && n >= 0) opts.sinceOrdinal = Math.floor(n);
    }
    if (limitParam) {
      const n = Number(limitParam);
      if (Number.isFinite(n) && n > 0) opts.limit = Math.floor(n);
    }
    return c.json(store.getMessages(runId, opts));
  });

  return app;
}
