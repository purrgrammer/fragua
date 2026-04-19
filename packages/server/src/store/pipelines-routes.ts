// Store-backed /pipelines/* and /runs/* reads for the web UI.
//
// Everything a PipelineSummary / PipelineDetail carries is derived from
// run_state + the event log. Workflow name/source comes from the
// workflows table (saveWorkflow writes DOT on enqueue).

import { Hono } from "hono";
import type { IEventStore } from "@swarm/store";
import { listRuns, runStateToDetail, runStateToSummary } from "./pipelines-adapter.ts";
import type { WorkflowReader } from "../ports.ts";

export interface PipelinesRoutesOpts {
  store: IEventStore;
  /** Optional workflow reader for resolving workflow display names. */
  workflowReader?: WorkflowReader;
}

export function storePipelinesRoutes(opts: PipelinesRoutesOpts): Hono {
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

  app.get("/pipelines", async (c) => {
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

  app.get("/pipelines/:id", async (c) => {
    const runId = c.req.param("id");
    const state = store.getState(runId);
    if (state == null) {
      return c.json(
        { error: "run not found", code: "not_found", details: { runId } },
        404,
      );
    }
    const events = store.getEvents(runId, { limit: 10_000 });
    const wf = store.getWorkflow(state.workflowSha);
    const name = wf?.name;
    const source = wf?.dotSource;
    return c.json(runStateToDetail(state, events, name, source));
  });

  // Bulk events endpoint the UI mounts on detail. Returns raw store events
  // as-is (fact.* and intent.* payloads); the web adapter translates.
  app.get("/pipelines/:id/events.json", (c) => {
    const runId = c.req.param("id");
    if (store.getState(runId) == null) {
      return c.json({ error: "run not found" }, 404);
    }
    return c.json(store.getEvents(runId, { limit: 10_000 }));
  });

  return app;
}
