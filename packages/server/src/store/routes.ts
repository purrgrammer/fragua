// DB-backed HTTP routes — ARCHITECTURE.md §7.
//
// All writes are intents (writer: "web"). Daemon-facing facts are never
// written here. Reads hit the store projection directly and work even when
// the daemon is offline.

import {
  CURRENT_IR_VERSION,
  InvalidDurationError,
  parseDurationMs,
  parseWorkflow,
  serializeGraph,
  validateInputBindings,
} from "@fragua/core";
import { type BuildResult, makeIntentPlane } from "@fragua/core/intent-plane";
import {
  FEED_EVENT_KINDS,
  type IEventStore,
  type IntentEvent,
  isTerminal as isTerminalStatus,
  newRunId,
  PayloadTooLargeError,
  type RunState,
  sha256Hex,
} from "@fragua/store";
import { applyAccept, applyDiscard, defaultGitExec } from "@fragua/workspace";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunActionExec, RunSnapshotReader, WorkflowReader } from "../ports.ts";
import { parseGlobalCursorFromHeader, parseSeqCursorMax, runGlobalFeedLoop, runSseLoop } from "./sse.ts";

/** Per-node model-resolution check injected by the daemon. Returns a
 * non-empty array of node-level offenders when one or more declared
 * `(provider, model)` pairs don't resolve in the provider registry. */
export type WorkflowModelValidator = (
  source: string,
) =>
  | { ok: true }
  | { ok: false; offenders: Array<{ nodeId: string; provider?: string; model: string; reason: string }> };

