// The opt-in `agent` tool (orchestrator-workers): a bounded worker `Agent`
// that runs INSIDE the calling llm turn — same run, same worktree, fresh
// context, every knob clamped to the caller's effective set. Synthesised per
// caller turn by the backend (never a registry tool, never force-included).
// Worker rows persist under a synthetic node id (`__agent.<caller>#<n>/<call>`)
// so neither hydration path absorbs them; worker `llm.start` / `cost.recorded`
// / `agent.worker_end` ride the caller's emit under that node id so the Cost
// breakdown nests each worker under its caller while budget enforcement keeps
// reading the caller's bucket.

import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { EventType, LlmInput, OutputsDecl, OutputsValue } from "@fragua/core";
import {
  agentSyntheticNodeId,
  byName,
  OutputsProfileError,
  parseOutputsDecl,
  validateOutputsDeclStatic,
  validateOutputsValue,
} from "@fragua/core";
import { makeHttpClient } from "@fragua/core/handler";
import type { AnyTool, ExecutionEnvironment, FraguaToolContext, Skill, ToolRegistry } from "@fragua/workspace";
import { filterSkillsForNode, renderSkillsCatalog } from "@fragua/workspace";
import { Type } from "@sinclair/typebox";
import { costPayload } from "./event-bridge.ts";
import {
  buildEmitOutputTool,
  EMIT_OUTPUT_REMINDER,
  findAbortToolCall,
  findEmitOutputCall,
  fullAssistantText,
  lastAssistantMessage,
  needsEmitOutputReminder,
} from "./exit-tools.ts";
import { applyDefaultContextFiles, buildSystemPrompt, loadContextFiles, type RunEnvironment } from "./system-prompt.ts";
import { toAgentTool } from "./tool-adapter.ts";
import { deriveRunEnv } from "./transcript.ts";
import {
  type AgentToolConfig,
  isWorktreeRelativePath,
  resolveWorkerCaps,
  type WorkerSlots,
  WorkerSlotsAborted,
} from "./worker-policy.ts";

export {
  type AgentToolConfig,
  DEFAULT_AGENT_CONCURRENCY,
  isWorktreeRelativePath,
  resolveWorkerCaps,
  WorkerSlots,
  WorkerSlotsAborted,
} from "./worker-policy.ts";

/** What the tool needs from the backend that synthesises it. */
export interface AgentToolDeps {
  registry: ToolRegistry;
  resolveModel: (provider: string, modelId: string) => Model<string>;
  getApiKey: ((provider: string) => Promise<string | undefined> | string | undefined) | undefined;
  /** The backend's global system prompt — the worker's prompt is built from it
   * exactly as an llm step's is. */
  systemPrompt: string;
  runEnv: RunEnvironment | undefined;
  agentConfig: AgentToolConfig;
  /** The backend's thinking-level resolver (model capability × `effort`). */
  resolveThinkingLevel: (model: Model<string>, attrs: Record<string, unknown>) => ThinkingLevel;
  /** The backend's provider-SDK retry policy, so a worker retries like its caller. */
  sdkRetry: { maxRetries: number; maxRetryDelayMs: number };
}

/** Synthesise the opt-in `agent` tool for one caller turn. Not force-included:
 * built only when the node lists `agent` in `allowed-tools`. Each call runs a
 * bounded worker `Agent` (see `runWorker`) whose every knob is clamped to the
 * caller's effective set. Structurally non-idempotent: `agent` is never in the
 * fragua registry, so `sanitiseUnpairedToolCalls` synthesises an error
 * toolResult for a dangling worker call on resume rather than re-running it. */
