// PiCodergenBackend — CodergenBackend backed by pi-agent-core + pi-ai.

import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type Model } from "@mariozechner/pi-ai";
import type { CodergenBackend, CodergenInput, EventType, Outcome, SummariserBackend } from "@swarm/core";
import { fail, ok } from "@swarm/core";
import type { ExecutionEnvironment, Skill, ToolRegistry } from "@swarm/workspace";
import { buildLoadSkillTool, filterSkillsForNode, renderSkillsCatalog, toCatalogRecord } from "@swarm/workspace";
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
   * template with a soft warning — behaviour matches Wave 2. */
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

  /** Direct access to the transcript store. Exposed for tests and, later,
   * for a checkpoint writer that serialises it into `pi_sessions`. */
  get messages(): MessageStore {
    return this.messageStore;
  }

  /** Wave 6 checkpoint bridge. The executor calls this after each
   * node transition so the saved snapshot's `pi_sessions` field has
   * the full per-thread transcript. */
  serialiseSessions(): Record<string, unknown> {
    return this.messageStore.serialise();
  }

  /** Wave 6 resume bridge. On `execute({ resume: true })` the loaded
   * checkpoint's `pi_sessions` replaces the backend's MessageStore so
   * the first post-resume backend.run() sees the correct prior
   * transcript under any shared thread_id. */
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

    // Wave 4 budget pre-flight. The executor flips `budget_stopped` to
    // true on the shared ref as soon as the BudgetLedger sees a stop
    // verdict on a prior cost.recorded event. We must bail here before
    // spending any more on agent.prompt() — returning non_retryable so
    // the goal-gate retry machinery doesn't relaunch the same call.
    if (input.budget_stopped === true) {
      const reason = budgetStopReason(input.budget);
      return fail(reason, { non_retryable: true });
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
    // The tool is appended to the per-call tools list (not the registry) so
    // concurrent runs with different node-level scopes don't fight over it.
    const nodeSkills = input.node.attrs.skills as string[] | undefined;
    const skillFilter: { skills?: readonly string[]; skills_disabled?: boolean } = {
      skills_disabled: input.node.attrs.skills_disabled === true,
    };
    if (nodeSkills !== undefined) skillFilter.skills = nodeSkills;
    const effectiveSkills = filterSkillsForNode(this.skills, skillFilter);
    const skillsCatalog = renderSkillsCatalog(effectiveSkills);
    const toolsIncludingSkill =
      effectiveSkills.length > 0 &&
      // Respect an explicit deny or a narrowing allow that omits load_skill.
      !(deny?.includes("local:load_skill") === true) &&
      !(allow && !allow.includes("local:load_skill"))
        ? [...selectedTools, buildLoadSkillTool(effectiveSkills)]
        : selectedTools;
    const tools = toolsIncludingSkill.map((t) => toAgentTool(t, this.env));

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
    const storedForThread: AgentMessage[] = !isFresh && threadId ? this.messageStore.get(threadId) : [];
    const hydrateMessages: AgentMessage[] = hydrate && threadId ? storedForThread : [];

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
      ? async (type: EventType, data: Record<string, unknown>, node_id: string) => {
          await input.emitAt?.(type, data, node_id);
        }
      : undefined;
    const { seed, warnings: fidelityWarnings } = await buildFidelitySeed({
      fidelity: input.fidelity,
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
    const sessionId = resolveSessionId({ fidelity: input.fidelity, threadId, isFresh });

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
      // Prefer the real cumulative snapshot the executor just handed us.
      // Fall back to the Wave-1 placeholder shape only when no BudgetLedger
      // is wired (runs without any budget attrs configured).
      const budget = input.budget !== undefined ? toBudgetEventShape(input.budget) : captureBudget(input.node.attrs);
      if (budget) llmStart["budget"] = budget;
      await input.emit("llm.start", llmStart);
    }

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      const bridged = bridgeAgentEvent(event);
      if (bridged && input.emit) await input.emit(bridged.type, bridged.data);
      if (event.type === "message_end" && event.message.role === "assistant" && input.emit) {
        await input.emit("cost.recorded", costPayload(event.message as AssistantMessage));
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
    // with `condition="outcome=fail"` instead of forwarding the whole pipeline
    // through a no-op plan → implement → verify chain. We also flag it
    // `non_retryable` so the goal-gate retry machinery doesn't relaunch the
    // pipeline after an explicit stop.
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

/** Wave 1 budget snapshot: cumulative counters are placeholders (0) until
 * Wave 4 wires a BudgetLedger; the ceilings are populated opportunistically
 * when a workflow author sets them on the node. Returns `undefined` if
 * there is nothing useful to surface. */
function captureBudget(
  attrs: Record<string, unknown>,
): { cumulative_cost_usd: number; cumulative_tokens: number; max_cost_usd?: number } | undefined {
  const maxCost = typeof attrs["max_cost_usd"] === "number" ? attrs["max_cost_usd"] : undefined;
  // Wave 1 emits budget only when the author has actually set a ceiling,
  // otherwise the field is noise. Wave 4 stops using this fallback the
  // moment the executor hands us a `CodergenInput.budget` snapshot —
  // real cumulative values replace these zeros.
  if (maxCost === undefined) return undefined;
  return { cumulative_cost_usd: 0, cumulative_tokens: 0, max_cost_usd: maxCost };
}

/** Build a failure reason for the non_retryable fail returned when
 * `input.budget_stopped` is set by the executor. Stable across sites. */
function budgetStopReason(budget: CodergenInput["budget"]): string {
  if (!budget) return "budget ceiling exceeded";
  const parts: string[] = [];
  if (typeof budget.max_cost_usd === "number") parts.push(`node max_cost_usd=${budget.max_cost_usd}`);
  if (typeof budget.run_max_cost_usd === "number") parts.push(`run budget_usd=${budget.run_max_cost_usd}`);
  const cap = parts.length > 0 ? ` (${parts.join(" · ")})` : "";
  return `budget ceiling exceeded — cumulative $${budget.cumulative_cost_usd.toFixed(6)} / ${budget.cumulative_tokens} tokens${cap}`;
}

/** Reshape the executor-supplied BudgetQuery into the LlmStartData.budget
 * event shape. Close but not identical — the event shape omits the
 * per-node cumulative breakdown (BudgetLedger.snapshot carries that
 * separately for server-side consumers). */
function toBudgetEventShape(q: NonNullable<CodergenInput["budget"]>): {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  max_cost_usd?: number;
  run_max_cost_usd?: number;
} {
  const out: {
    cumulative_cost_usd: number;
    cumulative_tokens: number;
    max_cost_usd?: number;
    run_max_cost_usd?: number;
  } = {
    cumulative_cost_usd: q.cumulative_cost_usd,
    cumulative_tokens: q.cumulative_tokens,
  };
  if (typeof q.max_cost_usd === "number") out.max_cost_usd = q.max_cost_usd;
  if (typeof q.run_max_cost_usd === "number") out.run_max_cost_usd = q.run_max_cost_usd;
  return out;
}
