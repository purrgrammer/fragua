// PiLlmBackend — LlmBackend backed by pi-agent-core + pi-ai.

import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type { LlmBackend, LlmInput, Outcome, OutputsDecl, SummariserBackend } from "@fragua/core";
import { fail } from "@fragua/core";
import type { SteerDelivery } from "@fragua/types";
import type { ExecutionEnvironment, McpConnector, Skill, ToolRegistry } from "@fragua/workspace";
import { resolveExitOutcome } from "./exit-tools.ts";
import { MessageStore } from "./message-store.ts";
import { classifyTerminalMessage, parseRetryAfterMs } from "./provider-errors.ts";
import { SteeringRegistry } from "./steering-registry.ts";
import type { RunEnvironment } from "./system-prompt.ts";
import { resolveSessionId } from "./thread.ts";
import { assembleAgentTools, materializeMcpTools, resolveEnvAndSkills, selectAndGateTools } from "./tool-assembly.ts";
import {
  buildEffectivePrompt,
  buildMessageSubscriber,
  buildSystemPromptForCall,
  emitLlmStart,
  executePromptLoop,
  hydrateThreadMessages,
  sessionKey,
} from "./transcript.ts";

export { findAbortToolCall, findEmitOutputCall, findRouteToolCall } from "./exit-tools.ts";
export {
  ANTHROPIC_OVERLOADED_STATUS,
  effectiveProviderHttpStatus,
  extractHttpStatusFromErrorMessage,
  isOverloadedErrorMessage,
  isTransientTransportErrorMessage,
  TRANSIENT_TRANSPORT_STATUS,
} from "./provider-errors.ts";
export { deriveRunEnv } from "./transcript.ts";

export interface PiLlmBackendOptions {
  registry: ToolRegistry;
  /** Default shell/filesystem environment. Used when `LlmInput.env`
   * is unset (tests, bare LocalEnvironment daemons). Production daemons
   * with a WorktreeProvisioner wire a per-run env via `LlmInput`
   * and can leave this unset. */
  env?: ExecutionEnvironment;
  /** Resolve an LLM model by provider + id. Defaults to pi-ai's getModel.
   * Daemons wire a ModelRegistry here so custom providers (Ollama etc.)
   * and `provider_config` overrides are honoured. */
  resolveModel?: (provider: string, modelId: string) => Model<string>;
  /** Optional API-key resolver forwarded to pi-agent-core's `Agent`.
   * When wired, the Agent calls this per-request to fetch credentials,
   * so keys don't have to live in process.env. Typically
   * `authStorage.getApiKey.bind(authStorage)`. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Model + provider used when a node doesn't specify them. */
  defaultModel?: { provider: string; model: string };
  /** Optional system prompt prepended to every run. Tests may omit this. */
  systemPrompt?: string;
  /** Optional summariser used for per-node `summary=low|medium|high`.
   * When omitted, the summary path falls back to a deterministic
   * role-census + tail template with a soft warning. */
  summariser?: SummariserBackend;
  /** Skills discovered by the CLI at startup (see @fragua/workspace
   * `discoverSkills`). Filtered per-node via `node.attrs.skills` and
   * `skills_disabled`. When the effective set is non-empty for a call,
   * the backend renders a tier-1 catalog into the system prompt and
   * adds a scoped `local:load_skill` tool to the run. */
  skills?: Skill[];
  /** Materialises MCP-server tools for a node's `mcp_servers`. When wired,
   * an llm node that lists servers gets each server's tools appended as
   * `mcp__<server>__<tool>`, connected lazily for the node and torn down when
   * it finishes. Omit to disable MCP entirely (tests / bare daemons). */
  mcpConnector?: McpConnector;
  /** Construction-time fallback for the `<environment>` block's bootstrap
   * line, for callers that know the bootstrap command but wire an env that
   * doesn't carry it. Only consulted when `deriveRunEnv` finds nothing on
   * the env; omitting it does NOT suppress the block, which every llm call
   * renders. Deliberately carries nothing per-run: the block heads the
   * prompt-cache prefix. */
  runEnv?: RunEnvironment;
  /** Shared "threads we've written to" registry, keyed by `runId::threadId`.
   * Each llm node builds its own `PiLlmBackend` (see
   * `packages/cli/src/commands/daemon.ts`), so a per-instance Set can't
   * tell "same daemon, different node on the shared thread" from
   * "different daemon after a restart". Pass a daemon-scoped Set here so
   * all backends share the signal. The daemon seeds it at boot from
   * `store.listThreadsWithMessages()` so a post-restart dispatch on a
   * pre-existing thread still finds its key present. Omit in
   * tests/one-shots to get the per-instance behaviour. */
  inProcessWrites?: Set<string>;
  /** Shared per-run live-agent + steer-buffer registry. Each llm
   * node builds its own `PiLlmBackend`, so a per-instance registry
   * can't deliver a steer issued during node A to node B's agent on the
   * same run. Pass one daemon-scoped registry here and supervisor's
   * `onSteer` writes through to it; every backend that runs a node for
   * the same `runId` finds the live-agent slot it expects. Omit in
   * tests/one-shots that don't need cross-backend steering. */
  steering?: SteeringRegistry;
}

