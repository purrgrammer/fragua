// PiCodergenBackend — CodergenBackend backed by pi-agent-core + pi-ai.

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type Model } from "@mariozechner/pi-ai";
import type { CodergenBackend, CodergenInput, EventType, FidelityMode, Outcome, SummariserBackend } from "@swarm/core";
import { degradeOnResume, fail, ok } from "@swarm/core";
import type { ExecutionEnvironment, Skill, ToolRegistry } from "@swarm/workspace";
import { filterSkillsForNode, renderSkillsCatalog, toCatalogRecord } from "@swarm/workspace";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { buildFidelitySeed, resolveSessionId, shouldHydrateFromStore, shouldPersistToStore } from "./fidelity.ts";
import { MessageStore } from "./message-store.ts";
import { buildSystemPrompt, loadContextFiles, type RunEnvironment } from "./system-prompt.ts";
import { toAgentTool } from "./tool-adapter.ts";

export interface PiCodergenBackendOptions {
  registry: ToolRegistry;
  env: ExecutionEnvironment;
  /** Resolve an LLM model by provider + id. Defaults to pi-ai's getModel. */
  resolveModel?: (provider: string, modelId: string) => Model<string>;
  /** Model + provider used when a node doesn't specify them. */
  defaultModel?: { provider: string; model: string };
  /** Optional system prompt prepended to every run. Tests may omit this. */
  systemPrompt?: string;
  /** Optional summariser used for `fidelity=summary:medium/high`. When
   * omitted those modes fall back to the deterministic `summary:low`
   * template with a soft warning. */
  summariser?: SummariserBackend;
  /** Skills discovered by the CLI at startup (see @swarm/workspace
   * `discoverSkills`). Filtered per-node via `node.attrs.skills` and
   * `skills_disabled`. When the effective set is non-empty for a call,
   * the backend renders a tier-1 catalog into the system prompt and
   * adds a scoped `local:load_skill` tool to the run. */
  skills?: Skill[];
  /** Per-run isolation facts — worktree path, run id, log dir, bootstrap
   * command. When provided, the backend prepends a `<run-environment>`
   * block to every node's system prompt so agents know where they are
   * and which dependencies are installed. Omit for bare LocalEnvironment
   * runs that don't need the preamble. */
  runEnv?: RunEnvironment;
}

export class PiCodergenBackend implements CodergenBackend {
  private readonly registry: ToolRegistry;
  private readonly env: ExecutionEnvironment;
  private readonly resolveModel: (provider: string, modelId: string) => Model<string>;
  private readonly defaultModel: { provider: string; model: string };
  private readonly systemPrompt: string;
  /** The agent currently running inside `run()`. When a steer request
   * lands mid-node it's injected directly; if no agent is active the
   * message is buffered on `pendingSteers` and drained into the next
   * agent on its next turn. */
  private activeAgent: Agent | undefined;
  private pendingSteers: string[] = [];
  /** Per-backend transcript store keyed by `thread_id`. Scoped to the
   * backend instance so tests that spin up a fresh backend get a clean
   * store. The executor creates one backend per run today, which means
   * two concurrent runs already get isolated stores — no cross-run leak. */
  private readonly messageStore: MessageStore;
  private readonly summariser: SummariserBackend | undefined;
  private readonly skills: readonly Skill[];
  private readonly runEnv: RunEnvironment | undefined;
  /** Per-(runId, threadId) flags marking threads we've *written* to in
   * THIS process. A load of a non-empty transcript for a (run, thread)
   * whose key is missing here is the resume signal: the transcript is
   * from a prior process, so the pi-ai sessionId is stale and
   * fidelity=full must degrade to summary:high (SPEC §3.6). Purely
   * in-memory — never persisted. */
  private readonly inProcessWrites = new Set<string>();

  constructor(opts: PiCodergenBackendOptions) {
    this.registry = opts.registry;
    this.env = opts.env;
    // biome-ignore lint/suspicious/noExplicitAny: getModel is overloaded with KnownProvider; we intentionally accept any string so custom/faux providers work.
    this.resolveModel = opts.resolveModel ?? ((provider, modelId) => (getModel as any)(provider, modelId));
    this.defaultModel = opts.defaultModel ?? { provider: "anthropic", model: "claude-opus-4-7" };
    this.systemPrompt = opts.systemPrompt ?? "";
    this.messageStore = new MessageStore();
    this.summariser = opts.summariser;
    this.skills = opts.skills ?? [];
    this.runEnv = opts.runEnv;
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

  async run(input: CodergenInput): Promise<Outcome> {
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
          "Run `swarm providers` to list supported providers.",
      );
    }
    if (typeof model.api !== "string" || model.api === "" || model.api === "unknown") {
      return fail(`model "${provider}/${modelId}" has no valid API binding (api="${String(model.api)}").`);
    }