export interface ServerDeps {
  store: IEventStore;
  /** Snapshot/ref git reader — used by `POST /runs/:id/merge` to refuse a
   *  non-ff or conflicting merge synchronously. Omit to skip git-level
   *  merge validation (the daemon sweep is the defense-in-depth backstop). */
  runSnapshotReader?: RunSnapshotReader;
  /** Runs post-terminal accept/discard synchronously in the request path so
   *  the operator sees the result. Defaults to the @fragua/workspace git
   *  implementation; injected by tests to stub the outcome. */
  runActions?: RunActionExec;
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
   * Validate every llm node's `(provider, model)` declaration at
   * workflow registration. Rejects typos that would otherwise only
   * surface mid-run (after an expensive `plan` phase already spent
   * tokens). Injected rather than imported so @fragua/server stays
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

/**
 * Scan a workflow source for nodes with malformed `timeout=` or `max_ms=`
 * attrs. Returns the first offender so the API can reject before a
 * workflow is saved (and therefore before any run is enqueued against
 * a broken sha). Returns `null` when every timeout attr parses or
 * nothing is set.
 */
function findInvalidTimeoutAttr(
  graph: ReturnType<typeof parseWorkflow>,
): { nodeId: string; attr: "timeout" | "max_ms"; value: unknown; detail: string } | null {
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
      return {
        nodeId: node.id,
        attr: "max_ms",
        value: max_ms,
        detail: "max_ms must be a non-negative integer (ms); 0 disables the wall-clock watchdog",
      };
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

function invalidWorkflowResponse(c: Context, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return c.json(
    {
      error: `invalid workflow: ${detail}`,
      code: "invalid_workflow",
      detail,
    },
    400,
  );
}

/** Registry-backed preflight. Rejects only when no provider in the
 * registry has any configured credential — reads the global store's
 * `provider_credentials` table. Returned as a closure so the caller
 * can share one AuthStorage across calls. */
export function registryPreflight(args: {
  hasAnyAuth: () => boolean;
}): () => { ok: true } | { ok: false; detail: string } {
  return () => {
    if (args.hasAnyAuth()) return { ok: true };
    return {
      ok: false,
      detail:
        "no provider credentials configured. run `fragua providers add <provider>` or `fragua providers login <provider>`.",
    };
  };
}

export function createRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const pollMs = deps.ssePollMs ?? DEFAULT_SSE_POLL_MS;
  const batchSize = deps.sseBatchSize ?? DEFAULT_SSE_BATCH_SIZE;
  const runActions: RunActionExec = deps.runActions ?? {
    accept: (cwd, runId, baseGitSha) => applyAccept(defaultGitExec, { cwd, runId, baseGitSha }),
    discard: (cwd, runId) => applyDiscard(defaultGitExec, cwd, runId),
  };
  // The intent plane: the one validate/construct/commit surface. Control
  // routes deserialize the body, hand it to `plane.build*`, and commit via
  // `commitBuilt` — no route validates an intent body or calls
  // `store.appendIntent` itself (enforced by `discipline.test.ts`).
  const plane = makeIntentPlane({ store: deps.store, newRunId });
  const commitBuilt = (c: Context, runId: string, built: BuildResult): Response =>
    built.ok ? appendIntentOr413(c, runId, built.intent) : c.json({ error: built.error }, 400);

  // ─── Workflow upload ────────────────────────────────────────

  app.post("/workflows", async (c) => {
    const body = await readJson<{ name?: string; source?: string }>(c);
    if (
      !body ||
      typeof body.name !== "string" ||
      body.name.length === 0 ||
      typeof body.source !== "string" ||
      body.source.length === 0
    ) {
      return c.json({ error: "name and source required" }, 400);
    }
    const mint = plane.buildSaveWorkflow(body.source);
    if (!mint.ok) return invalidWorkflowResponse(c, new Error(mint.detail));
    if (deps.validateWorkflowModels != null) {
      const check = deps.validateWorkflowModels(body.source);
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
    const timeoutOffender = findInvalidTimeoutAttr(mint.graph);
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
    plane.commitSaveWorkflow({
      sha: mint.sha,
      name: body.name,
      source: body.source,
      ir: mint.ir,
      irVersion: mint.irVersion,
    });
    return c.json({ sha: mint.sha, name: body.name });
  });

  // ─── Writes (intents) ───────────────────────────────────────

  app.post("/runs", async (c) => {
    const body = await readJson<{
      /** Optional sha for the upload-then-enqueue path: caller has
       *  already POSTed the workflow source to /workflows and is referencing the
       *  returned sha. The web UI omits this — the server resolves the
       *  workflow off disk via `workflowReader`. */
      workflowSha?: string;
      priority?: number;
      runId?: string;
      routing?: Record<string, unknown>;
      /** Free-form run description — lands in `routing.input` and seeds
       * the auto-title / UI fallback. Not substituted into prompts; use
       * `inputs` for `${{ inputs.name }}` substitution. */
      input?: string;
      /** Typed run inputs (`--input name=value`) — validated against the
       * workflow's `inputs:` block, then stored on `routing.inputs` for
       * `${{ inputs.name }}` substitution at dispatch. */
      inputs?: Record<string, string>;
      /** Absolute project root the run was enqueued from. Surfaced on
       * `run_state.cwd`; the only project identifier in the
       * harness-by-default model. Required when `workflowSha` is
       * omitted (used to scope disk lookup). */
      cwd?: string;
      /** Project IDENTITY — the committed `id` resolved at the client
       *  boundary (CLI/web). Trusted as-supplied; when absent the store
       *  falls back to `cwd`. */
      projectId?: string;
      /** Project display label captured at enqueue (defaults to the cwd
       *  basename in the store when absent). */
      projectName?: string;
      /** Workflow name to resolve from disk when `workflowSha` is
       *  omitted. Surfaced on `run_state.workflow_name`. */
      workflowName?: string;
      /** How the workflow argument resolved. When `workflowSha` is
       *  omitted, "global" pins lookup to `~/.fragua/workflows/`,
       *  "local" pins to `<cwd>/.fragua/workflows/`, anything else
       *  falls back to the global → projects search order. */
      workflowScope?: "global" | "local" | "path" | "ephemeral";
      /** Optional provenance: filesystem path of the .yaml file the
       *  caller resolved this run from. Stored on `run_state` for
       *  display; not used for resolution. The CLI sets it when
       *  invoking from disk; the web UI omits it (the server resolves
       *  the path itself via `workflowReader`). */
      workflowPath?: string;
      /** Explicit run title. When present, stored immediately after enqueue
       * and prevents the auto-titler from overwriting it. */
      title?: string;
    }>(c);
    if (!body) {
      return c.json({ error: "request body required" }, 400);
    }

    // ── Workflow resolution ────────────────────────────────────────
    // Two paths into POST /runs:
    //   1. CLI: caller already uploaded the workflow source via POST /workflows
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
    let resolvedSource: string | undefined;
    let resolvedGraph: ReturnType<typeof parseWorkflow> | undefined;
    if (typeof body.workflowSha === "string" && body.workflowSha.length > 0) {
      workflowSha = body.workflowSha;
      if (typeof body.workflowName === "string") resolvedWorkflowName = body.workflowName;
      resolvedSource = deps.store.getWorkflow(workflowSha)?.source;
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
      resolvedSource = detail.source;
    }

    if (resolvedSource !== undefined) {
      try {
        resolvedGraph = parseWorkflow(resolvedSource);
      } catch (err) {
        return invalidWorkflowResponse(c, err);
      }
      const timeoutOffender = findInvalidTimeoutAttr(resolvedGraph);
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
      if (deps.store.getWorkflow(workflowSha) == null) {
        deps.store.saveWorkflow(
          workflowSha,
          resolvedWorkflowName ?? body.workflowName ?? workflowSha,
          resolvedSource,
          serializeGraph(resolvedGraph),
          CURRENT_IR_VERSION,
        );
      }
    }

    // Validate `--input name=value` bindings against the workflow's
    // `inputs:` block before enqueue, so a missing required input or a
    // bad choice value fails fast with operator-actionable feedback
    // instead of collapsing to "" silently at dispatch.
    if (resolvedGraph !== undefined) {
      const inputDecls = resolvedGraph.attrs.inputs;
      const inputErrors = validateInputBindings(inputDecls, body.inputs ?? {});
      if (inputErrors.length > 0) {
        return c.json(
          {
            error: inputErrors.map((e) => e.message).join("; "),
            code: "invalid_inputs",
            inputErrors,
          },
          400,
        );
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
    if (body.inputs != null && initialRouting["inputs"] === undefined) {
      initialRouting["inputs"] = body.inputs;
    }
    try {
      deps.store.enqueueRun({
        runId,
        workflowSha,
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(Object.keys(initialRouting).length > 0 ? { initialRouting } : {}),
        ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
        ...(typeof body.projectId === "string" && body.projectId.length > 0 ? { projectId: body.projectId } : {}),
        ...(typeof body.projectName === "string" && body.projectName.length > 0
          ? { projectName: body.projectName }
          : {}),
        ...(resolvedWorkflowName !== undefined ? { workflowName: resolvedWorkflowName } : {}),
        ...(body.workflowScope === "global" ||
        body.workflowScope === "local" ||
        body.workflowScope === "path" ||
        body.workflowScope === "ephemeral"
          ? { workflowScope: body.workflowScope }
          : {}),
        ...(typeof body.workflowPath === "string" ? { workflowPath: body.workflowPath } : {}),
      });
      if (typeof body.title === "string" && body.title.length > 0) {
        deps.store.setRunTitle(runId, body.title);
      }
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
      const { seq } = plane.commit(runId, intent);
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

  app.post("/runs/:id/steer", async (c) => commitBuilt(c, c.req.param("id"), plane.buildSteer(await readJson(c))));

  app.post("/runs/:id/pause", (c) => commitBuilt(c, c.req.param("id"), plane.buildPause({})));

  app.post("/runs/:id/cancel", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildCancel((await readJson(c)) ?? {})),
  );

  app.post("/runs/:id/human", async (c) => {
    const runId = c.req.param("id");
    const built = plane.buildHuman(await readJson(c));
    if (!built.ok) return c.json({ error: built.error }, 400);
    const route = built.intent.payload.route;
    // Stateful route-enum check: read the paused-node descriptor from the
    // latest fact.run_paused_human and reject off-list routes with 400. This
    // is I/O (reads run state), so it stays adapter-side (intent-plane §3.6) —
    // the plane only validated the body shape. The handler re-validates the
    // same enum (defense-in-depth — a hand-crafted intent could bypass this);
    // the operator-facing path fails loudly here so the UI surfaces it instead
    // of letting the daemon halt the run on resume.
    const state = deps.store.getState(runId);
    if (state == null) return c.json({ error: "run not found" }, 404);
    if (state.status !== "paused_human") {
      return c.json({ error: `run not paused at a human node (status=${state.status})` }, 409);
    }
    const events = deps.store.getEvents(runId);
    let declaredRoutes: string[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "fact.run_paused_human") {
        const p = ev.payload as { routes?: unknown };
        if (Array.isArray(p.routes)) {
          declaredRoutes = p.routes.filter((r): r is string => typeof r === "string");
        }
        break;
      }
    }
    if (declaredRoutes.length > 0 && !declaredRoutes.includes(route)) {
      return c.json({ error: `unknown route "${route}" (expected one of: ${declaredRoutes.join(", ")})` }, 400);
    }
    return appendIntentOr413(c, runId, built.intent);
  });

  app.post("/runs/:id/resume", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildResume((await readJson(c)) ?? {})),
  );

  app.post("/runs/:id/unquarantine", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildUnquarantine(await readJson(c))),
  );

  app.post("/runs/:id/priority", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildPriority(await readJson(c))),
  );

  // Operator raises a budget ceiling on a `paused{reason:"budget"}` run.
  // Folded into `routing.budget_override.<scope>.<metric>` so the next
  // turn-boundary check uses the new ceiling. Web bundles a follow-up
  // `intent.resume` (the "Raise & Resume" click); intents stay separate
  // at the protocol level so resume is naked across all pause reasons.
  app.post("/runs/:id/budget", async (c) => commitBuilt(c, c.req.param("id"), plane.buildBudget(await readJson(c))));

  // Cap-adjustment intents for sibling-halt-converted pauses
  // (recoverable-budget-pause.md Stage 3). All three follow the same
  // shape: validate body → fold into a routing override key → the
  // next turn-boundary check sees the higher cap. Web bundles a
  // follow-up `intent.resume` (the "Raise & Resume" click).

  app.post("/runs/:id/max_retries", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildMaxRetries(await readJson(c))),
  );

  app.post("/runs/:id/goal_gate", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildGoalGate(await readJson(c))),
  );