export class PiLlmBackend implements LlmBackend {
  private readonly registry: ToolRegistry;
  private readonly env: ExecutionEnvironment | undefined;
  private readonly resolveModel: (provider: string, modelId: string) => Model<string>;
  private readonly getApiKey: ((provider: string) => Promise<string | undefined> | string | undefined) | undefined;
  private readonly defaultModel: { provider: string; model: string };
  private readonly systemPrompt: string;
  /** Per-run live-agent + pending-steer registry. Scoped by runId so two
   * concurrent runs on this shared backend can each have their own live
   * agent without clobbering each other's slot, and so a steer buffered
   * between one run's nodes never leaks into another run's agent. May be
   * shared across backends via `opts.steering` so a steer arriving while
   * node B is active still reaches the same run's live agent. */
  private readonly steering: SteeringRegistry;
  /** Per-backend transcript store keyed by `(run_id, thread_id)`. Scoped
   * to the backend instance so tests that spin up a fresh backend get a
   * clean store. Backends are shared across runs — one per `(workflow,
   * node)` per `packages/cli/src/commands/daemon.ts` — so the `run_id`
   * component is what isolates concurrent runs; without it two runs
   * sharing a `thread_id` (e.g. `thread_id="dev"`) would clobber each
   * other's transcripts. */
  private readonly messageStore: MessageStore;
  private readonly summariser: SummariserBackend | undefined;
  private readonly skills: readonly Skill[];
  private readonly runEnv: RunEnvironment | undefined;
  /** Per-(runId, threadId) flags marking threads this daemon has dispatched
   * on. A load of a non-empty transcript for a (run, thread) whose key is
   * missing is the resume signal — purely observational: thread hydration
   * is invariant across restarts, rehydration is byte-identical, and
   * provider caches either key off the stable thread_id (OpenAI Responses)
   * or the content itself (Anthropic / OpenAI Completions / Google). Shared
   * across every PiLlmBackend in the daemon when the caller wires
   * `opts.inProcessWrites` (see `packages/cli/src/commands/daemon.ts`);
   * per-instance otherwise. Purely in-memory — never persisted. */
  private readonly inProcessWrites: Set<string>;
  private readonly mcpConnector: McpConnector | undefined;

  constructor(opts: PiLlmBackendOptions) {
    this.registry = opts.registry;
    this.env = opts.env;
    // biome-ignore lint/suspicious/noExplicitAny: getModel (imported from @earendil-works/pi-ai/compat) is generically constrained to BuiltinProvider; we intentionally accept any string so custom/faux providers work.
    this.resolveModel = opts.resolveModel ?? ((provider, modelId) => (getModel as any)(provider, modelId));
    this.getApiKey = opts.getApiKey;
    this.defaultModel = opts.defaultModel ?? { provider: "anthropic", model: "claude-opus-4-7" };
    this.systemPrompt = opts.systemPrompt ?? "";
    this.messageStore = new MessageStore();
    this.summariser = opts.summariser;
    this.skills = opts.skills ?? [];
    this.runEnv = opts.runEnv;
    this.inProcessWrites = opts.inProcessWrites ?? new Set<string>();
    this.steering = opts.steering ?? new SteeringRegistry();
    this.mcpConnector = opts.mcpConnector;
  }