    const selectOpts: { allow?: string[]; deny?: string[] } = {};
    const allow = input.node.attrs.allowed_tools as string[] | undefined;
    const deny = input.node.attrs.denied_tools as string[] | undefined;
    if (allow) selectOpts.allow = allow;
    if (deny) selectOpts.deny = deny;
    const selectedTools = this.registry.select(selectOpts);

    // Resolve the skill catalog for this call. Filter by node attrs, render
    // the catalog block for the system prompt, and mint a scoped
    // `local:load_skill` tool whose `name` enum matches the filtered set.
    // Skills are injected into the system prompt as a catalog listing;
    // agents read the SKILL.md at `<location>` directly via the `read`
    // tool. No dedicated load-skill tool exists under the trimmed
    // four-tool surface (read / write / edit / bash).
    const nodeSkills = input.node.attrs.skills as string[] | undefined;
    const skillFilter: { skills?: readonly string[]; skills_disabled?: boolean } = {
      skills_disabled: input.node.attrs.skills_disabled === true,
    };
    if (nodeSkills !== undefined) skillFilter.skills = nodeSkills;
    const effectiveSkills = filterSkillsForNode(this.skills, skillFilter);
    const skillsCatalog = renderSkillsCatalog(effectiveSkills);
    const tools = selectedTools.map((t) => toAgentTool(t, this.env));

    const contextFiles = (input.node.attrs.context_files as string[] | undefined) ?? [];
    const { text: contextBlock, warnings, files: contextFileRecords } = await loadContextFiles(this.env, contextFiles);
    if (input.emit) {
      for (const msg of warnings) await input.emit("agent.warning", { message: msg });
    }
    const perNodeSystemPrompt =
      typeof input.node.attrs["system_prompt"] === "string" ? (input.node.attrs["system_prompt"] as string) : undefined;
    const systemPrompt = buildSystemPrompt({
      global: this.systemPrompt,
      perNode: perNodeSystemPrompt,
      contextBlock,
      skillsCatalog,
      ...(this.runEnv !== undefined ? { runEnv: this.runEnv } : {}),
    });

    // Fidelity policy gates. `context="fresh"` on a node is a hard opt-out
    // of any cross-node transcript sharing — it wins over thread_id and
    // fidelity=full alike. Anything else follows the per-mode rules in
    // ./fidelity.ts.
    const isFresh = input.node.attrs["context"] === "fresh";
    const threadId = input.thread_id;
    const hydrate = shouldHydrateFromStore(input.fidelity, isFresh);
    const persist = shouldPersistToStore(input.fidelity, isFresh);

    // Pull the prior transcript. `input.priorMessages` is populated by
    // the executor from the messages table when a prior transcript
    // exists for (runId, threadId); it's the single source of truth
    // across daemon restarts. The backend's in-process MessageStore is
    // a write-through cache populated from this input so tests that
    // skip priorMessages still see consistent behaviour inside one
    // process.
    const externalPrior = Array.isArray(input.priorMessages) ? (input.priorMessages as AgentMessage[]) : undefined;
    const storedForThread: AgentMessage[] =
      !isFresh && threadId ? (externalPrior ?? this.messageStore.get(threadId)) : [];
    if (externalPrior !== undefined && threadId) {
      // Keep the in-memory cache in sync so a subsequent same-process
      // call that omits priorMessages still sees the right history.
      this.messageStore.set(threadId, storedForThread);
    }