export function buildAgentTool(deps: AgentToolDeps, cfg: AgentToolBuildConfig): AgentTool {
  const parameters = Type.Object(
    {
      task: Type.String({
        description: "The self-contained task for the worker. It has fresh context — restate everything it needs.",
      }),
      allowed_tools: Type.Optional(Type.Array(Type.String())),
      denied_tools: Type.Optional(Type.Array(Type.String())),
      model: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      effort: Type.Optional(
        Type.Unsafe<"low" | "medium" | "high">({ type: "string", enum: ["low", "medium", "high"] }),
      ),
      skills: Type.Optional(Type.Array(Type.String())),
      context_files: Type.Optional(Type.Array(Type.String(), { maxItems: 32 })),
      outputs: Type.Optional(Type.Object({}, { additionalProperties: true })),
      max_cost_usd: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          description: "Spend cap for this worker in USD. Clamped to the operator's `agent.max-cost` ceiling.",
        }),
      ),
      max_tokens: Type.Optional(
        Type.Integer({ minimum: 1, description: "Per-response output cap. Clamped to the model's own maximum." }),
      ),
      timeout_minutes: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          description: "Wall-clock cap for this worker. Clamped to the operator's `agent.timeout-minutes` ceiling.",
        }),
      ),
    },
    { additionalProperties: false },
  );
  return {
    name: "agent",
    label: "agent",
    description:
      "Delegate a self-contained sub-task to a worker agent that runs in the same worktree with a fresh context, " +
      "a tool subset of yours, and its own cost cap. Returns { text, outputs?, cost_usd, turns, tool_calls, worker_id, status }. " +
      "Partition work so concurrent workers touch disjoint files. Depth 1: a worker cannot call `agent`. " +
      "`max_cost_usd` is checked after each worker message, so one long message can overshoot it slightly.",
    parameters,
    async execute(toolCallId, callParams, signal) {
      // pi-agent-core hands every tool call the turn's abort signal; the
      // caller's own `input.signal` is the fallback so a run cancel reaches the
      // worker even if a host ever invokes `execute` without one.
      const effectiveSignal = signal ?? cfg.input.signal;
      const result = await runWorker(deps, {
        cfg,
        toolCallId: typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : `worker_${randomUUID()}`,
        args: callParams as AgentToolArgs,
        ...(effectiveSignal !== undefined ? { signal: effectiveSignal } : {}),
      });
      // The model reads `content` only (`details` is for persistence and the
      // UI), so the typed result rides the text: status + counters, the
      // worker's answer, then the validated `outputs` struct as JSON.
      return {
        content: [{ type: "text", text: renderWorkerResult(result) }],
        details: { fragua_tool: "agent", is_error: result.status !== "completed", data: result },
      };
    },
  };
}

/** Resolve everything a worker needs before its loop runs: model / provider
 * (clamped to the caller's), the parsed + grammar-validated `outputs` decl, the
 * worker's system prompt (skills ∩ caller's catalogue + context files), and the
 * clamped tool array (caller's effective set narrowed by allow/deny, minus
 * `agent` / `route`, force-keeping `abort`, plus `emit_output` iff outputs).
 * Returns `{ error }` for any pre-call misconfig so `runWorker` maps it to
 * `status: "error"`. */
async function prepareWorkerSetup(
  deps: AgentToolDeps,
  params: {
    cfg: AgentToolBuildConfig;
    args: AgentToolArgs;
    signal: AbortSignal | undefined;
    workerNodeId: string;
  },
): Promise<
  | { error: string }
  | {
      model: Model<string>;
      outputsDecl: OutputsDecl | undefined;
      systemPrompt: string;
      /** Context-file warnings, emitted by the caller AFTER the worker's
       * `llm.start` so they sit inside the worker's step envelope. */
      warnings: string[];
      workerTools: AgentTool[];
      thinkingLevel: ThinkingLevel;
      maxTokens: number | undefined;
    }
