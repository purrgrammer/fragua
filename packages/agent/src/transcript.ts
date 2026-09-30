// Transcript + prompt plumbing for the LLM backend: system-prompt build, prior
// shared-thread hydration, summariser seed, the agent-event subscriber that
// persists messages, the `llm.start` snapshot, and the prompt/abort-race loop.
// Split out of backend.ts. Each function takes the deps it needs explicitly.

import { createHash } from "node:crypto";
import type { Agent, AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EventType, LlmInput, OutputsDecl, SummariserBackend } from "@fragua/core";
import type { ExecutionEnvironment, FraguaToolContext, Skill, ToolRegistry } from "@fragua/workspace";
import { sanitiseUnpairedToolCalls, toCatalogRecord } from "@fragua/workspace";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { EMIT_OUTPUT_REMINDER, findAbortToolCall, findEmitOutputCall, lastAssistantMessage } from "./exit-tools.ts";
import type { MessageStore } from "./message-store.ts";
import type { SteeringRegistry } from "./steering-registry.ts";
import { applyDefaultContextFiles, buildSystemPrompt, loadContextFiles, type RunEnvironment } from "./system-prompt.ts";
import { buildSummarySeed, shouldHydrateFromStore, shouldPersistToStore } from "./thread.ts";

export interface SystemPromptDeps {
  systemPrompt: string;
  runEnv: RunEnvironment | undefined;
}

export interface HydrateDeps {
  messageStore: MessageStore;
  inProcessWrites: Set<string>;
  registry: ToolRegistry;
}

export interface EffectivePromptDeps {
  summariser: SummariserBackend | undefined;
}

export interface PromptLoopDeps {
  steering: SteeringRegistry;
}

/** Cooperative-unwind window between `input.signal` aborting and the
 *  wrapper synthesising an AbortError. Long enough for a well-behaved
 *  provider SDK to tear its socket down (existing cancel-signal test
 *  unwinds in ~50ms); short enough to stay well inside the executor's
 *  10s `LEAK_GRACE_MS`, so a wedged fetch lands as `fact.node_aborted`
 *  instead of `fact.handler_timeout_leaked`. */
const ABORT_TEARDOWN_GRACE_MS = 2_000;