    // Resume detection. When the executor hands us a non-empty
    // transcript for a (runId, threadId) we haven't written to in
    // *this* process, the pi-ai sessionId is from a prior daemon life
    // and the provider's KV cache is gone. SPEC §3.6 says degrade
    // fidelity=full to summary:high; other modes already build a seed
    // from priorMessages so they're unaffected.
    const decision = computeResumeDecision({
      fidelity: input.fidelity,
      isFresh,
      threadId,
      externalPriorLen: externalPrior !== undefined ? storedForThread.length : -1,
      hasInProcessWrite: threadId != null && this.inProcessWrites.has(sessionKey(input.run_id, threadId)),
    });
    const resumed = decision.resumed;
    const effectiveFidelity = decision.effectiveFidelity;
    const effectiveHydrate = resumed ? shouldHydrateFromStore(effectiveFidelity, isFresh) : hydrate;
    if (resumed && input.emit) {
      await input.emit("agent.warning", {
        message: `resuming thread "${threadId}" after daemon restart — fidelity=${input.fidelity} degraded to ${effectiveFidelity}`,
      });
    }

    const hydrateMessages: AgentMessage[] = effectiveHydrate && threadId ? storedForThread : [];

    // Build the fidelity seed prepended to the user prompt for non-full
    // modes. `full` returns "" and the user prompt is unchanged. `truncate`
    // / `compact` / `summary:*` produce a <swarm-context> block framing
    // the agent with goal + run + digest of priorMessages.
    const graphGoalRaw = input.context["graph.goal"];
    const graphGoal = typeof graphGoalRaw === "string" && graphGoalRaw.length > 0 ? graphGoalRaw : undefined;
    // Summariser events land under synthetic node ids (see
    // @swarm/core/types/summariser.ts). `buildFidelitySeed` wires the
    // emit callback so `summary.started` / `summary.completed` /
    // `cost.recorded` for a summary:medium/high call carry the right
    // node_id on their envelope — not the caller's.
    const syntheticEmit = input.emit
      ? async (type: EventType, data: Record<string, unknown>, _node_id: string) => {
          await input.emit?.(type, data);
        }
      : undefined;
    const { seed, warnings: fidelityWarnings } = await buildFidelitySeed({
      fidelity: effectiveFidelity,
      graphGoal,
      runId: input.run_id,
      priorMessages: storedForThread,
      ...(this.summariser !== undefined ? { summariser: this.summariser } : {}),
      callerNodeId: input.node.id,
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      workflow_sha: input.workflow_sha,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(syntheticEmit !== undefined ? { emit: syntheticEmit } : {}),
    });
    if (input.emit) {
      for (const msg of fidelityWarnings) await input.emit("agent.warning", { message: msg });
    }
    const effectivePrompt = seed.length > 0 ? `${seed}\n\n${input.prompt}` : input.prompt;