  app.post("/runs/:id/max_loops", async (c) =>
    commitBuilt(c, c.req.param("id"), plane.buildMaxLoops(await readJson(c))),
  );

  // ─── Operator post-run primitives ───────────────────────────────────────────────
  //
  // Each appends a post-terminal operator-action intent; the daemon's
  // `processOperatorActions` sweep folds it into the git mutation + fact.
  // User-facing refusals are validated here so the operator gets a 4xx
  // synchronously rather than a silent daemon no-op. branch/commit gate on
  // run_state columns; merge additionally consults the snapshot reader for
  // ff-ability / conflict. A branch-name collision without `--force` and a
  // rare target-moved race fall through to the sweep's defense-in-depth.

  type ActionGate = { ok: true; state: RunState } | { ok: false; res: Response };

  function operatorActionGate(c: Context, runId: string): ActionGate {
    const state = deps.store.getState(runId);
    if (state == null) return { ok: false, res: c.json({ error: "run not found", code: "not_found" }, 404) };
    if (!isTerminalStatus(state.status)) {
      return {
        ok: false,
        res: c.json({ error: `run not terminal (status=${state.status})`, code: "not_terminal" }, 409),
      };
    }
    if (state.inboxStatus == null) {
      return { ok: false, res: c.json({ error: "run has no recoverable work", code: "not_in_inbox" }, 409) };
    }
    if (state.inboxStatus === "discarded") {
      return { ok: false, res: c.json({ error: "run discarded", code: "discarded" }, 409) };
    }
    if (state.cwd == null) {
      return { ok: false, res: c.json({ error: "run has no worktree (bare-cwd)", code: "no_worktree" }, 409) };
    }
    return { ok: true, state };
  }