  /** True when we've already persisted `threadId` for `runId` during
   * *this* backend instance's lifetime. Exposed for tests; production
   * callers should not need this. */
  hasInProcessWrite(runId: string, threadId: string): boolean {
    return this.inProcessWrites.has(sessionKey(runId, threadId));
  }

  /** Direct access to the transcript store. Exposed for tests and, later,
   * for a checkpoint writer that serialises it into `pi_sessions`. */
  get messages(): MessageStore {
    return this.messageStore;
  }

  /** Checkpoint bridge. Serialise the per-thread transcript so a caller
   * can save it alongside the rest of a run's state. */
  serialiseSessions(): Record<string, unknown> {
    return this.messageStore.serialise();
  }

  /** Resume bridge. Replace the backend's MessageStore with a previously-
   * serialised snapshot so the first post-resume backend.run() sees the
   * correct prior transcript under any shared thread_id. */
  hydrateSessions(sessions: Record<string, unknown>): void {
    this.messageStore.hydrate(sessions);
  }

  async run(input: LlmInput): Promise<Outcome> {
    // Cleanup callbacks registered during the run (currently MCP connection
    // teardown). Runs on every exit path so a lazily-connected server is never
    // left dangling, no matter which of runInner's many returns fires.
    const disposers: Array<() => Promise<void>> = [];
    try {
      return await this.runInner(input, disposers);
    } finally {
      for (const dispose of disposers) {
        try {
          await dispose();
        } catch {
          // best-effort teardown — a failed close must not mask the run outcome.
        }
      }
    }
  }

