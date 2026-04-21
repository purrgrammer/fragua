// DB-backed HTTP routes — ARCHITECTURE.md §7.
//
// All writes are intents (writer: "web"). Daemon-facing facts are never
// written here. Reads hit the store projection directly and work even when
// the daemon is offline.

import type { Database } from "bun:sqlite";
import { InvalidDurationError, parseDotSource, parseDurationMs } from "@swarm/core";
import { type IEventStore, type StoredEvent, sha256Hex } from "@swarm/store";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { newRunId } from "./run-id.ts";

/** Per-node model-resolution check injected by the daemon. Returns a
 * non-empty array of node-level offenders when one or more declared
 * `(provider, model)` pairs don't resolve in the provider registry. */
export type WorkflowModelValidator = (
  dotSource: string,
) =>
  | { ok: true }
  | { ok: false; offenders: Array<{ nodeId: string; provider?: string; model: string; reason: string }> };

export interface ServerDeps {
  store: IEventStore;
  /** Poll interval for SSE streams in ms. */
  ssePollMs?: number;
  /** Used by tests to deterministically cap stream lifetimes. */
  now?: () => number;
  /**
   * Preflight: resolves to {ok: true} when at least one provider API key
   * is available in the daemon's environment, {ok: false, ...} when the
   * daemon has no credentials for any supported LLM provider. Returns
   * undefined to skip preflight (tests, API-only mode). Injected rather
   * than hard-coded so tests can force both branches and future work
   * can check per-workflow provider overrides.
   */
  preflightProviders?: () => { ok: true } | { ok: false; detail: string };
  /**
   * Validate every codergen node's `(provider, model)` declaration at
   * workflow registration. Rejects typos that would otherwise only
   * surface mid-run (after an expensive `plan` phase already spent
   * tokens). Injected rather than imported so @swarm/server stays
   * free of the pi-ai dependency; the daemon wires in the real
   * resolver on startup.
   */
  validateWorkflowModels?: WorkflowModelValidator;
}

const DEFAULT_SSE_POLL_MS = 100;

/** Known provider env vars. Order matches `swarm providers` display. */
const PROVIDER_ENV_KEYS: ReadonlyArray<{ provider: string; envKey: string }> = [
  { provider: "anthropic", envKey: "ANTHROPIC_API_KEY" },
  { provider: "openrouter", envKey: "OPENROUTER_API_KEY" },
  { provider: "openai", envKey: "OPENAI_API_KEY" },
  { provider: "google", envKey: "GEMINI_API_KEY" },
  { provider: "groq", envKey: "GROQ_API_KEY" },
];

/** Legacy env-based preflight. Retained for callers that haven't been
 * updated to the registry-backed version. New code should construct a
 * preflight from an `AuthStorage` / `ModelRegistry` pair so it sees
 * auth.json / OAuth tokens too — see `registryPreflight` below. */
export function envProviderPreflight(): { ok: true } | { ok: false; detail: string } {
  const present: string[] = [];
  for (const { provider, envKey } of PROVIDER_ENV_KEYS) {
    if ((process.env[envKey] ?? "").length > 0) present.push(provider);
  }
  if (present.length > 0) return { ok: true };
  const expected = PROVIDER_ENV_KEYS.map((p) => p.envKey).join(", ");
  return {
    ok: false,
    detail: `no provider API key set on the daemon (expected one of ${expected})`,
  };
}

/**
 * Scan a DOT source for nodes with malformed `timeout=` or `maxMs=`
 * attrs. Returns the first offender so the API can reject before a
 * workflow is saved (and therefore before any run is enqueued against
 * a broken sha). Returns `null` when every timeout attr parses, the
 * DOT is unparseable (graph-validation errors surface elsewhere), or
 * nothing is set.
 */
function findInvalidTimeoutAttr(
  dotSource: string,
): { nodeId: string; attr: "timeout" | "maxMs"; value: unknown; detail: string } | null {
  let graph: ReturnType<typeof parseDotSource>;
  try {
    graph = parseDotSource(dotSource);
  } catch {
    return null;
  }
  for (const node of Object.values(graph.nodes)) {
    const { timeout, maxMs } = node.attrs;
    if (typeof maxMs === "number") {
      try {
        parseDurationMs(maxMs);
      } catch (err) {
        return {
          nodeId: node.id,
          attr: "maxMs",
          value: maxMs,
          detail: err instanceof InvalidDurationError ? err.message : String(err),
        };
      }
    } else if (maxMs != null) {
      return { nodeId: node.id, attr: "maxMs", value: maxMs, detail: "maxMs must be a positive integer (ms)" };
    }
    if (typeof timeout === "string") {
      try {
        parseDurationMs(timeout);
      } catch (err) {
        return {
          nodeId: node.id,
          attr: "timeout",
          value: timeout,
          detail: err instanceof InvalidDurationError ? err.message : String(err),
        };
      }
    }
  }
  return null;
}