  app.post("/runs/:id/accept", async (c) => {
    const runId = c.req.param("id");
    const gate = operatorActionGate(c, runId);
    if (!gate.ok) return gate.res;
    const cwd = gate.state.cwd;
    if (cwd == null) return c.json({ error: "run has no worktree (bare-cwd)", code: "no_worktree" }, 409);
    // Run the accept SYNCHRONOUSLY so the operator sees the result now: replay
    // the run's commits onto HEAD + stage the tail. On success append
    // intent.accept_run carrying the result — the daemon folds it into
    // fact.run_accepted (the projection). A conflict / dirty tree returns 409
    // and writes nothing (resolve via revive). The git side effect runs once.
    const res = await runActions.accept(cwd, runId, gate.state.baseGitSha ?? "");
    if (!res.ok) return c.json({ error: res.detail, code: res.reason }, 409);
    try {
      const { seq } = deps.store.appendIntent(runId, {
        type: "intent.accept_run",
        payload: { sha: res.sha, replayed: res.replayed, tailStaged: res.tailStaged },
      });
      return c.json({ seq, sha: res.sha, replayed: res.replayed, tailStaged: res.tailStaged });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return c.json({ error: "payload too large", code: "payload_too_large" }, 413);
      }
      throw err;
    }
  });

  app.post("/runs/:id/discard", async (c) => {
    const runId = c.req.param("id");
    const gate = operatorActionGate(c, runId);
    if (!gate.ok) return gate.res;
    const cwd = gate.state.cwd;
    if (cwd == null) return c.json({ error: "run has no worktree (bare-cwd)", code: "no_worktree" }, 409);
    const res = await runActions.discard(cwd, runId);
    const { seq } = deps.store.appendIntent(runId, { type: "intent.discard_run", payload: { refs: res.refs } });
    return c.json({ seq, refs: res.refs });
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

  // ─── Projects (identity projection) ─────────────────────────
  //
  // One row per distinct `run_state.project_id` (IDENTITY), ordered by
  // most-recent activity, with the display `name` and a representative
  // `cwd` hint (the most-recent local checkout, or null for an
  // imported-only project). Folds multiple checkouts / imports of the same
  // repo into one project. `cwd` is retained as the LOCATION hint for the
  // file/tree views; it is no longer the wire identity.
  app.get("/projects", (c) => {
    const rows = deps.store.listProjects();
    return c.json(
      rows.map((r) => ({
        projectId: r.projectId,
        name: r.projectName,
        cwd: r.cwdHint,
        cwdHint: r.cwdHint,
        runCount: r.runCount,
        lastUpdatedAt: r.lastUpdatedAt,
      })),
    );
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

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