    // sessionId is a provider-cache hint (not a message restore). Pick
    // the right bucket so cache hits work and different fidelities don't
    // clobber each other's cache under the same thread.
    const sessionId = resolveSessionId({ fidelity: effectiveFidelity, threadId, isFresh });

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        ...(hydrateMessages.length > 0 ? { messages: hydrateMessages } : {}),
      },
      ...(sessionId !== undefined ? { sessionId } : {}),
    });

    // Emit the resolved LLM-call snapshot. See docs/SPEC.md §3.5 for the
    // contract. Adding fields is additive — schema_version on the
    // envelope only bumps on incompatible renames/removals.
    if (input.emit) {
      const llmStart: Record<string, unknown> = {
        provider,
        model: modelId,
        prompt: effectivePrompt,
        system_prompt: systemPrompt,
      };
      if (threadId) llmStart["thread_id"] = threadId;
      if (allow) llmStart["allowed_tools"] = allow;
      if (deny) llmStart["denied_tools"] = deny;
      if (input.iteration) llmStart["iteration"] = input.iteration;
      const priorSnapshot = agent.state.messages.map((m) => jsonSafe(m));
      if (priorSnapshot.length > 0) llmStart["messages"] = priorSnapshot;
      const settings = captureSettings(input.node.attrs);
      if (settings) llmStart["settings"] = settings;
      if (contextFileRecords.length > 0) llmStart["context_files"] = contextFileRecords;
      if (effectiveSkills.length > 0) llmStart["skills"] = effectiveSkills.map(toCatalogRecord);
      const budget = captureBudget(input.node.attrs);
      if (budget) llmStart["budget"] = budget;
      await input.emit("llm.start", llmStart);
    }

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      const bridged = bridgeAgentEvent(event);
      if (bridged && input.emit) await input.emit(bridged.type, bridged.data);
      if (event.type === "message_end") {
        if (event.message.role === "assistant" && input.emit) {
          await input.emit("cost.recorded", costPayload(event.message as AssistantMessage));
        }
        // Persist the fully-assembled message to the messages table.
        // Payload content is unbounded — if we shoved it onto the
        // event envelope we'd bust the 4KB I7 cap on the first sizable
        // assistant turn. Messages table's `content` is TEXT with no
        // such limit, matching §I9's "LLM-visible preview" split.
        //
        // We pass BOTH the flattened `content` (for UI rendering) and
        // the full AgentMessage JSON (for resume-path rehydration —
        // the flattened text is lossy for tool_use blocks, images,
        // and structured tool_result payloads). pi-agent-core's
        // `toolResult` role maps onto swarm's `"tool"` MessageRole;
        // anything else unexpected is skipped (custom UI-only messages
        // that don't round-trip through pi-ai).
        if (input.persistMessage) {
          const mappedRole = mapAgentRoleToMessageRole(event.message.role);
          if (mappedRole !== undefined) {
            const content = extractMessageText(event.message);
            const payload = safeStringify(event.message);
            if (content.length > 0 || payload !== undefined) {
              input.persistMessage(mappedRole, content, payload);
            }
          }
        }
      }
    });

    // Register this agent as the current steer target and drain any messages
    // that landed while no agent was active (e.g. a steer fired between nodes).
    // `steer()` below calls agent.steer() directly when activeAgent is set.
    this.activeAgent = agent;
    for (const buffered of this.pendingSteers.splice(0)) this.injectSteer(agent, buffered);

    // Wire the executor's abort signal to agent.abort() so control.cancel
    // actually stops the in-flight LLM stream / tool loop. Without this the
    // executor trips its AbortController but the Agent keeps running to
    // completion, leaving the run streaming minutes after cancel landed.
    const abortListener = () => agent.abort();
    if (input.signal) {
      if (input.signal.aborted) agent.abort();
      else input.signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      await agent.prompt(effectivePrompt);
      await agent.waitForIdle();
    } finally {
      this.activeAgent = undefined;
      unsubscribe();
      if (input.signal) input.signal.removeEventListener("abort", abortListener);
    }

    // Persist the final transcript for `full` fidelity on a shared thread
    // so subsequent nodes with the same thread_id actually see it. Every
    // other mode is explicitly fresh (SPEC §3.3) and must not contaminate
    // the full-mode cache under the same thread.
    if (persist && threadId) {
      this.messageStore.set(threadId, agent.state.messages);
    }
    // Stamp `inProcessWrites` whenever a threaded node runs so the next
    // call in this process isn't misread as a resume. This has to fire
    // regardless of `persist` — e.g. a compact-mode node on the same
    // thread still proves "we're alive and past any pre-crash state".
    if (threadId) {
      this.inProcessWrites.add(sessionKey(input.run_id, threadId));
    }

    const last = agent.state.messages[agent.state.messages.length - 1];
    if (!last) return fail("agent produced no messages");

    if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      return fail(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
        notes: summarizeMessage(last),
      });
    }

    // Self-abort: an agent may decide its task is unreachable (missing target,
    // contradictory constraints, external blocker) and emit `<abort>reason</abort>`.
    // Treating that as a `fail` outcome lets workflows wire an early-exit edge
    // with `condition="outcome=fail"` instead of forwarding the whole run
    // through a no-op plan → implement → verify chain. We also flag it
    // `non_retryable` so the goal-gate retry machinery doesn't relaunch the
    // run after an explicit stop.
    const notes = summarizeMessage(last);
    const aborted = parseAbortMarker(notes);
    if (aborted) return fail(aborted.reason, { notes, non_retryable: true });

    return ok({ notes });
  }

  /** CodergenBackend.steer — inject a user message into the currently
   * active agent, or buffer it for the next agent when no node is running.
   * Called by the executor's control loop when a `control.steer` request
   * arrives. Fire-and-forget from the caller's point of view. */
  steer(message: string): void {
    if (!message) return;
    const agent = this.activeAgent;
    if (agent) {
      this.injectSteer(agent, message);
      return;
    }
    // No node is currently running; queue the message for the next
    // agent so a steer fired between nodes isn't dropped.
    this.pendingSteers.push(message);
  }

  private injectSteer(agent: Agent, message: string): void {
    agent.steer({
      role: "user",
      content: [{ type: "text", text: message }],
      timestamp: Date.now(),
    });
  }
}

function sessionKey(runId: string, threadId: string): string {
  return `${runId}::${threadId}`;
}

