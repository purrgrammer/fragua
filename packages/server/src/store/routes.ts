// DB-backed HTTP routes — ARCHITECTURE.md §7.
//
// All writes are intents (writer: "web"). Daemon-facing facts are never
// written here. Reads hit the store projection directly and work even when
// the daemon is offline.

import { InvalidDurationError, parseDotSource, parseDurationMs } from "@swarm/core";
import {
  FEED_EVENT_KINDS,
  type IEventStore,
  type IntentEvent,
  isTerminal as isTerminalStatus,
  PayloadTooLargeError,
  sha256Hex,
} from "@swarm/store";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { WorkflowReader } from "../ports.ts";
import { newRunId } from "./run-id.ts";
import { parseGlobalCursorFromHeader, parseSeqCursorMax, runGlobalFeedLoop, runSseLoop } from "./sse.ts";

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
  /** Per-iteration batch size for SSE replay. Defaults to 500. */
  sseBatchSize?: number;
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
  /**
   * Backpressure cap on `status='queued'` runs. When the queue depth
   * meets or exceeds this number, `POST /runs` returns 429 with a
   * `Retry-After: 30` header instead of accepting the enqueue.
   * `running` runs are NOT counted (those are bounded separately by the
   * daemon's `maxConcurrentRuns`). Undefined = uncapped (current
   * behaviour). Set this to bound the blast radius of a misconfigured
   * client that otherwise fills `run_state` without limit.
   */
  maxQueuedRuns?: number;
  /**
   * Disk-backed workflow source. When set, `POST /runs` accepts the
   * simplified `{ cwd, workflowName, workflowScope? }` shape: the
   * server resolves the named workflow against the same listing the
   * web UI sees (`GET /workflows`), hashes its current contents, and
   * registers it before enqueueing. The CLI's upload-then-enqueue path
   * (`POST /workflows` returning a sha, then `POST /runs` with that
   * sha) keeps working unchanged.
   */
  workflowReader?: WorkflowReader;
}

const DEFAULT_SSE_POLL_MS = 100;
const DEFAULT_SSE_BATCH_SIZE = 500;

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
 * Scan a DOT source for nodes with malformed `timeout=` or `max_ms=`
 * attrs. Returns the first offender so the API can reject before a
 * workflow is saved (and therefore before any run is enqueued against
 * a broken sha). Returns `null` when every timeout attr parses, the
 * DOT is unparseable (graph-validation errors surface elsewhere), or
 * nothing is set.
 */