  private async runInner(input: LlmInput, disposers: Array<() => Promise<void>>): Promise<Outcome> {
    const provider = input.node.attrs.provider ?? this.defaultModel.provider;
    const modelId = input.node.attrs.model ?? this.defaultModel.model;
    let model: Model<string> | undefined;
    try {
      model = this.resolveModel(provider, modelId);
    } catch (err) {
      return fail(`unknown model "${provider}/${modelId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!model) {
      return fail(
        `model "${provider}/${modelId}" is not registered in pi-ai. ` +
          "Check spelling (OpenRouter uses dotted IDs like `anthropic/claude-opus-4.7`; Anthropic-direct uses hyphens like `claude-opus-4-7`). " +
          "Run `fragua providers` to list supported providers.",
      );
    }
    if (typeof model.api !== "string" || model.api === "" || model.api === "unknown") {
      return fail(`model "${provider}/${modelId}" has no valid API binding (api="${String(model.api)}").`);
    }

    const toolDeps = {
      registry: this.registry,
      mcpConnector: this.mcpConnector,
      skills: this.skills,
      env: this.env,
    };
    const gated = selectAndGateTools(input, toolDeps);
    if ("outcome" in gated) return gated.outcome;
    const { declaredMcpServers, mcpOnlyAllowlist, allow, deny } = gated;
    let finalTools = gated.finalTools;

    const envSkills = resolveEnvAndSkills(input, toolDeps);
    if ("outcome" in envSkills) return envSkills.outcome;
    const { effectiveEnv, effectiveSkills, skillsCatalog, runProjectCwd } = envSkills;

    // Reconcile the `skill` tool against this node's effective catalogue:
    // force-include it when the catalogue is non-empty (same terms as `abort`),
    // strip it when empty (a `skill` tool with no catalogue resolves no name).
    if (effectiveSkills.length > 0) {
      const skillTool = this.registry.get("skill");
      if (skillTool && !finalTools.some((t) => t.name === "skill")) finalTools = [...finalTools, skillTool];
    } else {
      finalTools = finalTools.filter((t) => t.name !== "skill");
    }
    // The `judge` tool is only real when the run carries a System One client;
    // strip it rather than advertise a dead tool.
    if (input.judge === undefined) finalTools = finalTools.filter((t) => t.name !== "judge");

    const materialized = await materializeMcpTools(toolDeps, {
      input,
      finalTools,
      declaredMcpServers,
      mcpOnlyAllowlist,
      allow,
      runProjectCwd,
      disposers,
    });
    if ("outcome" in materialized) return materialized.outcome;
    finalTools = materialized.finalTools;

    const nodeRoutes = input.node.attrs.routes as string[] | undefined;
    const outputsDecl = (input.outputsDecl ?? input.node.attrs.outputs) as OutputsDecl | undefined;
    const hasRoutes = Array.isArray(nodeRoutes) && nodeRoutes.length > 0;
    const { tools, fraguaContext } = assembleAgentTools({
      input,
      finalTools,
      effectiveEnv,
      nodeRoutes,
      outputsDecl,
    });

    const { systemPrompt, contextFileRecords } = await buildSystemPromptForCall(
      { systemPrompt: this.systemPrompt, runEnv: this.runEnv },
      {
        input,
        effectiveEnv,
        skillsCatalog,
        effectiveSkills,
        fraguaContext,
      },
    );

    const { hydrateMessages, storedForThread, threadId, persist } = await hydrateThreadMessages(
      { messageStore: this.messageStore, inProcessWrites: this.inProcessWrites, registry: this.registry },
      {
        input,
        effectiveEnv,
        fraguaContext,
      },
    );
    const effectivePrompt = await buildEffectivePrompt({ summariser: this.summariser }, { input, storedForThread });

    // sessionId is a provider-cache hint (not a message restore).
    const sessionId = resolveSessionId({ threadId, summary: input.summary });

    // Capture the last HTTP response status pi-ai received per LLM call, so a
    // `stopReason="error"` end can be classified as a transport failure (4xx/5xx)
    // versus a content/tool failure and routed to a resumable pause.
    let lastHttpStatus: number | null = null;
    let lastRetryAfterMs: number | undefined;
    const captureResponse = (response: { status: number; headers: Record<string, string> }) => {
      lastHttpStatus = response.status;
      lastRetryAfterMs = parseRetryAfterMs(response.headers);
    };

    // Reasoning/thinking level resolved explicitly (never inherit pi-agent-core's
    // silent "off" default) from the node's `effort` + the model's capability.
    const thinkingLevel = resolveThinkingLevel(model, input.node.attrs as Record<string, unknown>);

    // Boundary between the rehydrated shared-thread history and this turn's fresh
    // messages. Every self-abort / route / emit scan below is scoped to the slice
    // AFTER this index so a hydrated upstream `abort` toolCall isn't re-detected.
    const hydratedCount = hydrateMessages.length;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        thinkingLevel,
        ...(hydrateMessages.length > 0 ? { messages: hydrateMessages } : {}),
      },
      onResponse: captureResponse,
      streamFn: (model, ctx, options) => streamSimple(model, ctx, { ...options, maxRetries: PROVIDER_SDK_MAX_RETRIES }),
      maxRetryDelayMs: PROVIDER_SDK_MAX_RETRY_DELAY_MS,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(this.getApiKey !== undefined ? { getApiKey: this.getApiKey } : {}),
    });

    // Persist the system prompt as a fragua `system` custom message so the full
    // text is recoverable from the messages table while `llm.start` stays under
    // the 4KB event cap (§I7).
    if (input.persistMessage && systemPrompt.length > 0) {
      input.persistMessage({ role: "system", content: systemPrompt, timestamp: Date.now() });
    }

    await emitLlmStart({
      input,
      provider,
      modelId,
      effectivePrompt,
      systemPrompt,
      threadId,
      thinkingLevel,
      allow,
      deny,
      priorMessageCount: agent.state.messages.length,
      contextFileRecords,
      effectiveSkills,
    });

    const unsubscribe = agent.subscribe(buildMessageSubscriber(input));
    const runId = input.run_id;
    await executePromptLoop(
      { steering: this.steering },
      {
        agent,
        input,
        runId,
        effectivePrompt,
        hasRoutes,
        outputsDecl,
        hydratedCount,
        unsubscribe,
      },
    );

    // Persist the final transcript on a shared thread so subsequent nodes with
    // the same thread_id see it; stamp `inProcessWrites` so the next call isn't
    // misread as a resume.
    if (persist && threadId) {
      this.messageStore.set(input.run_id, threadId, agent.state.messages);
    }
    if (threadId) {
      this.inProcessWrites.add(sessionKey(input.run_id, threadId));
    }

    const terminal = classifyTerminalMessage({
      messages: agent.state.messages,
      provider,
      lastHttpStatus,
      lastRetryAfterMs,
      hydratedCount,
      signalAborted: input.signal?.aborted ?? false,
    });
    if (terminal !== null) return terminal;

    return resolveExitOutcome({ messages: agent.state.messages, hydratedCount, nodeRoutes, outputsDecl });
  }

  /** Inject a user message into the currently active agent for `runId`,
   * or buffer it for that run's next agent when nothing is running.
   * Called by the executor's control loop when a `control.steer` request
   * arrives. Fire-and-forget from the caller's point of view.
   *
   * `runId` is required so a steer can never leak across concurrent runs
   * on this shared backend — a caller that doesn't know the target runId
   * shouldn't be calling steer at all. */
  steer(runId: string, message: string): SteerDelivery {
    return this.steering.steer(runId, message);
  }

  /** Release every per-run resource this backend holds for `runId`.
   * Called by the executor after a run reaches a terminal status. Without
   * this, a run that buffered a steer but never started another llm
   * node would leak its `pendingSteers` entry until daemon restart —
   * bounded but pointless. Also wipes the `MessageStore` slot and any
   * `inProcessWrites` entries for the run so checkpoint bookkeeping
   * stays tight. Safe to call for a runId with no state. */
  forgetRun(runId: string): void {
    this.steering.forgetRun(runId);
    this.messageStore.clearRun(runId);
    const prefix = `${runId}::`;
    for (const key of this.inProcessWrites) {
      if (key.startsWith(prefix)) this.inProcessWrites.delete(key);
    }
  }
}

// The Anthropic SDK's built-in retry honors `retry-after` /
// `retry-after-ms` / `anthropic-ratelimit-*` headers, so it is the
// correct layer to wait out a rate-limit window. fragua's own engine-
// retry (PROVIDER_RETRY_MAX_ATTEMPTS = 5) is header-blind for
// pre-stream 429s and remains the backstop when the SDK also exhausts.
const PROVIDER_SDK_MAX_RETRIES = 8;
// Cap the per-attempt SDK wait so a single very-long `retry-after`
// cannot hang a step indefinitely.
const PROVIDER_SDK_MAX_RETRY_DELAY_MS = 60_000;

/** Resolve the pi-ai `reasoning` (thinking) level for a dispatch.
 *
 * pi-agent-core defaults `thinkingLevel` to "off" — so unless we set it
 * explicitly, every node runs with no thinking channel. We map from the node's
 * `effort` (parsed to `reasoning_effort`: low | medium | high) and only enable
 * thinking on models that advertise the capability (`model.reasoning`). When a
 * reasoning-capable model's node doesn't pin an effort, default to "medium" — a
 * balanced level that gives the model a real place to reason (authors raise it
 * with `effort: high`). Non-reasoning models always get "off". */
export function resolveThinkingLevel(model: Model<string>, attrs: Record<string, unknown>): ThinkingLevel {
  if ((model as { reasoning?: boolean }).reasoning !== true) return "off";
  const effort = attrs["reasoning_effort"];
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return "medium";
}