/** Pure resume-decision helper, extracted for unit testability.
 *
 * Inputs:
 *   - `fidelity`: the mode declared on the node.
 *   - `isFresh`: `context="fresh"` was set; no cross-node sharing.
 *   - `threadId`: resolved thread id, or `undefined` if the node has
 *     none (no thread = no possible resume).
 *   - `externalPriorLen`: number of messages supplied via
 *     `CodergenInput.priorMessages`. Use `-1` to signal "caller did
 *     not supply priorMessages at all" (legacy / test paths) — those
 *     never count as resume.
 *   - `hasInProcessWrite`: `inProcessWrites` already has this
 *     `(runId, threadId)` — means we wrote it earlier in THIS process,
 *     so any transcript is ours and the provider cache is live.
 *
 * Returns `{ resumed, effectiveFidelity }` where `effectiveFidelity`
 * is the fidelity to actually use for the seed + session resolution.
 * `resumed=true` implies `fidelity=full` was degraded per §3.6.
 */
export function computeResumeDecision(args: {
  fidelity: FidelityMode;
  isFresh: boolean;
  threadId: string | undefined;
  externalPriorLen: number;
  hasInProcessWrite: boolean;
}): { resumed: boolean; effectiveFidelity: FidelityMode } {
  const resumed = !args.isFresh && args.threadId != null && args.externalPriorLen > 0 && !args.hasInProcessWrite;
  const effectiveFidelity: FidelityMode = resumed ? degradeOnResume(args.fidelity) : args.fidelity;
  return { resumed, effectiveFidelity };
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** pi-agent-core's AgentMessage role space (`user`, `assistant`,
 * `toolResult`, plus arbitrary custom strings) → swarm's narrower
 * MessageRole union (`system | user | assistant | tool`). Returns
 * undefined for custom / UI-only roles that have no swarm equivalent. */
function mapAgentRoleToMessageRole(role: string): "assistant" | "tool" | "user" | "system" | undefined {
  switch (role) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    case "system":
      return "system";
    case "toolResult":
    case "tool":
      return "tool";
    default:
      return undefined;
  }
}

/** Flatten pi-agent-core `AgentMessage.content` (string | ContentBlock[])
 * into a plain string suitable for the messages table. Mirrors
 * `summarizeMessage` but without the 4KB cap — the messages table has
 * no size limit. Tool result blocks are stringified best-effort. */
function extractMessageText(message: { role: string; content?: unknown }): string {
  const c = message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const block of c) {
    if (block == null || typeof block !== "object") continue;
    const b = block as { type?: string; text?: unknown; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_result") {
      if (typeof b.content === "string") parts.push(b.content);
      else if (Array.isArray(b.content)) {
        for (const inner of b.content) {
          if (inner && typeof inner === "object") {
            const t = (inner as { text?: unknown }).text;
            if (typeof t === "string") parts.push(t);
          }
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function summarizeMessage(message: { role: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .slice(0, 4_000);
}

/**
 * Parse the final assistant text for a self-abort marker. The agent signals
 * "I cannot proceed" by emitting `<abort>reason</abort>` anywhere in its
 * final message. The reason is trimmed and clamped to a single line so it
 * can be surfaced as a `failure_reason` without dragging in kilobytes of
 * reasoning. Returns `null` when no marker is present.
 *
 * Exported so workflows (and tests) can rely on the exact contract without
 * reimplementing regex matching.
 */
export function parseAbortMarker(text: string): { reason: string } | null {
  if (!text) return null;
  const m = text.match(/<abort>([\s\S]*?)<\/abort>/i);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  // Collapse any internal newlines; cap length.
  const oneLine = raw.replace(/\s+/g, " ").slice(0, 400);
  return { reason: oneLine.length > 0 ? oneLine : "agent aborted without a reason" };
}

/** JSON round-trip a value so the captured copy is detached from live
 * agent state and guaranteed JSON-safe. Functions / symbols / undefineds
 * inside content blocks get stripped by JSON.stringify; anything that
 * throws falls back to a minimal record so a single unserialisable
 * message doesn't take down the whole snapshot. */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    // Typical cause: a Symbol or BigInt lurking in content. The role is
    // still worth preserving.
    const role = (value as { role?: unknown } | null)?.role;
    return { role: typeof role === "string" ? role : "unknown", unserialisable: true };
  }
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