function findInvalidTimeoutAttr(
  dotSource: string,
): { nodeId: string; attr: "timeout" | "max_ms"; value: unknown; detail: string } | null {
  let graph: ReturnType<typeof parseDotSource>;
  try {
    graph = parseDotSource(dotSource);
  } catch {
    return null;
  }
  for (const node of Object.values(graph.nodes)) {
    const { timeout, max_ms } = node.attrs;
    if (typeof max_ms === "number") {
      try {
        parseDurationMs(max_ms);
      } catch (err) {
        return {
          nodeId: node.id,
          attr: "max_ms",
          value: max_ms,
          detail: err instanceof InvalidDurationError ? err.message : String(err),
        };
      }
    } else if (max_ms != null) {
      return { nodeId: node.id, attr: "max_ms", value: max_ms, detail: "max_ms must be a positive integer (ms)" };
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
  const batchSize = deps.sseBatchSize ?? DEFAULT_SSE_BATCH_SIZE;

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
      /** Optional sha for the upload-then-enqueue path: caller has
       *  already POSTed the DOT to /workflows and is referencing the
       *  returned sha. The web UI omits this — the server resolves the
       *  workflow off disk via `workflowReader`. */
      workflowSha?: string;
      priority?: number;
      runId?: string;
      routing?: Record<string, unknown>;
      /** Positional input — lands in `routing.input`, where the
       * executor's buildSubstitutionArgs() picks it up as $ARGUMENTS. */
      input?: string;
      /** Absolute project root the run was enqueued from. Surfaced on
       * `run_state.cwd`; the only project identifier in the
       * harness-by-default model. Required when `workflowSha` is
       * omitted (used to scope disk lookup). */
      cwd?: string;
      /** Workflow name to resolve from disk when `workflowSha` is
       *  omitted. Surfaced on `run_state.workflow_name`. */
      workflowName?: string;
      /** How the workflow argument resolved. When `workflowSha` is
       *  omitted, "global" pins lookup to `~/.swarm/workflows/`,
       *  "local" pins to `<cwd>/.swarm/workflows/`, anything else
       *  falls back to the global → projects search order. */
      workflowScope?: "global" | "local" | "path" | "ephemeral";
      /** Optional provenance: filesystem path of the .dot file the
       *  caller resolved this run from. Stored on `run_state` for
       *  display; not used for resolution. The CLI sets it when
       *  invoking from disk; the web UI omits it (the server resolves
       *  the path itself via `workflowReader`). */
      workflowPath?: string;
    }>(c);
    if (!body) {
      return c.json({ error: "request body required" }, 400);
    }

    // ── Workflow resolution ────────────────────────────────────────
    // Two paths into POST /runs:
    //   1. CLI: caller already uploaded the DOT via POST /workflows
    //      and passes the returned sha. Existence checked by
    //      enqueueRun() below — no disk I/O here.
    //   2. Web UI / simple clients: caller passes only
    //      `{ cwd, workflowName, workflowScope? }`. The server reads
    //      the latest contents off disk via `workflowReader`, hashes
    //      the bytes, and registers the workflow so enqueueRun()
    //      sees it. This avoids racing the listing's content sha
    //      against the route's hash — clients never need to compute
    //      or pin a sha.
    let workflowSha: string;
    let resolvedWorkflowName: string | undefined;
    if (typeof body.workflowSha === "string" && body.workflowSha.length > 0) {
      workflowSha = body.workflowSha;
      if (typeof body.workflowName === "string") resolvedWorkflowName = body.workflowName;
    } else {
      if (typeof body.workflowName !== "string" || body.workflowName.length === 0) {
        return c.json({ error: "workflowName required when workflowSha is omitted" }, 400);
      }
      if (typeof body.cwd !== "string" || body.cwd.length === 0) {
        return c.json({ error: "cwd required when workflowSha is omitted" }, 400);
      }
      if (deps.workflowReader == null) {
        return c.json(
          { error: "this server is not configured to resolve workflows by name", code: "workflow_reader_unavailable" },
          400,
        );
      }
      // `cwd: ""` pins the lookup to the global source per
      // `WorkflowReader.read`'s contract; "local" pins to the
      // project root the run targets. Anything else falls back to
      // the default global → projects search.
      const readOpts: { cwd?: string } | undefined =
        body.workflowScope === "global" ? { cwd: "" } : body.workflowScope === "local" ? { cwd: body.cwd } : undefined;
      const detail = await deps.workflowReader.read(body.workflowName, readOpts);
      if (!detail) {
        return c.json(
          {
            error: `workflow "${body.workflowName}" not found${
              body.workflowScope ? ` in ${body.workflowScope} scope` : ""
            }`,
            code: "workflow_not_found",
          },
          400,
        );
      }
      workflowSha = sha256Hex(detail.source);
      resolvedWorkflowName = body.workflowName;
      if (deps.store.getWorkflow(workflowSha) == null) {
        deps.store.saveWorkflow(workflowSha, body.workflowName, detail.source);
      }
    }

    if (deps.preflightProviders != null) {
      const check = deps.preflightProviders();
      if (!check.ok) {
        return c.json({ error: check.detail, code: "provider_unavailable" }, 400);
      }
    }
    if (deps.maxQueuedRuns != null) {
      const queued = deps.store.runStateCounts().queued;
      if (queued >= deps.maxQueuedRuns) {
        c.header("Retry-After", "30");
        return c.json(
          {
            error: `queue full: ${queued} runs queued, cap is ${deps.maxQueuedRuns}`,
            code: "queue_full",
          },
          429,
        );
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
        workflowSha,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(Object.keys(initialRouting).length > 0 ? { initialRouting } : {}),
        ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
        ...(resolvedWorkflowName !== undefined ? { workflowName: resolvedWorkflowName } : {}),
        ...(body.workflowScope === "global" ||
        body.workflowScope === "local" ||
        body.workflowScope === "path" ||
        body.workflowScope === "ephemeral"
          ? { workflowScope: body.workflowScope }
          : {}),
        ...(typeof body.workflowPath === "string" ? { workflowPath: body.workflowPath } : {}),
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ runId });
  });

  /**
   * Append an intent and translate the store-level `PayloadTooLargeError`
   * into a typed 413. Operator-supplied text fields (`steer.text`,
   * `cancel.reason`, `hitl.input`, `unquarantine.note`) can plausibly
   * exceed the 4 KB event-payload cap (§I7); without this wrapper the
   * caller gets a 500 with a stack trace and no actionable signal. With
   * it, they get `code: "payload_too_large"` plus the byte count and
   * limit so the client can trim or split.
   */
  function appendIntentOr413(c: Context, runId: string, intent: IntentEvent): Response {
    try {
      const { seq } = deps.store.appendIntent(runId, intent);
      return c.json({ seq });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.json(
          {
            error: `payload too large: ${err.sizeBytes} bytes (cap ${err.max}). Trim or split the request.`,
            code: "payload_too_large",
            sizeBytes: err.sizeBytes,
            maxBytes: err.max,
          },
          413,
        );
      }
      throw err;
    }
  }

  app.post("/runs/:id/steer", async (c) => {
    const body = await readJson<{ text?: string }>(c);
    if (!body || typeof body.text !== "string" || body.text.length === 0) {
      return c.json({ error: "text required" }, 400);
    }
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.steering_requested",
      payload: { text: body.text },
    });
  });

  app.post("/runs/:id/pause", (c) =>
    appendIntentOr413(c, c.req.param("id"), {
      type: "intent.pause_requested",
      payload: {},
    }),
  );

  app.post("/runs/:id/cancel", async (c) => {
    const body = (await readJson<{ reason?: string }>(c)) ?? {};
    const payload: { reason?: string } = {};
    if (typeof body.reason === "string") payload.reason = body.reason;
    const runId = c.req.param("id");
    // Cancel propagation (P1.5 / D10 of docs/proposals/parallel.md):
    // when the parent is mid-fanout, queue cancel intents on every
    // active sub-run BEFORE the parent's cancel intent. Children
    // unwind, emit `fact.run_cancelled`, the wake-pending sweep then
    // sees all sub-runs terminal and emits `fact.fanout_completed`;
    // the parent comes back to `queued` and dispatchOne folds the
    // pending cancel intent on the next turn. Reading the children
    // list before appending is best-effort — a sub-run that races
    // terminal in between still ends up consistent because cancel on
    // an already-terminal run is a no-op by the executor's status
    // gate.
    const children = deps.store.activeChildRuns(runId);
    for (const childId of children) {
      try {
        deps.store.appendIntent(childId, {
          type: "intent.cancel_requested",
          payload: { reason: "parent_cancelled" },
        });
      } catch {
        // Best-effort: a child that vanished (race with terminal +
        // GC) shouldn't block the parent's own cancel.
      }
    }
    return appendIntentOr413(c, runId, {
      type: "intent.cancel_requested",
      payload,
    });
  });

  app.post("/runs/:id/hitl", async (c) => {
    const body = await readJson<{ selected?: string; note?: string }>(c);
    if (!body || typeof body.selected !== "string" || body.selected.length === 0) {
      return c.json({ error: "selected required" }, 400);
    }
    const payload: { selected: string; note?: string } = { selected: body.selected };
    if (typeof body.note === "string" && body.note.length > 0) payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.hitl_input",
      payload,
    });
  });

  app.post("/runs/:id/resume", async (c) => {
    const body = (await readJson<{ note?: string }>(c)) ?? {};
    const payload: { note?: string } = {};
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.resume",
      payload,
    });
  });

  app.post("/runs/:id/unquarantine", async (c) => {
    const body = await readJson<{
      resolution?: "treat_as_done" | "retry" | "cancel";
      note?: string;
    }>(c);
    if (!body || (body.resolution !== "treat_as_done" && body.resolution !== "retry" && body.resolution !== "cancel")) {
      return c.json({ error: "resolution required" }, 400);
    }
    const payload: { resolution: "treat_as_done" | "retry" | "cancel"; note?: string } = {
      resolution: body.resolution,
    };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.unquarantine",
      payload,
    });
  });

  app.post("/runs/:id/priority", async (c) => {
    const body = await readJson<{ newPriority?: number; note?: string }>(c);
    if (!body || typeof body.newPriority !== "number") {
      return c.json({ error: "newPriority required" }, 400);
    }
    const payload: { newPriority: number; note?: string } = { newPriority: body.newPriority };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.priority_adjusted",
      payload,
    });
  });

  // Operator raises a budget ceiling on a `paused{reason:"budget"}` run.
  // Folded into `routing.budget_override.<scope>.<metric>` so the next
  // turn-boundary check uses the new ceiling. Web bundles a follow-up
  // `intent.resume` (the "Raise & Resume" click); intents stay separate
  // at the protocol level so resume is naked across all pause reasons.
  app.post("/runs/:id/budget", async (c) => {
    const body = await readJson<{
      scope?: "node" | "run";
      metric?: "cost" | "tokens";
      newLimit?: number;
      note?: string;
    }>(c);
    if (
      !body ||
      (body.scope !== "node" && body.scope !== "run") ||
      (body.metric !== "cost" && body.metric !== "tokens") ||
      typeof body.newLimit !== "number" ||
      !Number.isFinite(body.newLimit) ||
      body.newLimit <= 0
    ) {
      return c.json({ error: "scope ∈ {node,run}, metric ∈ {cost,tokens}, newLimit > 0 required" }, 400);
    }
    const payload: {
      scope: "node" | "run";
      metric: "cost" | "tokens";
      newLimit: number;
      note?: string;
    } = { scope: body.scope, metric: body.metric, newLimit: body.newLimit };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.budget_adjusted",
      payload,
    });
  });

  // Cap-adjustment intents for sibling-halt-converted pauses
  // (recoverable-budget-pause.md Stage 3). All three follow the same
  // shape: validate body → fold into a routing override key → the
  // next turn-boundary check sees the higher cap. Web bundles a
  // follow-up `intent.resume` (the "Raise & Resume" click).

  app.post("/runs/:id/max_retries", async (c) => {
    const body = await readJson<{ nodeId?: string; newLimit?: number; note?: string }>(c);
    if (
      !body ||
      typeof body.nodeId !== "string" ||
      body.nodeId.length === 0 ||
      typeof body.newLimit !== "number" ||
      !Number.isFinite(body.newLimit) ||
      body.newLimit <= 0
    ) {
      return c.json({ error: "nodeId (non-empty) and newLimit > 0 required" }, 400);
    }
    const payload: { nodeId: string; newLimit: number; note?: string } = {
      nodeId: body.nodeId,
      newLimit: body.newLimit,
    };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.max_retries_adjusted",
      payload,
    });
  });

  app.post("/runs/:id/goal_gate", async (c) => {
    const body = await readJson<{ newLimit?: number; note?: string }>(c);
    if (!body || typeof body.newLimit !== "number" || !Number.isFinite(body.newLimit) || body.newLimit <= 0) {
      return c.json({ error: "newLimit > 0 required" }, 400);
    }
    const payload: { newLimit: number; note?: string } = { newLimit: body.newLimit };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.goal_gate_adjusted",
      payload,
    });
  });

  app.post("/runs/:id/max_loops", async (c) => {
    const body = await readJson<{ newLimit?: number; note?: string }>(c);
    if (!body || typeof body.newLimit !== "number" || !Number.isFinite(body.newLimit) || body.newLimit <= 0) {
      return c.json({ error: "newLimit > 0 required" }, 400);
    }
    const payload: { newLimit: number; note?: string } = { newLimit: body.newLimit };
    if (typeof body.note === "string") payload.note = body.note;
    return appendIntentOr413(c, c.req.param("id"), {
      type: "intent.max_loops_adjusted",
      payload,
    });
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

  // ─── SSE stream ─────────────────────────────────────────────

  app.get("/runs/:id/stream", (c) =>
    streamSSE(c, async (stream) => {
      const runId = c.req.param("id");
      const initialSeq = parseSeqCursorMax(c.req.query("sinceSeq"), c.req.header("Last-Event-ID"));
      // Emit without an `event:` field so a single `addEventListener
      // ("message", …)` on the client receives every frame. The event
      // type lives inside the JSON payload (`type` field), which the
      // client already reads. Registering 45 typed listeners per mount
      // was 45× the closure retention for zero functional gain.
      await runSseLoop<number>(stream, initialSeq, {
        fetchBatch: (sinceSeq, limit) => deps.store.getEvents(runId, { sinceSeq, limit }),
        cursorOf: (event) => event.seq,
        idOf: (event) => String(event.seq),
        shouldClose: () => {
          const state = deps.store.getState(runId);
          return state != null && isTerminalStatus(state.status);
        },
        batchSize,
        pollMs,
      });
    }),
  );

  // ─── Global event feed (cross-run, allow-listed kinds) ──────

  app.get("/events", (c) => {
    const limit = clampLimit(c.req.query("limit"), 30, 200);
    // Backfill: most-recent N allow-listed events, oldest-first (the SQL
    // does the DESC+LIMIT in a subquery and re-sorts ASC, so the order
    // the route returns matches the order the client appends — no
    // client-side reverse). The SSE stream picks up the live tail from
    // the newest returned cursor.
    const events = deps.store.getGlobalEventsLatest({ kindIn: FEED_EVENT_KINDS, limit });
    return c.json(events);
  });

  app.get("/events/stream", (c) =>
    streamSSE(c, async (stream) => {
      const initialCursor = parseGlobalCursorFromHeader({
        fromTs: c.req.query("fromTs"),
        lastEventId: c.req.header("Last-Event-ID"),
      });
      try {
        await runGlobalFeedLoop(stream, initialCursor, {
          fetchForward: (opts) => deps.store.getGlobalEventsForward(opts),
          fetchAtFloor: (opts) => deps.store.getGlobalEventsAtFloor(opts),
          kindIn: FEED_EVENT_KINDS,
          batchSize,
          pollMs,
        });
      } catch (err) {
        // The store can be torn down (test cleanup, daemon restart)
        // while the loop is mid-iteration. Treat a closed-DB error as
        // an implicit stream abort instead of letting the exception
        // bubble out of the streamSSE async generator.
        if (err instanceof Error && /closed database/i.test(err.message)) return;
        throw err;
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

    const totals = deps.store.getGlobalMetricsTotals({ sinceMs: cutoffMs });
    const breakdownByModel = deps.store.getGlobalModelBreakdown({ sinceMs: cutoffMs });

    return c.json({ ...totals, breakdownByModel });
  });

  // ─── Projects (cwd projection) ──────────────────────────────
  //
  // One row per distinct `run_state.cwd`, ordered by most-recent activity.
  // `name` is the basename of the path — purely a display convenience; the
  // wire identity stays `cwd` (full absolute path) so two checkouts of the
  // same repo at different paths don't collide. Runs without a cwd
  // (CI primitives, ephemeral stubs) are unreachable from this surface.
  app.get("/projects", (c) => {
    const rows = deps.store.listCwds();
    return c.json(rows.map((r) => ({ ...r, name: basename(r.cwd) })));
  });

  return app;
}

function basename(p: string): string {
  // Trailing slash strip so "/foo/bar/" → "bar". Backslash handled too
  // for runs enqueued from a Windows daemon — pure presentation; the
  // identity is still the raw path.
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}

async function readJson<T>(c: { req: { json: () => Promise<unknown> } }): Promise<T | null> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return null;
  }
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