> {
  const { cfg, args, signal, workerNodeId } = params;
  const { input } = cfg;
  const iteration = input.iteration ?? { n: 0, max: 0 };

  // Model / provider — the call's, else the caller's; must resolve.
  const provider = args.provider ?? cfg.callerModel.provider;
  const modelId = args.model ?? cfg.callerModel.modelId;
  let model: Model<string> | undefined;
  try {
    model = deps.resolveModel(provider, modelId);
  } catch (err) {
    return {
      error: `agent: unknown model "${provider}/${modelId}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!model || typeof model.api !== "string" || model.api === "" || model.api === "unknown") {
    return { error: `agent: model "${provider}/${modelId}" is not registered / has no API binding` };
  }

  // Outputs declaration (raw from the model) — parse + grammar-validate before
  // any model call (E033 / E034 analogue), then compile the forced emit_output.
  let outputsDecl: OutputsDecl | undefined;
  if (args.outputs !== undefined) {
    try {
      outputsDecl = parseOutputsDecl(args.outputs);
    } catch (err) {
      const msg = err instanceof OutputsProfileError ? err.message : err instanceof Error ? err.message : String(err);
      return { error: `agent: outputs schema invalid: ${msg}` };
    }
    const declDiags = validateOutputsDeclStatic(outputsDecl, "agent");
    if (declDiags.length > 0) {
      return { error: `agent: outputs schema invalid: ${declDiags.map((d) => d.message).join("; ")}` };
    }
  }

  // Skills — the call's list ∩ the caller's effective catalogue.
  const workerSkills =
    args.skills !== undefined
      ? filterSkillsForNode(cfg.callerEffectiveSkills, { skills: args.skills })
      : cfg.callerEffectiveSkills;
  const skillsCatalog = renderSkillsCatalog(workerSkills);

  // System prompt — as for an llm step, from the worker's skills + context files.
  // `context_files` is MODEL-supplied here (an llm step's comes from the YAML),
  // so it is read through `ExecutionEnvironment.readFile`'s realpath jail: an
  // absolute path, a `..` escape, or a symlink leaving the worktree is refused
  // and surfaces as a warning, never as prompt content.
  // The jail is the backstop; the obvious escapes are refused here, next to
  // the surface that admits model-authored paths.
  const admitted: string[] = [];
  const ctxWarnings: string[] = [];
  for (const raw of args.context_files ?? []) {
    if (isWorktreeRelativePath(raw)) admitted.push(raw);
    else ctxWarnings.push(`context_files: refused "${raw}" — must be a relative path inside the worktree`);
  }
  const contextFiles = applyDefaultContextFiles(admitted);
  const loaded = await loadContextFiles(cfg.effectiveEnv, contextFiles);
  const contextBlock = loaded.text;
  ctxWarnings.push(...loaded.warnings);
  const derivedRunEnv = deriveRunEnv(cfg.effectiveEnv);
  const mergedBootstrap = derivedRunEnv.bootstrapCommand ?? deps.runEnv?.bootstrapCommand;
  const workerRunEnv: RunEnvironment = mergedBootstrap !== undefined ? { bootstrapCommand: mergedBootstrap } : {};
  const systemPrompt = buildSystemPrompt({
    global: deps.systemPrompt,
    perNode: undefined,
    contextBlock,
    skillsCatalog,
    runEnv: workerRunEnv,
  });

  // Tools — clamp to the caller's effective set, narrow by the call's
  // allow/deny, strip `agent` (depth 1) + `route`, force-keep `abort`, add
  // `emit_output` iff outputs declared, reconcile `skill` to the narrowed set.
  const wAllow = args.allowed_tools !== undefined ? new Set(args.allowed_tools) : undefined;
  const wDeny = new Set(args.denied_tools ?? []);
  let workerFraguaTools = cfg.callerFinalTools.filter((t) => {
    if (t.name === "agent" || t.name === "route") return false;
    if (wDeny.has(t.name)) return false;
    if (wAllow !== undefined && !wAllow.has(t.name)) return false;
    return true;
  });
  const abortTool = cfg.callerFinalTools.find((t) => t.name === "abort") ?? deps.registry.get("abort");
  if (abortTool && !workerFraguaTools.some((t) => t.name === "abort")) {
    workerFraguaTools = [...workerFraguaTools, abortTool];
  }
  if (workerSkills.length === 0) workerFraguaTools = workerFraguaTools.filter((t) => t.name !== "skill");

  // The worker's tool context carries the WORKER's node id, like its persisted
  // rows and its events, so anything a tool attributes by node lands on the
  // worker rather than on the caller (or on a concurrent sibling).
  const workerFraguaContext: FraguaToolContext & { skillCatalog?: readonly Skill[] } = {
    runId: input.run_id,
    nodeId: workerNodeId,
    iteration: iteration.n,
    http: makeHttpClient({ signal: signal ?? input.signal }),
    // Anything a worker's tool emits lands on the WORKER's timeline; the
    // daemon would otherwise spread the caller's node id over it.
    emit: input.emit
      ? (type, payload) => {
          void input.emit?.(type as EventType, { ...payload, nodeId: workerNodeId });
        }
      : () => {},
    ...(input.judge !== undefined ? { judge: input.judge } : {}),
    skillCatalog: workerSkills,
  };
  const workerTools: AgentTool[] = workerFraguaTools.map((t) => toAgentTool(t, cfg.effectiveEnv, workerFraguaContext));
  if (outputsDecl !== undefined) workerTools.push(buildEmitOutputTool(outputsDecl));
  workerTools.sort(byName);

  const thinkingLevel = deps.resolveThinkingLevel(model, { reasoning_effort: args.effort ?? cfg.callerEffort });
  // The model's own output ceiling bounds a per-call `max_tokens`, so one
  // response cannot overshoot the per-worker cost cap by more than the model
  // can emit in a single message.
  const maxTokens = typeof args.max_tokens === "number" ? Math.min(args.max_tokens, model.maxTokens) : undefined;
  return { model, outputsDecl, systemPrompt, warnings: ctxWarnings, workerTools, thinkingLevel, maxTokens };
}

/** Run one `agent`-tool worker: a second pi-agent-core `Agent` in the caller's
 * worktree, tools clamped to the caller's effective set (minus `agent` / `route`,
 * plus `emit_output` iff `outputs` declared). Worker `cost.recorded` rides the
 * caller's `emit` so the daemon's per-node / per-run enforcement counts it;
 * worker messages persist under a synthetic node id so neither hydration path
 * absorbs them. Enforces the per-worker cost / turn / timeout caps and returns
 * a typed result to the caller — never halts the run. */
async function runWorker(
  deps: AgentToolDeps,
  params: {
    cfg: AgentToolBuildConfig;
    toolCallId: string;
    args: AgentToolArgs;
    signal?: AbortSignal;
  },
): Promise<AgentWorkerResult> {
  const { cfg, toolCallId, args, signal } = params;
  const { input } = cfg;
  const iteration = input.iteration ?? { n: 0, max: 0 };
  // The tool-call id is embedded verbatim: `agentWorkerCaller` reads the
  // caller off the FIRST `#` after the prefix, and a step id cannot contain
  // `#` or `/`, so any character in the id is safe (pinned in core's
  // synthetic-node-id test).
  const workerNodeId = agentSyntheticNodeId(input.node.id, { n: iteration.n }, toolCallId);
  const errResult = (message: string): AgentWorkerResult => ({
    text: message,
    cost_usd: 0,
    turns: 0,
    tool_calls: 0,
    worker_id: toolCallId,
    status: "error",
  });

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await cfg.slots.acquire(signal);
  } catch (err) {
    if (err instanceof WorkerSlotsAborted)
      return { ...errResult("worker aborted before it started"), status: "aborted" };
    throw err;
  }
  try {
    return await runWorkerInSlot(deps, { cfg, toolCallId, args, signal, workerNodeId, errResult });
  } finally {
    releaseSlot();
  }
}

async function runWorkerInSlot(
  deps: AgentToolDeps,
  params: {
    cfg: AgentToolBuildConfig;
    toolCallId: string;
    args: AgentToolArgs;
    signal: AbortSignal | undefined;
    workerNodeId: string;
    errResult: (message: string) => AgentWorkerResult;
  },
): Promise<AgentWorkerResult> {
  const { cfg, toolCallId, args, signal, workerNodeId, errResult } = params;
  const { input } = cfg;
  // The slot was granted on a live signal; an abort that landed in between
  // must not open a worker step (no `llm.start`, no model call).
  if (signal?.aborted) return { ...errResult("worker aborted before it started"), status: "aborted" };
  // Setup is the one window outside the worker loop's own try/catch; a throw
  // here (a store write, a model resolve) is still a worker-level error the
  // caller reads, never a caller-turn failure.
  const setupFailed = (message: string): AgentWorkerResult =>
    emitFailedWorkerStep({ cfg, args, toolCallId, workerNodeId }, errResult(message));
  let setup: Awaited<ReturnType<typeof prepareWorkerSetup>>;
  try {
    setup = await prepareWorkerSetup(deps, { cfg, args, signal, workerNodeId });
  } catch (err) {
    return setupFailed(`agent: worker setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if ("error" in setup) return setupFailed(setup.error);
  // Setup awaited real I/O (context files); an abort that landed meanwhile
  // would never fire the listener registered below, so re-check before any
  // row is written, any model call or write-class tool can run against a
  // cancelled turn.
  if (signal?.aborted) return { ...errResult("worker aborted before it started"), status: "aborted" };
  const { model, outputsDecl, systemPrompt, warnings, workerTools, thinkingLevel, maxTokens } = setup;
  // The worker's exact prompt persists under its node id, as the caller's does
  // (`llm.start` is capped at 4 KB, so the row is the forensic record). It is
  // the first worker row and `llm.start` follows at once, so no transcript
  // write ever sits outside a step envelope.
  if (input.persistMessage && systemPrompt.length > 0) {
    try {
      input.persistMessage({ role: "system", content: systemPrompt, timestamp: Date.now() }, { nodeId: workerNodeId });
    } catch (err) {
      return setupFailed(`agent: worker setup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const { maxCostUsd, maxTurns, timeoutMinutes } = resolveWorkerCaps(args, deps.agentConfig);

  const acct: WorkerAccounting = { costUsd: 0, turns: 0, toolCallCount: 0, capStatus: undefined };

  const worker = new Agent({
    initialState: { systemPrompt, model, tools: workerTools, thinkingLevel },
    streamFn: (m, ctx, options) =>
      streamSimple(m, ctx, {
        ...options,
        maxRetries: deps.sdkRetry.maxRetries,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }),
    maxRetryDelayMs: deps.sdkRetry.maxRetryDelayMs,
    ...(deps.getApiKey !== undefined ? { getApiKey: deps.getApiKey } : {}),
  });

  const unsubscribe = worker.subscribe(
    workerSubscriber({ input, worker, workerNodeId, acct, caps: { maxCostUsd, maxTurns } }),
  );

  // Deliberately NOT registered in the steering registry: an operator steer
  // is addressed to the caller's context (it aborts the caller's turn, and
  // that abort reaches every worker through the tool-call `signal` below);
  // injecting the steer text into N worker contexts would misdirect them.
  const onAbort = () => worker.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMinutes > 0) {
    timeoutTimer = setTimeout(() => {
      if (acct.capStatus === undefined) {
        acct.capStatus = "timeout";
        worker.abort();
      }
    }, timeoutMinutes * 60_000);
  }

  // The worker's own `llm.start`, under its synthetic node id, opens a step
  // the read plane nests under the caller (`parentNodeId`) — that is what puts
  // a worker row in the Cost breakdown with its own spend.
  if (input.emit) {
    void input.emit("llm.start", {
      nodeId: workerNodeId,
      worker_of: input.node.id,
      worker_id: toolCallId,
      provider: model.provider,
      model: model.id,
      prompt: args.task.slice(0, WORKER_PROMPT_PREVIEW_CHARS),
      thinking_level: thinkingLevel,
      allowed_tools: workerTools.map((t) => t.name),
    });
    for (const m of warnings) void input.emit("agent.warning", { nodeId: workerNodeId, message: m });
  }

  try {
    await worker.prompt(args.task);
    await worker.waitForIdle();
    // One corrective re-prompt on a skipped emit_output, the llm step's guard.
    if (
      needsEmitOutputReminder({
        outputsDecl,
        messages: worker.state.messages,
        signalAborted: signal?.aborted ?? false,
        capped: acct.capStatus !== undefined,
      })
    ) {
      await worker.prompt(EMIT_OUTPUT_REMINDER);
      await worker.waitForIdle();
    }
  } catch {
    // Abort / transport error — classified from the transcript below.
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    unsubscribe();
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  const result = classifyWorkerResult({
    worker,
    outputsDecl,
    capStatus: acct.capStatus,
    signalAborted: signal?.aborted ?? false,
    costUsd: acct.costUsd,
    turns: acct.turns,
    toolCallCount: acct.toolCallCount,
    toolCallId,
  });
  // Closes the worker's step: the read plane stamps the step's duration at
  // this ts (a nested step has no sequential "next" to derive it from).
  if (input.emit) {
    void input.emit("agent.worker_end", {
      nodeId: workerNodeId,
      worker_of: input.node.id,
      worker_id: toolCallId,
      status: result.status,
      cost_usd: result.cost_usd,
      turns: result.turns,
      tool_calls: result.tool_calls,
    });
  }
  return result;
}

/** Running totals for one worker, shared by the subscriber, the timeout
 * timer and the final classification. */
interface WorkerAccounting {
  costUsd: number;
  turns: number;
  toolCallCount: number;
  capStatus: AgentWorkerStatus | undefined;
}

/** The worker's `message_end` subscriber: per-message cost emit (under the
 * worker's node id), row persistence, and the cost / turn caps. The empty
 * error/abort envelope pi-agent-core synthesises is not a turn: it carries no
 * content and no spend, so it neither counts nor persists. */
function workerSubscriber(args: {
  input: LlmInput;
  worker: Agent;
  workerNodeId: string;
  acct: WorkerAccounting;
  caps: { maxCostUsd: number | undefined; maxTurns: number };
}): (event: AgentEvent) => void {
  const { input, worker, workerNodeId, acct, caps } = args;
  return (event) => {
    if (event.type !== "message_end") return;
    const msg = event.message;
    if (isEmptyFailureEnvelope(msg)) return;
    if (msg.role === "assistant") {
      acct.turns += 1;
      const am = msg as AssistantMessage;
      // Stamped with the WORKER's node id: the daemon spreads the payload over
      // its own `{ nodeId, iteration }` so this wins, and the step aggregates
      // attribute the spend to the worker's own `llm.start` window (nested
      // under the caller in the Cost breakdown). Enforcement is unaffected:
      // `onCostRecorded` reads the payload and the caller's bucket, never
      // the event's node id.
      if (input.emit) void input.emit("cost.recorded", { ...costPayload(am), nodeId: workerNodeId });
      acct.costUsd += am.usage.cost.total;
      if (Array.isArray(am.content)) acct.toolCallCount += am.content.filter((b) => b.type === "toolCall").length;
    }
    if (input.persistMessage) input.persistMessage(msg, { nodeId: workerNodeId });
    if (acct.capStatus === undefined && caps.maxCostUsd !== undefined && acct.costUsd >= caps.maxCostUsd) {
      acct.capStatus = "max_cost";
      worker.abort();
    } else if (acct.capStatus === undefined && acct.turns >= caps.maxTurns) {
      acct.capStatus = "max_turns";
      worker.abort();
    }
  };
}

/** A setup failure still opens and closes a worker step (the requested model,
 * zero spend, `status: "error"`) so the Cost breakdown shows the worker that
 * never ran instead of nothing. */
function emitFailedWorkerStep(
  ctx: { cfg: AgentToolBuildConfig; args: AgentToolArgs; toolCallId: string; workerNodeId: string },
  result: AgentWorkerResult,
): AgentWorkerResult {
  const { cfg, args, toolCallId, workerNodeId } = ctx;
  const { input } = cfg;
  if (!input.emit) return result;
  void input.emit("llm.start", {
    nodeId: workerNodeId,
    worker_of: input.node.id,
    worker_id: toolCallId,
    provider: args.provider ?? cfg.callerModel.provider,
    model: args.model ?? cfg.callerModel.modelId,
    prompt: args.task.slice(0, WORKER_PROMPT_PREVIEW_CHARS),
    allowed_tools: [],
  });
  void input.emit("agent.worker_end", {
    nodeId: workerNodeId,
    worker_of: input.node.id,
    worker_id: toolCallId,
    status: result.status,
    cost_usd: 0,
    turns: 0,
    tool_calls: 0,
  });
  return result;
}

// ─────────────────── agent tool (orchestrator-workers) ───────────────────

/** Terminal status of one `agent`-tool worker, returned to the caller. */
export type AgentWorkerStatus = "completed" | "aborted" | "max_cost" | "max_turns" | "timeout" | "error";

/** The typed result one `agent` tool call hands back to the caller. */
export interface AgentWorkerResult {
  text: string;
  outputs?: OutputsValue;
  cost_usd: number;
  turns: number;
  tool_calls: number;
  worker_id: string;
  status: AgentWorkerStatus;
}

/** Arguments the model passes to one `agent({...})` call. Every knob is
 * clamped to the caller's effective set inside `runWorker`. */
interface AgentToolArgs {
  task: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  model?: string;
  provider?: string;
  effort?: "low" | "medium" | "high";
  skills?: string[];
  context_files?: string[];
  outputs?: unknown;
  max_cost_usd?: number;
  max_tokens?: number;
  timeout_minutes?: number;
}

/** Everything the synthesised `agent` tool closes over from the caller's turn,
 * so each worker clamps to the caller's effective tools / env / skills / model. */
interface AgentToolBuildConfig {
  input: LlmInput;
  /** Per-turn counting semaphore: `agent.concurrency` concurrent workers per
   * caller turn; further calls wait for a slot (or return `aborted` if the
   * caller's signal fires while they wait). */
  slots: WorkerSlots;
  /** The caller's effective tool objects, shared by reference with every
   * concurrent worker. Safe: a fragua tool is a stateless `execute` over the
   * environment it is handed, and an MCP tool multiplexes calls by JSON-RPC
   * request id — pi-agent-core already runs one message's tool calls
   * concurrently over these same objects. */
  callerFinalTools: AnyTool[];
  effectiveEnv: ExecutionEnvironment;
  callerEffectiveSkills: readonly Skill[];
  callerModel: { provider: string; modelId: string };
  callerEffort: "low" | "medium" | "high" | undefined;
}

/** The `llm.start` payload is a 4 KB observability event; the task preview
 * leaves room for the sibling fields. The full task is the worker's first user
 * row, persisted under its node id. */
const WORKER_PROMPT_PREVIEW_CHARS = 3_000;

/** The text the CALLER model reads for one worker: a status line with the
 * counters, the worker's final answer, and the validated `outputs` as JSON. */
export function renderWorkerResult(result: AgentWorkerResult): string {
  const head = `[worker ${result.status}] $${result.cost_usd.toFixed(4)} · ${result.turns} turns · ${result.tool_calls} tool calls`;
  const parts = [head];
  if (result.text.length > 0) parts.push(result.text);
  if (result.outputs !== undefined) parts.push(`outputs:\n${JSON.stringify(result.outputs, null, 2)}`);
  return parts.join("\n\n");
}

/** pi-agent-core synthesises an empty-content `assistant` message with
 * `stopReason: "error" | "aborted"` for a transport failure / in-flight abort.
 * These carry no recoverable content and bloat the transcript on retry chains —
 * skip persisting them (mirrors the caller subscriber). */
function isEmptyFailureEnvelope(msg: AgentMessage): boolean {
  const m = msg as { role?: string; stopReason?: string; content?: unknown };
  return (
    m.role === "assistant" &&
    (m.stopReason === "error" || m.stopReason === "aborted") &&
    Array.isArray(m.content) &&
    m.content.length === 0
  );
}

/** Resolve a finished worker into its typed result. Cap statuses win; then a
 * signal abort / self-abort; then outputs validation (missing or invalid struct
 * ⇒ `status: "error"`); else a clean completion. */
function classifyWorkerResult(args: {
  worker: Agent;
  outputsDecl: OutputsDecl | undefined;
  capStatus: AgentWorkerStatus | undefined;
  signalAborted: boolean;
  costUsd: number;
  turns: number;
  toolCallCount: number;
  toolCallId: string;
}): AgentWorkerResult {
  const { worker, outputsDecl, capStatus, signalAborted, costUsd, turns, toolCallCount, toolCallId } = args;
  const messages = worker.state.messages;
  const lastAssistant = lastAssistantMessage(messages);
  const baseText = lastAssistant ? fullAssistantText(lastAssistant).slice(0, 8_000) : "";
  const base = { cost_usd: costUsd, turns, tool_calls: toolCallCount, worker_id: toolCallId };

  // A cap that trips on the very message carrying a valid `emit_output` is a
  // finished worker, not a stopped one: hand the struct back as completed.
  if (capStatus !== undefined && outputsDecl !== undefined) {
    const emitCall = findEmitOutputCall(messages);
    if (emitCall?.isolated === true && validateOutputsValue(outputsDecl, emitCall.value) === null) {
      return { text: baseText, outputs: emitCall.value as OutputsValue, status: "completed", ...base };
    }
  }
  if (capStatus !== undefined) {
    const label =
      capStatus === "max_cost"
        ? `worker stopped: per-worker cost cap reached ($${costUsd.toFixed(4)})`
        : capStatus === "max_turns"
          ? `worker stopped: max-turns reached (${turns})`
          : "worker stopped: timeout reached";
    return { text: baseText.length > 0 ? `${label}\n\n${baseText}` : label, status: capStatus, ...base };
  }

  const aborted = findAbortToolCall(messages);
  if (signalAborted || aborted) {
    return { text: aborted?.reason ?? (baseText.length > 0 ? baseText : "worker aborted"), status: "aborted", ...base };
  }

  if (outputsDecl !== undefined) {
    const emitCall = findEmitOutputCall(messages);
    if (emitCall == null) {
      return { text: "worker declared outputs but did not call emit_output", status: "error", ...base };
    }
    // The llm step's exit-isolation rule applies to a worker too: the emit
    // must be the turn's only tool call, or the struct may describe work a
    // sibling call in the same turn was still doing.
    if (!emitCall.isolated) {
      return {
        text: "worker called emit_output in a turn that also made other tool calls — emit it alone, after the work",
        status: "error",
        ...base,
      };
    }
    const valErr = validateOutputsValue(outputsDecl, emitCall.value);
    if (valErr !== null) {
      return { text: `worker emit_output failed validation: ${valErr}`, status: "error", ...base };
    }
    return { text: baseText, outputs: emitCall.value as OutputsValue, status: "completed", ...base };
  }

  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    const em = (last as AssistantMessage).errorMessage;
    return { text: em ?? (baseText.length > 0 ? baseText : "worker error"), status: "error", ...base };
  }
  return { text: baseText, status: "completed", ...base };
}