export function sessionKey(runId: string, threadId: string): string {
  return `${runId}::${threadId}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Derive a `RunEnvironment` from the execution env. Always returns a
 *  value, so every llm call gets a uniform `<environment>` block
 *  regardless of env implementation. A `WorktreeEnvironment`'s own
 *  `bootstrapCommand` is picked up when present so the block surfaces
 *  the bootstrap-ran signal; a bare `LocalEnvironment` yields an empty
 *  object and the rules-only block. Exported for unit tests. */
export function deriveRunEnv(env: ExecutionEnvironment): RunEnvironment {
  const wt = env as unknown as { bootstrapCommand?: unknown };
  const out: RunEnvironment = {};
  if (typeof wt.bootstrapCommand === "string") out.bootstrapCommand = wt.bootstrapCommand;
  return out;
}

/** Read generation settings from node attrs, returning `undefined` when
 * nothing is set so `llm.start.settings` stays omitted rather than empty.
 * `reasoning_effort` is explicitly typed on `NodeAttrs`; the others live
 * in the `[extra: string]` bag and are picked up when present. */
function captureSettings(attrs: Record<string, unknown>):
  | {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      reasoning_effort?: "low" | "medium" | "high";
      stop?: string[];
    }
  | undefined {
  const settings: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    reasoning_effort?: "low" | "medium" | "high";
    stop?: string[];
  } = {};
  if (typeof attrs["temperature"] === "number") settings.temperature = attrs["temperature"];
  if (typeof attrs["max_tokens"] === "number") settings.max_tokens = attrs["max_tokens"];
  if (typeof attrs["top_p"] === "number") settings.top_p = attrs["top_p"];
  const effort = attrs["reasoning_effort"];
  if (effort === "low" || effort === "medium" || effort === "high") settings.reasoning_effort = effort;
  const stop = attrs["stop"];
  if (Array.isArray(stop) && stop.every((s): s is string => typeof s === "string")) settings.stop = stop;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Budget snapshot: cumulative counters are placeholders (0) until a real
 * BudgetLedger is wired; the ceilings are populated opportunistically
 * when a workflow author sets them on the node. Returns `undefined` if
 * there is nothing useful to surface. Emits only when a ceiling is set
 * — otherwise it's noise. */
function captureBudget(
  attrs: Record<string, unknown>,
): { cumulative_cost_usd: number; cumulative_tokens: number; max_cost_usd?: number } | undefined {
  const maxCost = typeof attrs["max_cost_usd"] === "number" ? attrs["max_cost_usd"] : undefined;
  if (maxCost === undefined) return undefined;
  return { cumulative_cost_usd: 0, cumulative_tokens: 0, max_cost_usd: maxCost };
}

/** Build the per-run agent-event subscriber: bridge each event to the fragua
 * event stream, record `cost.recorded` on assistant message ends, and persist
 * the fully-assembled AgentMessage to the messages table (skipping empty
 * error/abort failure envelopes, which would bloat the table on retry chains). */
export function buildMessageSubscriber(input: LlmInput): (event: AgentEvent) => Promise<void> {
  return async (event: AgentEvent) => {
    const bridged = bridgeAgentEvent(event);
    if (bridged && input.emit) await input.emit(bridged.type, bridged.data);
    if (event.type === "message_end") {
      if (event.message.role === "assistant" && input.emit) {
        await input.emit("cost.recorded", costPayload(event.message as AssistantMessage));
      }
      // Skip empty-content error/abort envelopes — pi-agent-core synthesises an
      // assistant message with `content: []` + `stopReason: "error" | "aborted"`
      // for a transport failure or in-flight abort. The row carries no tokens
      // and no recoverable content; persisting it bloats the messages table on
      // every provider-error retry chain. The `cost.recorded` above still fires.
      if (input.persistMessage) {
        const msg = event.message as AssistantMessage;
        const isEmptyFailureEnvelope =
          msg.role === "assistant" &&
          (msg.stopReason === "error" || msg.stopReason === "aborted") &&
          Array.isArray(msg.content) &&
          msg.content.length === 0;
        if (!isEmptyFailureEnvelope) input.persistMessage(event.message);
      }
    }
  };
}

/** Emit the resolved `llm.start` snapshot (SPEC §3.5). Large fields are not
 * inlined: the system prompt ships as sha256 + byte length (persisted separately
 * as a role='system' message) and the prior transcript is omitted (it lives in
 * the messages table). No-op when the call has no emit sink. */
export async function emitLlmStart(args: {
  input: LlmInput;
  provider: string;
  modelId: string;
  effectivePrompt: string;
  systemPrompt: string;
  threadId: string | undefined;
  thinkingLevel: ThinkingLevel;
  allow: string[] | undefined;
  deny: string[] | undefined;
  priorMessageCount: number;
  contextFileRecords: Awaited<ReturnType<typeof loadContextFiles>>["files"];
  effectiveSkills: readonly Skill[];
}): Promise<void> {
  const { input, provider, modelId, effectivePrompt, systemPrompt, threadId, thinkingLevel, allow, deny } = args;
  if (!input.emit) return;
  const systemPromptBytes = Buffer.byteLength(systemPrompt, "utf8");
  const llmStart: Record<string, unknown> = {
    provider,
    model: modelId,
    prompt: effectivePrompt,
    system_prompt_sha256: sha256Hex(systemPrompt),
    system_prompt_bytes: systemPromptBytes,
  };
  if (threadId) llmStart["thread_id"] = threadId;
  // The resolved thinking level — surfaced so "is thinking on?" is visible in
  // the event feed, not silently inherited from an upstream default.
  llmStart["thinking_level"] = thinkingLevel;
  if (allow) llmStart["allowed_tools"] = allow;
  if (deny) llmStart["denied_tools"] = deny;
  if (input.iteration) llmStart["iteration"] = input.iteration;
  if (args.priorMessageCount > 0) llmStart["prior_message_count"] = args.priorMessageCount;
  const settings = captureSettings(input.node.attrs as Record<string, unknown>);
  if (settings) llmStart["settings"] = settings;
  if (args.contextFileRecords.length > 0) llmStart["context_files"] = args.contextFileRecords;
  if (args.effectiveSkills.length > 0) llmStart["skills"] = args.effectiveSkills.map(toCatalogRecord);
  // Budget snapshot: prefer the executor-supplied cumulative value; fall back to
  // the zeroed shape derived from node attrs for callers not yet threaded.
  const budget = input.budgetSnapshot ?? captureBudget(input.node.attrs as Record<string, unknown>);
  if (budget) llmStart["budget"] = budget;
  await input.emit("llm.start", llmStart);
}

/** Load context files, build the per-call system prompt, and expose the run's
 * skill catalogue on `fraguaContext` for the `skill` tool's name lookup. */
export async function buildSystemPromptForCall(
  deps: SystemPromptDeps,
  args: {
    input: LlmInput;
    effectiveEnv: ExecutionEnvironment;
    skillsCatalog: string;
    effectiveSkills: readonly Skill[];
    fraguaContext: { skillCatalog?: readonly Skill[] };
  },
): Promise<{ systemPrompt: string; contextFileRecords: Awaited<ReturnType<typeof loadContextFiles>>["files"] }> {
  const { input, effectiveEnv, skillsCatalog, effectiveSkills, fraguaContext } = args;
  const contextFiles = applyDefaultContextFiles([]);
  const {
    text: contextBlock,
    warnings,
    files: contextFileRecords,
  } = await loadContextFiles(effectiveEnv, contextFiles);
  if (input.emit) {
    for (const msg of warnings) await input.emit("agent.warning", { message: msg });
  }
  const perNodeSystemPrompt = input.node.attrs.system_prompt;
  // Derive the per-call RunEnvironment so every llm call sees an
  // `<environment>` block; the construction-time `deps.runEnv` is only a
  // fallback for the bootstrap line.
  const derivedRunEnv = deriveRunEnv(effectiveEnv);
  const mergedBootstrap = derivedRunEnv.bootstrapCommand ?? deps.runEnv?.bootstrapCommand;
  const effectiveRunEnv: RunEnvironment = mergedBootstrap !== undefined ? { bootstrapCommand: mergedBootstrap } : {};
  const systemPrompt = buildSystemPrompt({
    global: deps.systemPrompt,
    perNode: perNodeSystemPrompt,
    contextBlock,
    skillsCatalog,
    runEnv: effectiveRunEnv,
  });
  Object.assign(fraguaContext, { skillCatalog: effectiveSkills });
  return { systemPrompt, contextFileRecords };
}

/** Pull the prior shared-thread transcript, emit a resume marker when this
 * (run, thread) was last written by a prior process, and sanitise any unpaired
 * trailing toolCall before pi-ai sees it. Returns the hydrate slice + the
 * thread policy the caller needs to persist afterwards. */
export async function hydrateThreadMessages(
  deps: HydrateDeps,
  args: {
    input: LlmInput;
    effectiveEnv: ExecutionEnvironment;
    fraguaContext: FraguaToolContext;
  },
): Promise<{
  hydrateMessages: AgentMessage[];
  storedForThread: AgentMessage[];
  threadId: string | undefined;
  persist: boolean;
}> {
  const { input, effectiveEnv, fraguaContext } = args;
  const threadId = input.thread_id;
  const hasThread = !!threadId;
  const hydrate = shouldHydrateFromStore(hasThread);
  const persist = shouldPersistToStore(hasThread);
  // `input.priorMessages` is the executor's messages-table load — the single
  // source of truth across daemon restarts. The in-process MessageStore is a
  // write-through cache so a same-process call that omits it stays consistent.
  const externalPrior = Array.isArray(input.priorMessages) ? (input.priorMessages as AgentMessage[]) : undefined;
  const storedForThread: AgentMessage[] = threadId
    ? (externalPrior ?? deps.messageStore.get(input.run_id, threadId))
    : [];
  if (externalPrior !== undefined && threadId) {
    deps.messageStore.set(input.run_id, threadId, storedForThread);
  }
  // Resume detection — purely observational; hydration is byte-identical
  // across restarts, so this only lets us log a rehydrate marker.
  const resumed =
    threadId != null &&
    externalPrior !== undefined &&
    storedForThread.length > 0 &&
    !deps.inProcessWrites.has(sessionKey(input.run_id, threadId));
  if (resumed && input.emit && threadId) {
    await input.emit("agent.info", {
      event: "thread_rehydrated",
      thread_id: threadId,
      message_count: storedForThread.length,
    });
  }
  let hydrateMessages: AgentMessage[] = hydrate && threadId ? storedForThread : [];
  // Pair any unpaired toolCall left at the tail of the rehydrated transcript
  // before pi-ai sees it — a crash mid-tool-execute leaves an unpaired
  // tool_use the anthropic API rejects. No-op on an empty / clean tail.
  if (hydrateMessages.length > 0) {
    hydrateMessages = await sanitiseUnpairedToolCalls(hydrateMessages, {
      toolRegistry: deps.registry,
      env: effectiveEnv,
      fraguaContext,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }
  return { hydrateMessages, storedForThread, threadId, persist };
}

/** Build the summary seed prepended to the user prompt when a node opted into
 * `summary=low|medium|high`; otherwise the prompt is unchanged. */
export async function buildEffectivePrompt(
  deps: EffectivePromptDeps,
  args: { input: LlmInput; storedForThread: AgentMessage[] },
): Promise<string> {
  const { input, storedForThread } = args;
  const graphGoal = typeof input.goal === "string" && input.goal.length > 0 ? input.goal : undefined;
  // Summariser events land under synthetic node ids; wire emit so a summary
  // call's events carry the right node_id on their envelope.
  const syntheticEmit = input.emit
    ? async (type: EventType, data: Record<string, unknown>, _node_id: string) => {
        await input.emit?.(type, data);
      }
    : undefined;
  const { seed, warnings: summaryWarnings } = await buildSummarySeed({
    summary: input.summary,
    graphGoal,
    runId: input.run_id,
    priorMessages: storedForThread,
    ...(deps.summariser !== undefined ? { summariser: deps.summariser } : {}),
    callerNodeId: input.node.id,
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    workflow_sha: input.workflow_sha,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(syntheticEmit !== undefined ? { emit: syntheticEmit } : {}),
  });
  if (input.emit) {
    for (const msg of summaryWarnings) await input.emit("agent.warning", { message: msg });
  }
  return seed.length > 0 ? `${seed}\n\n${input.prompt}` : input.prompt;
}

/** Drive `agent.prompt`, wiring the executor's abort signal to `agent.abort()`
 * and racing the awaited prompt against a short teardown grace so a wedged
 * provider fetch lands as an abort rather than a leaked-timeout halt. One
 * corrective re-prompt is issued when a required `emit_output` exit was
 * skipped. Cleans up the steer registration + listeners on every exit path. */
export async function executePromptLoop(
  deps: PromptLoopDeps,
  args: {
    agent: Agent;
    input: LlmInput;
    runId: string;
    effectivePrompt: string;
    hasRoutes: boolean;
    outputsDecl: OutputsDecl | undefined;
    hydratedCount: number;
    unsubscribe: () => void;
  },
): Promise<void> {
  const { agent, input, runId, effectivePrompt, hasRoutes, outputsDecl, hydratedCount, unsubscribe } = args;
  // Register this agent as the run's steer target and drain any buffered steer.
  deps.steering.beginRun(runId, agent, { nodeId: input.node.id, iteration: input.iteration?.n ?? 0 });
  // Wire the executor's abort signal to agent.abort() so control.cancel stops
  // the in-flight stream / tool loop instead of running to completion.
  const abortListener = () => agent.abort();
  if (input.signal) {
    input.signal.addEventListener("abort", abortListener, { once: true });
  }
  let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
  const promptDone = (async () => {
    await agent.prompt(effectivePrompt);
    await agent.waitForIdle();
    // One corrective re-prompt when a required `emit_output` exit was skipped —
    // absorbing a single transient miss. A second miss falls through to the
    // non-retryable failure below. Routing nodes + deliberate aborts + dead
    // provider turns are excluded.
    if (
      outputsDecl !== undefined &&
      !hasRoutes &&
      !input.signal?.aborted &&
      lastAssistantMessage(agent.state.messages) !== undefined &&
      findEmitOutputCall(agent.state.messages.slice(hydratedCount)) == null &&
      findAbortToolCall(agent.state.messages.slice(hydratedCount)) == null
    ) {
      await agent.prompt(EMIT_OUTPUT_REMINDER);
      await agent.waitForIdle();
    }
  })();
  // Already-aborted case: agent.abort() called before agent.prompt() existed is
  // a no-op, so queue it after prompt()'s synchronous prologue creates the
  // controller — otherwise the stream bills real tokens for the grace window.
  if (input.signal?.aborted) {
    queueMicrotask(() => agent.abort());
  }
  let armListener: (() => void) | undefined;
  const abortRace = input.signal
    ? new Promise<never>((_, reject) => {
        const arm = () => {
          abortGraceTimer = setTimeout(() => {
            const err = new Error("stream aborted (signal teardown grace exceeded)");
            err.name = "AbortError";
            reject(err);
          }, ABORT_TEARDOWN_GRACE_MS);
        };
        if (input.signal!.aborted) arm();
        else {
          armListener = arm;
          input.signal!.addEventListener("abort", arm, { once: true });
        }
      })
    : undefined;

  try {
    if (abortRace) await Promise.race([promptDone, abortRace]);
    else await promptDone;
  } finally {
    if (abortGraceTimer !== undefined) clearTimeout(abortGraceTimer);
    deps.steering.endRun(runId, agent);
    unsubscribe();
    if (input.signal) {
      input.signal.removeEventListener("abort", abortListener);
      // The `arm` once-listener never fires on a clean run — left registered it
      // pins this run scope to the signal's lifetime.
      if (armListener !== undefined) input.signal.removeEventListener("abort", armListener);
    }
  }
}