/** Registry-backed preflight. Rejects only when no provider in the
 * registry has any configured credential — honours auth.json api_key,
 * auth.json oauth, env vars, and custom models.json providers. Returned
 * as a closure so the caller can share one AuthStorage across calls. */
export function registryPreflight(args: {
  hasAnyAuth: () => boolean;
}): () => { ok: true } | { ok: false; detail: string } {
  return () => {
    if (args.hasAnyAuth()) return { ok: true };
    return {
      ok: false,
      detail:
        "no provider credentials configured (auth.json, env, or models.json). run `swarm providers add <provider>` or `swarm providers login <provider>`.",
    };
  };
}

export function createRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;

  // ─── Workflow upload ────────────────────────────────────────

  app.post("/workflows", async (c) => {
    const body = await readJson<{ name?: string; dotSource?: string }>(c);
    if (
      !body ||
      typeof body.name !== "string" ||
      body.name.length === 0 ||
      typeof body.dotSource !== "string" ||
      body.dotSource.length === 0
    ) {
      return c.json({ error: "name and dotSource required" }, 400);
    }
    if (deps.validateWorkflowModels != null) {
      const check = deps.validateWorkflowModels(body.dotSource);
      if (!check.ok) {
        return c.json(
          {
            error: "workflow has unresolved model declarations",
            code: "model_unresolved",
            offenders: check.offenders,
          },
          400,
        );
      }
    }
    const timeoutOffender = findInvalidTimeoutAttr(body.dotSource);
    if (timeoutOffender != null) {
      return c.json(
        {
          error: `node "${timeoutOffender.nodeId}": ${timeoutOffender.detail}`,
          code: "invalid_timeout_attr",
          offender: timeoutOffender,
        },
        400,
      );
    }
    const sha = sha256Hex(body.dotSource);
    deps.store.saveWorkflow(sha, body.name, body.dotSource);
    return c.json({ sha, name: body.name });
  });

  // ─── Writes (intents) ───────────────────────────────────────

  app.post("/runs", async (c) => {
    const body = await readJson<{
      workflowSha: string;
      priority?: number;
      runId?: string;
      routing?: Record<string, unknown>;
      /** Positional input — lands in `routing.input`, where the
       * executor's buildSubstitutionArgs() picks it up as $ARGUMENTS. */
      input?: string;
    }>(c);
    if (!body || typeof body.workflowSha !== "string") {
      return c.json({ error: "workflowSha required" }, 400);
    }
    if (deps.preflightProviders != null) {
      const check = deps.preflightProviders();
      if (!check.ok) {
        return c.json({ error: check.detail, code: "provider_unavailable" }, 400);
      }
    }
    const runId = body.runId ?? newRunId();
    const initialRouting: Record<string, unknown> = { ...(body.routing ?? {}) };
    if (typeof body.input === "string" && initialRouting["input"] === undefined) {
      initialRouting["input"] = body.input;
    }
    try {
      deps.store.enqueueRun({
        runId,
        workflowSha: body.workflowSha,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(Object.keys(initialRouting).length > 0 ? { initialRouting } : {}),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ runId });
  });

  app.post("/runs/:id/steer", async (c) => {
    const body = await readJson<{ text?: string }>(c);
    if (!body || typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "text required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.steering_requested",
      payload: { text: body.text },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/pause", (c) => {
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.pause_requested",
      payload: {},
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/cancel", async (c) => {
    const body = (await readJson<{ reason?: string }>(c)) ?? {};
    const payload: { reason?: string } = {};
    if (typeof body.reason === "string") payload.reason = body.reason;
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.cancel_requested",
      payload,
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/hitl", async (c) => {
    const body = await readJson<{ input: unknown }>(c);
    if (!body || !("input" in body)) {
      return c.json({ error: "input required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.hitl_input",
      payload: { input: body.input },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/unquarantine", async (c) => {
    const body = await readJson<{
      resolution?: "treat_as_done" | "retry" | "cancel";
      note?: string;
    }>(c);
    if (!body || (body.resolution !== "treat_as_done" && body.resolution !== "retry" && body.resolution !== "cancel")) {
      return c.json({ error: "resolution required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.unquarantine",
      payload: { resolution: body.resolution, note: body.note ?? "" },
    });
    return c.json({ seq });
  });

  app.post("/runs/:id/priority", async (c) => {
    const body = await readJson<{ newPriority?: number; note?: string }>(c);
    if (!body || typeof body.newPriority !== "number") {
      return c.json({ error: "newPriority required" }, 400);
    }
    const { seq } = deps.store.appendIntent(c.req.param("id"), {
      type: "intent.priority_adjusted",
      payload: { newPriority: body.newPriority, note: body.note ?? "" },
    });
    return c.json({ seq });
  });

  // ─── Reads ──────────────────────────────────────────────────
  //
  // `GET /runs/:id` is served by `storeRunsRoutes` (RunDetail shape).
  // Raw events + messages stay here because they want `since`/`limit`
  // pagination that the detail adapter doesn't expose.

  app.get("/runs/:id/events", (c) => {
    const sinceSeq = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
    const events = deps.store.getEvents(c.req.param("id"), {
      sinceSeq,
      limit,
    });
    return c.json(events);
  });

  app.get("/runs/:id/messages", (c) => {
    const since = Number(c.req.query("since") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 1000), 5000);
    const msgs = deps.store.getMessages(c.req.param("id"), {
      sinceOrdinal: since,
      limit,
    });
    return c.json(msgs);
  });

  // ─── SSE stream ─────────────────────────────────────────────

  app.get("/runs/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("id");
      const lastEventId = c.req.header("Last-Event-ID");
      let lastSeq = lastEventId != null ? Number(lastEventId) : 0;
      if (!Number.isFinite(lastSeq) || lastSeq < 0) lastSeq = 0;

      while (!stream.aborted) {
        const batch = deps.store.getEvents(runId, {
          sinceSeq: lastSeq,
          limit: 500,
        });
        for (const event of batch) {
          await stream.writeSSE({
            id: String(event.seq),
            event: event.type,
            data: serializeEvent(event),
          });
          lastSeq = event.seq;
        }
        if (batch.length === 0) await stream.sleep(pollMs);
      }
    }),
  );

  // ─── Store-level metrics (performance) ──────────────────────

  app.get("/metrics/store", (c) => {
    const store = deps.store as unknown as {
      metricsSnapshot?: () => unknown;
    };
    if (typeof store.metricsSnapshot !== "function") {
      return c.json({ error: "metrics unavailable" }, 503);
    }
    return c.json(store.metricsSnapshot());
  });

  // ─── Aggregate metrics (dashboard) ──────────────────────────

  app.get("/metrics/global", (c) => {
    const windowHours = Number(c.req.query("windowHours") ?? 24 * 30);
    const cutoffMs = (deps.now?.() ?? Date.now()) - windowHours * 3_600_000;
    const db = unsafeDb(deps.store);
    if (db == null) return c.json({ error: "metrics unavailable" }, 503);

    const global = db
      .query<
        {
          total_runs: number;
          total_usd: number | null;
          total_tokens: number | null;
          successful: number;
          halted: number;
          running: number;
          queued: number;
          paused: number;
          quarantined: number;
        },
        [number]
      >(
        `SELECT
           COUNT(*) AS total_runs,
           SUM(total_cost_usd) AS total_usd,
           SUM(total_tokens)   AS total_tokens,
           SUM(CASE WHEN status = 'completed'  THEN 1 ELSE 0 END) AS successful,
           SUM(CASE WHEN status = 'halted'     THEN 1 ELSE 0 END) AS halted,
           SUM(CASE WHEN status = 'running'    THEN 1 ELSE 0 END) AS running,
           SUM(CASE WHEN status = 'queued'     THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN status = 'paused_hitl' THEN 1 ELSE 0 END) AS paused,
           SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END) AS quarantined
         FROM run_state
         WHERE updated_at >= ?`,
      )
      .get(cutoffMs) ?? {
      total_runs: 0,
      total_usd: 0,
      total_tokens: 0,
      successful: 0,
      halted: 0,
      running: 0,
      queued: 0,
      paused: 0,
      quarantined: 0,
    };

    // Per-model breakdown via json_each pivot.
    const models = db
      .query<{ model_name: string; tokens: number; cost_usd: number }, [number]>(
        `SELECT
           kv.key  AS model_name,
           SUM(CAST(json_extract(kv.value, '$.tokens') AS INTEGER))  AS tokens,
           SUM(CAST(json_extract(kv.value, '$.costUsd') AS REAL))    AS cost_usd
         FROM run_state, json_each(run_state.metrics, '$.models') AS kv
         WHERE updated_at >= ?
         GROUP BY kv.key
         ORDER BY cost_usd DESC`,
      )
      .all(cutoffMs);

    return c.json({
      ...global,
      breakdownByModel: models,
    });
  });

  return app;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function serializeEvent(event: StoredEvent): string {
  return JSON.stringify({
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    writer: event.writer,
    payload: event.payload,
    ts: event.ts,
  });
}

function unsafeDb(store: IEventStore): Database | null {
  const raw = (store as unknown as { db?: Database }).db;
  return raw ?? null;
}
