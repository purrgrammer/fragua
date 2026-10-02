// PiLlmBackend — LlmBackend backed by pi-agent-core + pi-ai.

import { createHash } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import type {
  EventType,
  LlmBackend,
  LlmInput,
  Outcome,
  OutputsDecl,
  OutputsValue,
  SummariserBackend,
} from "@fragua/core";
import {
  ANTHROPIC_OVERLOADED_STATUS,
  byName,
  compileOutputsToTypeBox,
  fail,
  failHalt,
  failProvider,
  isAutoRetryableStatus,
  ok,
  validateOutputsValue,
} from "@fragua/core";
import { makeHttpClient } from "@fragua/core/handler";
import type { SteerDelivery } from "@fragua/types";
import type {
  AnyTool,
  ExecutionEnvironment,
  FraguaToolContext,
  McpConnector,
  Skill,
  ToolRegistry,
} from "@fragua/workspace";
import {
  filterCatalogueForRun,
  filterSkillsForNode,
  isMcpToolName,
  mcpToolPrefix,
  normalizeMcpToolRef,
  reanchorSkillsToRunTree,
  renderSkillsCatalog,
  sanitiseUnpairedToolCalls,
  toCatalogRecord,
} from "@fragua/workspace";
import { Type } from "@sinclair/typebox";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { MessageStore } from "./message-store.ts";
import { SteeringRegistry } from "./steering-registry.ts";
import { applyDefaultContextFiles, buildSystemPrompt, loadContextFiles, type RunEnvironment } from "./system-prompt.ts";
import { buildSummarySeed, resolveSessionId, shouldHydrateFromStore, shouldPersistToStore } from "./thread.ts";
import { toAgentTool } from "./tool-adapter.ts";

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

  /** Resolve the effective tool set (registry select + allowlist gates) and
   * force-include `abort`. Returns an early `outcome` for every misconfig gate,
   * or the gated tool set plus the MCP-servers metadata later phases need. */
  private selectAndGateTools(input: LlmInput):
    | { outcome: Outcome }
    | {
        finalTools: AnyTool[];
        declaredMcpServers: string[];
        mcpOnlyAllowlist: boolean;
        allow: string[] | undefined;
        deny: string[] | undefined;
      } {
    const selectOpts: { allow?: string[]; deny?: string[] } = {};
    const allow = input.node.attrs.allowed_tools as string[] | undefined;
    const deny = input.node.attrs.denied_tools as string[] | undefined;
    if (allow) selectOpts.allow = allow;
    if (deny) selectOpts.deny = deny;
    const selectedTools = this.registry.select(selectOpts);
    // Fail loudly when the node asked for tools but the registry produced
    // none. Silent empty-tools is the worst kind of misconfig — the model
    // happily generates `<tool_call>` XML as plain text and the run looks
    // like it succeeded while nothing actually ran. Caller should populate
    // the registry (e.g. `registry.registerAll(CORE_TOOLS)`) before
    // constructing the backend. Gated on `selectedTools` (not the
    // post-skill-merge `finalTools` below) so the diagnostic still fires
    // when the registry is genuinely empty — a registry that holds only
    // the force-included `skill` is still misconfigured.
    // An `mcp__<srv>__*` allow entry names a tool materialised later (additive,
    // per mcp-servers), not a registry tool — exclude it from the gate ONLY when
    // its server is declared in `mcp-servers` (so it can actually resolve). An
    // `mcp__*` entry for an undeclared server, or with no `mcp-servers:` at all,
    // can never resolve and must still trip the gate.
    const declaredMcpServers = (input.node.attrs.mcp_servers as string[] | undefined) ?? [];
    const mcpPrefixes = declaredMcpServers.map((s) => mcpToolPrefix(s));
    const willMaterialise = (name: string): boolean =>
      isMcpToolName(name) && mcpPrefixes.some((p) => normalizeMcpToolRef(name).startsWith(p));
    const gateAllow = allow?.filter((a) => !willMaterialise(a));
    // An `mcp__*` allow entry lands in `gateAllow` only when its server ISN'T in
    // `mcp-servers:` (a declared server's tools are exempted via `willMaterialise`),
    // so it can NEVER resolve. Trip on that regardless of whether a core tool was
    // also selected — otherwise `['read', 'mcp__missing__x']` would silently run
    // with just `read`, dropping the typo'd MCP entry with no signal.
    const mcpUndeclared = gateAllow?.filter((a) => isMcpToolName(a)) ?? [];
    if (mcpUndeclared.length > 0) {
      return {
        outcome: fail(
          `allowed_tools names MCP tools [${mcpUndeclared.join(", ")}] whose server is not listed in mcp-servers: — add the server to mcp-servers, or fix the tool name.`,
          { non_retryable: true },
        ),
      };
    }
    if (gateAllow && gateAllow.length > 0 && selectedTools.length === 0) {
      // The offending entries are `gateAllow`, not the whole `allow` list.
      const registered = this.registry.list().map((t) => t.name);
      return {
        outcome: fail(
          `allowed_tools=[${gateAllow.join(", ")}] requested but none matched the backend registry (registered: [${registered.join(", ")}]). ` +
            "The registry must be populated before backend.run() — call `registry.registerAll(CORE_TOOLS)` at daemon setup.",
        ),
      };
    }
    // `allowed_tools` names ONLY `mcp__*` tools and no core tool was selected — so
    // the step's entire toolset hinges on MCP materialisation. Used by two gates
    // below (no connector wired vs connector present but nothing materialised).
    const mcpOnlyAllowlist =
      allow !== undefined && allow.length > 0 && allow.every(isMcpToolName) && selectedTools.length === 0;
    // `willMaterialise` exempts `mcp__*` allow entries from the gate above so it
    // doesn't fire before materialisation — but with no connector wired they can
    // NEVER materialise, and the post-materialisation re-check below lives inside
    // the connector-guarded block, so an mcp-only allowlist would slip through to
    // a tool-less run. Catch that here. (A connector-present-but-servers-fail case
    // is caught after materialise; a connector present with no `mcp-servers:` makes
    // `willMaterialise` false, so the standard gate above already fires.)
    if (!this.mcpConnector && mcpOnlyAllowlist) {
      return {
        outcome: fail(
          `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but no MCP connector is configured to materialise them.`,
          { non_retryable: true },
        ),
      };
    }
    // Force-include the built-in `abort` tool. Even when the node pins
    // `allowed_tools` (excluding it) or lists it under `denied_tools`, it
    // must remain available — a universal affordance. Skipped only when the
    // registry doesn't carry it (tests with a hand-rolled registry).
    const abortTool = this.registry.get("abort");
    let finalTools = selectedTools;
    if (abortTool && !finalTools.some((t) => t.name === "abort")) finalTools = [...finalTools, abortTool];
    return { finalTools, declaredMcpServers, mcpOnlyAllowlist, allow, deny };
  }

  /** Resolve the run's execution env and slice the skill catalogue down to what
   * this run + node can see. Returns an early `outcome` when no env is wired. */
  private resolveEnvAndSkills(input: LlmInput):
    | { outcome: Outcome }
    | {
        effectiveEnv: ExecutionEnvironment;
        effectiveSkills: readonly Skill[];
        skillsCatalog: string;
        runProjectCwd: string;
      } {
    // Prefer per-call env (wired via HandlerContext → LlmInput by the executor
    // when a WorktreeProvisioner is active). Falls back to the construction-time
    // env for tests + callers that still pass a shared LocalEnvironment.
    const effectiveEnv = input.env ?? this.env;
    if (!effectiveEnv) {
      return {
        outcome: fail(
          "PiLlmBackend: no execution environment available — configure `env` on backendOpts or wire a WorktreeProvisioner on the daemon",
        ),
      };
    }
    // Slice the discovery superset down to what this run can see: user-scope
    // records plus project-scope records whose `project_cwd` matches
    // `env.projectCwd()`, project-scope shadowing user-scope by name.
    const runProjectCwd = effectiveEnv.projectCwd();
    const runCwdSkills = reanchorSkillsToRunTree(
      filterCatalogueForRun(this.skills, runProjectCwd),
      runProjectCwd,
      effectiveEnv.cwd(),
    );
    const nodeSkills = input.node.attrs.skills as string[] | undefined;
    const skillFilter: { skills?: readonly string[]; skills_disabled?: boolean } = {};
    if (nodeSkills !== undefined) skillFilter.skills = nodeSkills;
    if (input.node.attrs.skills_disabled === true) skillFilter.skills_disabled = true;
    const effectiveSkills = filterSkillsForNode(runCwdSkills, skillFilter);
    const skillsCatalog = renderSkillsCatalog(effectiveSkills);
    return { effectiveEnv, effectiveSkills, skillsCatalog, runProjectCwd };
  }

  /** Materialise MCP-server tools for the node and merge them into `finalTools`,
   * subject to `denied_tools` / an mcp-only `allowed_tools`. Registers teardown
   * on `disposers`. Returns an early `outcome` when an mcp-only allowlist
   * materialised nothing. A no-connector / no-servers node is a pass-through. */
  private async materializeMcpTools(args: {
    input: LlmInput;
    finalTools: AnyTool[];
    declaredMcpServers: string[];
    mcpOnlyAllowlist: boolean;
    allow: string[] | undefined;
    runProjectCwd: string;
    disposers: Array<() => Promise<void>>;
  }): Promise<{ outcome: Outcome } | { finalTools: AnyTool[] }> {
    const { input, declaredMcpServers, mcpOnlyAllowlist, allow, runProjectCwd, disposers } = args;
    let finalTools = args.finalTools;
    if (!this.mcpConnector || declaredMcpServers.length === 0) return { finalTools };
    const materializeOpts: Parameters<McpConnector["materialize"]>[1] = { cwd: runProjectCwd };
    if (input.signal) materializeOpts.signal = input.signal;
    const toolset = await this.mcpConnector.materialize(declaredMcpServers, materializeOpts);
    disposers.push(() => toolset.dispose());
    const denied = new Set((input.node.attrs.denied_tools as string[] | undefined)?.map(normalizeMcpToolRef) ?? []);
    const mcpAllow = allow?.filter((a) => isMcpToolName(a)).map(normalizeMcpToolRef);
    const mcpAllowSet = mcpAllow && mcpAllow.length > 0 ? new Set(mcpAllow) : undefined;
    const mcpTools = toolset.tools.filter(
      (t) => !denied.has(t.name) && (mcpAllowSet === undefined || mcpAllowSet.has(t.name)),
    );
    finalTools = [...finalTools, ...mcpTools];
    if (input.emit) {
      for (const e of toolset.errors) {
        // A collision means the server IS live (its other tools materialised) —
        // don't word it as "skipped", which sends operators to debug connectivity.
        const message =
          e.kind === "collision"
            ? `mcp tool from "${e.server}" dropped: ${e.message}`
            : `mcp server "${e.server}" skipped: ${e.message}`;
        await input.emit("agent.warning", { message });
      }
      if (mcpTools.length > 0) {
        await input.emit("agent.info", {
          message: `mcp: ${mcpTools.length} tool(s) from [${declaredMcpServers.join(", ")}]`,
        });
      }
    }
    // Re-check the empty-tools gate now that materialisation has run: an
    // mcp-only allowlist that resolved nothing would run tool-less but
    // "successful" — the silent-empty-tools footgun. Fail loudly instead.
    if (mcpOnlyAllowlist && mcpTools.length === 0) {
      const available = toolset.tools.map((t) => t.name);
      return {
        outcome: fail(
          available.length > 0
            ? `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but none match the tools materialised from [${declaredMcpServers.join(", ")}] — available: [${available.join(", ")}]. Check the tool names.`
            : `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but none materialised from mcp-servers [${declaredMcpServers.join(", ")}] — check .mcp.json server credentials and connectivity.`,
          { non_retryable: true },
        ),
      };
    }
    return { finalTools };
  }

  /** Build the pi-agent tool array from the resolved `finalTools`: attach the
   * per-run fragua context, then append the single terminating exit tool
   * (`route` XOR `emit_output`), then canonicalise order for cache stability. */
  private assembleAgentTools(args: {
    input: LlmInput;
    finalTools: AnyTool[];
    effectiveEnv: ExecutionEnvironment;
    nodeRoutes: string[] | undefined;
    outputsDecl: OutputsDecl | undefined;
  }): { tools: AgentTool[]; fraguaContext: FraguaToolContext & { skillCatalog?: readonly Skill[] } } {
    const { input, finalTools, effectiveEnv, nodeRoutes, outputsDecl } = args;
    // Per-run fragua context. `skillCatalog` is patched in after the system
    // prompt resolves; tools captured by `toAgentTool` close over this same
    // object reference, so the later patch is visible to every tool call.
    const fraguaEmit = input.emit;
    const fraguaContext: FraguaToolContext & { skillCatalog?: readonly Skill[] } = {
      runId: input.run_id,
      nodeId: input.node.id,
      iteration: input.iteration?.n ?? 0,
      http: makeHttpClient({ signal: input.signal }),
      emit: fraguaEmit
        ? (type, payload) => {
            void fraguaEmit(type as EventType, payload);
          }
        : () => {},
      ...(input.judge !== undefined ? { judge: input.judge } : {}),
    };
    const tools: AgentTool[] = finalTools.map((t) => toAgentTool(t, effectiveEnv, fraguaContext));
    // Exit-tool synthesis — a node exits via exactly ONE terminating tool:
    // routes → the ephemeral per-call `route` enum, outputs → `emit_output`,
    // neither → the loop ends when the agent stops emitting calls. Mutually
    // exclusive (parser-enforced); force-included regardless of allow/deny.
    const hasRoutes = Array.isArray(nodeRoutes) && nodeRoutes.length > 0;
    if (hasRoutes) {
      tools.push(buildRouteTool(nodeRoutes as string[]));
    } else if (outputsDecl !== undefined) {
      tools.push(buildEmitOutputTool(outputsDecl));
    }
    // Canonical tool order: definitions head the provider's prompt-cache prefix,
    // so sorting by name makes the segment a pure function of the effective tool
    // SET regardless of how the tools were assembled.
    tools.sort(byName);
    return { tools, fraguaContext };
  }

  /** Load context files, build the per-call system prompt, and expose the run's
   * skill catalogue on `fraguaContext` for the `skill` tool's name lookup. */
  private async buildSystemPromptForCall(args: {
    input: LlmInput;
    effectiveEnv: ExecutionEnvironment;
    skillsCatalog: string;
    effectiveSkills: readonly Skill[];
    fraguaContext: { skillCatalog?: readonly Skill[] };
  }): Promise<{ systemPrompt: string; contextFileRecords: Awaited<ReturnType<typeof loadContextFiles>>["files"] }> {
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
    // `<environment>` block; the construction-time `this.runEnv` is only a
    // fallback for the bootstrap line.
    const derivedRunEnv = deriveRunEnv(effectiveEnv);
    const mergedBootstrap = derivedRunEnv.bootstrapCommand ?? this.runEnv?.bootstrapCommand;
    const effectiveRunEnv: RunEnvironment = mergedBootstrap !== undefined ? { bootstrapCommand: mergedBootstrap } : {};
    const systemPrompt = buildSystemPrompt({
      global: this.systemPrompt,
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
  private async hydrateThreadMessages(args: {
    input: LlmInput;
    effectiveEnv: ExecutionEnvironment;
    fraguaContext: FraguaToolContext;
  }): Promise<{
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
      ? (externalPrior ?? this.messageStore.get(input.run_id, threadId))
      : [];
    if (externalPrior !== undefined && threadId) {
      this.messageStore.set(input.run_id, threadId, storedForThread);
    }
    // Resume detection — purely observational; hydration is byte-identical
    // across restarts, so this only lets us log a rehydrate marker.
    const resumed =
      threadId != null &&
      externalPrior !== undefined &&
      storedForThread.length > 0 &&
      !this.inProcessWrites.has(sessionKey(input.run_id, threadId));
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
        toolRegistry: this.registry,
        env: effectiveEnv,
        fraguaContext,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }
    return { hydrateMessages, storedForThread, threadId, persist };
  }

  /** Build the summary seed prepended to the user prompt when a node opted into
   * `summary=low|medium|high`; otherwise the prompt is unchanged. */
  private async buildEffectivePrompt(args: { input: LlmInput; storedForThread: AgentMessage[] }): Promise<string> {
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
      ...(this.summariser !== undefined ? { summariser: this.summariser } : {}),
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
  private async executePromptLoop(args: {
    agent: Agent;
    input: LlmInput;
    runId: string;
    effectivePrompt: string;
    hasRoutes: boolean;
    outputsDecl: OutputsDecl | undefined;
    hydratedCount: number;
    unsubscribe: () => void;
  }): Promise<void> {
    const { agent, input, runId, effectivePrompt, hasRoutes, outputsDecl, hydratedCount, unsubscribe } = args;
    // Register this agent as the run's steer target and drain any buffered steer.
    this.steering.beginRun(runId, agent, { nodeId: input.node.id, iteration: input.iteration?.n ?? 0 });
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
      this.steering.endRun(runId, agent);
      unsubscribe();
      if (input.signal) {
        input.signal.removeEventListener("abort", abortListener);
        // The `arm` once-listener never fires on a clean run — left registered it
        // pins this run scope to the signal's lifetime.
        if (armListener !== undefined) input.signal.removeEventListener("abort", armListener);
      }
    }
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

    const gated = this.selectAndGateTools(input);
    if ("outcome" in gated) return gated.outcome;
    const { declaredMcpServers, mcpOnlyAllowlist, allow, deny } = gated;
    let finalTools = gated.finalTools;

    const envSkills = this.resolveEnvAndSkills(input);
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

    const materialized = await this.materializeMcpTools({
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
    const { tools, fraguaContext } = this.assembleAgentTools({
      input,
      finalTools,
      effectiveEnv,
      nodeRoutes,
      outputsDecl,
    });

    const { systemPrompt, contextFileRecords } = await this.buildSystemPromptForCall({
      input,
      effectiveEnv,
      skillsCatalog,
      effectiveSkills,
      fraguaContext,
    });

    const { hydrateMessages, storedForThread, threadId, persist } = await this.hydrateThreadMessages({
      input,
      effectiveEnv,
      fraguaContext,
    });
    const effectivePrompt = await this.buildEffectivePrompt({ input, storedForThread });

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
    await this.executePromptLoop({
      agent,
      input,
      runId,
      effectivePrompt,
      hasRoutes,
      outputsDecl,
      hydratedCount,
      unsubscribe,
    });

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

/** Build the per-run agent-event subscriber: bridge each event to the fragua
 * event stream, record `cost.recorded` on assistant message ends, and persist
 * the fully-assembled AgentMessage to the messages table (skipping empty
 * error/abort failure envelopes, which would bloat the table on retry chains). */
function buildMessageSubscriber(input: LlmInput): (event: AgentEvent) => Promise<void> {
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
async function emitLlmStart(args: {
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

/** Classify the terminal assistant message into a resumable pause / hard fail,
 * or `null` to fall through to exit resolution. Handles no-response, provider
 * transport errors (4xx/5xx), signal-driven abort (rethrown as AbortError so the
 * executor's `wasAborted` path runs), a trailing abort tool call, unclassified
 * failure envelopes (fail open to a resumable pause), and empty responses. */
function classifyTerminalMessage(args: {
  messages: readonly AgentMessage[];
  provider: string;
  lastHttpStatus: number | null;
  lastRetryAfterMs: number | undefined;
  hydratedCount: number;
  signalAborted: boolean;
}): Outcome | null {
  const { messages, provider, lastHttpStatus, lastRetryAfterMs, hydratedCount, signalAborted } = args;
  const last = messages[messages.length - 1];
  if (!last) {
    // No messages at all is the strongest signal that the very first call failed
    // transport-level. Pause-not-halt so the run can resume after a fix.
    return failProvider("provider returned no response", {
      httpStatus: lastHttpStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }

  if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    if (last.stopReason === "error") {
      // pi-ai's `onResponse` only fires once a stream begins; a pre-stream reject
      // (e.g. Anthropic 400 on a malformed history) never invokes it, so recover
      // the status from the leading token of `errorMessage`.
      const extracted = effectiveProviderHttpStatus(
        lastHttpStatus ?? (last.errorMessage ? extractHttpStatusFromErrorMessage(last.errorMessage) : null),
        last.errorMessage,
      );
      const httpIs4xx5xx = extracted !== null && extracted >= 400 && extracted < 600;
      const noContent = !Array.isArray(last.content) || last.content.length === 0;
      if (httpIs4xx5xx || noContent) {
        return failProvider(last.errorMessage ?? `provider stream error (HTTP ${extracted ?? "n/a"})`, {
          httpStatus: extracted,
          provider,
          ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
        });
      }
    }
    // Signal-driven abort (operator pause/cancel, supervisor timeout, shutdown
    // drain): rethrow so the executor's `wasAborted` path emits
    // `fact.node_aborted` instead of halting with `aborted_exit`.
    if (last.stopReason === "aborted" && signalAborted) {
      const err = new Error(last.errorMessage ?? "stream aborted");
      err.name = "AbortError";
      throw err;
    }
    // A deliberate self-abort can leave a trailing error envelope; the abort
    // still wins over a provider pause.
    const abortedEarlier = findAbortToolCall(messages.slice(hydratedCount));
    if (abortedEarlier && !abortedEarlier.isolated) {
      return fail(nonIsolatedAbortReason(abortedEarlier.reason), { non_retryable: true });
    }
    if (abortedEarlier) {
      return fail(abortedEarlier.reason, { notes: summarizeMessage(last), non_retryable: true });
    }
    // Unclassified failure envelope: FAIL OPEN to a resumable pause rather than
    // route a transient transport failure into the no-fail-edge terminal halt.
    const unclassifiedStatus = effectiveProviderHttpStatus(
      lastHttpStatus ?? (last.errorMessage ? extractHttpStatusFromErrorMessage(last.errorMessage) : null),
      last.errorMessage,
    );
    return failProvider(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
      httpStatus: unclassifiedStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }

  // Empty assistant turn without an explicit error — the stream ended cleanly but
  // produced nothing (observed against real provider 402s). Pause-not-halt.
  if (last.role === "assistant" && (!Array.isArray(last.content) || last.content.length === 0)) {
    return failProvider("provider returned an empty response", {
      httpStatus: lastHttpStatus,
      provider,
      ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
    });
  }
  return null;
}

/** Resolve a clean-ended turn into its exit outcome: a self-abort (wins over
 * everything), a route pick (`routes:` nodes), an `emit_output` value
 * (`outputs:` nodes), or a plain `ok`. Each terminating tool must be called in
 * isolation (D3) — sharing its batch fails the node. */
/** The isolation breach is the failure, but the model's own reason is the
 * diagnostic an operator reads first — carry it along. */
function nonIsolatedAbortReason(reason: string): string {
  return `abort shared an assistant response with other tool calls — call it alone, with no other tools in the same turn (abort reason: ${reason})`;
}

function resolveExitOutcome(args: {
  messages: readonly AgentMessage[];
  hydratedCount: number;
  nodeRoutes: string[] | undefined;
  outputsDecl: OutputsDecl | undefined;
}): Outcome {
  const { messages, hydratedCount, nodeRoutes, outputsDecl } = args;
  const lastAssistant = lastAssistantMessage(messages);
  const notes = lastAssistant ? fullAssistantText(lastAssistant).slice(0, 4_000) : "";
  const aborted = findAbortToolCall(messages.slice(hydratedCount));
  // Isolation (mirrors the route / emit_output exits, D3).
  if (aborted && !aborted.isolated) return fail(nonIsolatedAbortReason(aborted.reason), { notes, non_retryable: true });
  if (aborted) return fail(aborted.reason, { notes, non_retryable: true });

  // Route-tool resolution — only when the node opted into `routes=`.
  if (Array.isArray(nodeRoutes) && nodeRoutes.length > 0) {
    const routeCall = findRouteToolCall(messages.slice(hydratedCount));
    if (routeCall == null) {
      return failHalt("route_not_picked", "agent ended turn without calling route()");
    }
    if (!routeCall.isolated) {
      return fail(
        "route() shared an assistant response with other tool calls — call it alone, with no other tools in the same turn",
        { non_retryable: true },
      );
    }
    return ok({ notes, route: routeCall.route });
  }

  // emit_output resolution for nodes that declare outputs: but no routes:.
  if (outputsDecl !== undefined) {
    const emitCall = findEmitOutputCall(messages.slice(hydratedCount));
    if (emitCall == null) {
      return fail("node declared outputs: but did not call emit_output", { non_retryable: true });
    }
    if (!emitCall.isolated) {
      return fail(
        "emit_output shared an assistant response with other tool calls — emit it alone, with no other tools in the same turn",
        { non_retryable: true },
      );
    }
    const valErr = validateOutputsValue(outputsDecl, emitCall.value);
    if (valErr !== null) {
      return fail(`emit_output value failed validation: ${valErr}`, { non_retryable: true });
    }
    return ok({ notes, outputs: emitCall.value as OutputsValue });
  }

  return ok({ notes });
}

/** Cooperative-unwind window between `input.signal` aborting and the
 *  wrapper synthesising an AbortError. Long enough for a well-behaved
 *  provider SDK to tear its socket down (existing cancel-signal test
 *  unwinds in ~50ms); short enough to stay well inside the executor's
 *  10s `LEAK_GRACE_MS`, so a wedged fetch lands as `fact.node_aborted`
 *  instead of `fact.handler_timeout_leaked`. */
const ABORT_TEARDOWN_GRACE_MS = 2_000;

// The Anthropic SDK's built-in retry honors `retry-after` /
// `retry-after-ms` / `anthropic-ratelimit-*` headers, so it is the
// correct layer to wait out a rate-limit window. fragua's own engine-
// retry (PROVIDER_RETRY_MAX_ATTEMPTS = 5) is header-blind for
// pre-stream 429s and remains the backstop when the SDK also exhausts.
const PROVIDER_SDK_MAX_RETRIES = 8;
// Cap the per-attempt SDK wait so a single very-long `retry-after`
// cannot hang a step indefinitely.
const PROVIDER_SDK_MAX_RETRY_DELAY_MS = 60_000;

function sessionKey(runId: string, threadId: string): string {
  return `${runId}::${threadId}`;
}

/** Parse `Retry-After` from a response-headers map. RFC 7231 allows two
 * formats: integer seconds OR an HTTP-date. We honour seconds (the
 * common provider convention) and ignore HTTP-date (rare in LLM APIs).
 * Returns `undefined` when absent or malformed so the daemon falls back
 * to its equal-jitter exponential schedule. */
function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  // Header names are case-insensitive per RFC 9110; pi-ai surfaces them
  // verbatim. Probe the common spellings first, then fall back to a
  // case-insensitive scan so a provider that capitalises differently
  // still works.
  const direct = headers["retry-after"] ?? headers["Retry-After"] ?? headers["RETRY-AFTER"];
  let raw = direct;
  if (raw === undefined) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === "retry-after") {
        raw = v;
        break;
      }
    }
  }
  if (raw === undefined) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds * 1000);
}

/** Extract a leading HTTP status code from a pi-ai error message.
 *
 * pi-ai's stream surfaces a provider transport rejection (e.g. an
 * Anthropic 400 `invalid_request_error`) as a `stopReason="error"`
 * AssistantMessage whose `errorMessage` starts with the bare HTTP
 * status followed by the JSON body — for example:
 *
 *   `400 {"type":"error","error":{"type":"invalid_request_error",...}}`
 *
 * The response-header capture (`onResponse`) does not fire for this
 * class — pi-ai rejects pre-stream, so `lastHttpStatus` stays `null`
 * and the `pause_provider` outcome reaches the daemon without a
 * status. The provider-retry classifier then treats `null` as a
 * pre-response network failure (auto-retryable) and burns the full
 * chain budget against a deterministically-failing request before
 * halting with `provider_exhausted`, instead of pausing immediately
 * as `provider_error` for the operator.
 *
 * Recognise a 1xx–5xx leading token (whitespace-bounded) and return
 * it; otherwise return `null`. Conservative on purpose — a bare
 * 3-digit number inside the body must not be confused with a status
 * code. */
export function extractHttpStatusFromErrorMessage(message: string): number | null {
  if (typeof message !== "string" || message.length === 0) return null;
  const match = /^(\d{3})(?:\s|$)/.exec(message);
  if (!match) return null;
  const status = Number(match[1]);
  if (!Number.isFinite(status) || status < 100 || status > 599) return null;
  return status;
}

/** Re-exported from `@fragua/core` so existing `@fragua/agent` importers
 * keep their import site. The single source of truth is core. */
export { ANTHROPIC_OVERLOADED_STATUS };

/** Detect an Anthropic `overloaded_error` envelope.
 *
 * Anthropic's overload can arrive mid-stream: the HTTP response already
 * returned 200 (so `onResponse` captures `lastHttpStatus = 200`) and the
 * overload then surfaces as an `error` event in the stream body whose
 * envelope is `{"type":"error","error":{"type":"overloaded_error",...}}`.
 * The `error.type` is the signal — the captured status (200) is not.
 *
 * Anchored on the envelope STRUCTURE, not a bare substring: a coincidental
 * `"type":"overloaded_error"` embedded in some other error body (an echoed
 * prior error, an upstream log) must not upgrade a manual-class failure to
 * auto-retry and burn the retry budget. So we parse and require top-level
 * `type:"error"` AND inner `error.type:"overloaded_error"`. The envelope may
 * be prefixed by a bare HTTP status (the `extractHttpStatusFromErrorMessage`
 * shape), so we parse from the first brace; a non-JSON / mismatched body
 * fails closed to `false` (manual classification, the conservative default). */
export function isOverloadedErrorMessage(message: string | undefined | null): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const brace = message.indexOf("{");
  if (brace === -1) return false;
  try {
    const parsed = JSON.parse(message.slice(brace)) as { type?: unknown; error?: { type?: unknown } };
    return parsed?.type === "error" && parsed?.error?.type === "overloaded_error";
  } catch {
    return false;
  }
}

/** Canonical auto-retryable status for a recognised transient transport
 * failure (408 Request Timeout). The provider-retry classifier already
 * treats 408 as auto-retryable. */
export const TRANSIENT_TRANSPORT_STATUS = 408;

/** A conservative, explicit set of known-transient transport-failure
 * signatures. These are bare `Error.message` strings (no JSON envelope to
 * anchor on), so we match case-insensitive substrings — but kept TIGHT and
 * specific: the failure mode this guards is a permanent error that
 * coincidentally contains a transient word, which would burn the retry
 * budget. A genuinely unknown message must NOT match (it fails open to a
 * manual, resumable pause). Grounded in what the Anthropic/OpenAI SDKs and
 * the underlying node networking stack surface. */
const TRANSIENT_TRANSPORT_SIGNATURES = [
  // request / operation timeouts. Specific phrases only — a bare
  // "timeout" matches permanent failures ("TLS handshake timeout",
  // "auth token timeout expired") and would burn the retry budget.
  "operation timed out",
  "request timed out",
  "etimedout",
  // connection drops / resets. A bare "network" matched permanent
  // failures ("network access blocked", "invalid network credentials")
  // — keep the specific "network error" phrase. ECONNREFUSED is dropped:
  // a refused connection is typically a permanent wrong-port / removed-
  // service / ACL condition, and the null-status pre-stream case is
  // already covered by `isAutoRetryableStatus(null)`.
  "socket hang up",
  "econnreset",
  "epipe",
  "network error",
  // A bare "connection error" is dropped: it matches PERMANENT failures
  // arriving mid-stream — "SSL connection error", "Proxy connection error:
  // 407", and the Anthropic SDK's APIConnectionError wrapper "Connection
  // error." over ECONNREFUSED (which must NOT auto-retry). The specific
  // "connection reset" phrase below covers the genuinely-transient drop.
  "connection reset",
] as const;

/** Detect a transient transport failure from a bare error message.
 *
 * A request/operation timeout or a dropped/reset connection can arrive
 * MID-STREAM: the HTTP response already returned 200 (so `onResponse`
 * captured `lastHttpStatus = 200`) and the transport then died. The
 * status-only classifier would route that captured 200 to a manual pause;
 * a timeout is transient and auto-retryable, so we normalise it instead.
 *
 * Only the explicitly-listed signatures match — an unknown message
 * (e.g. "An unknown error occurred") returns `false` and stays manual. */
export function isTransientTransportErrorMessage(message: string | undefined | null): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  const lower = message.toLowerCase();
  return TRANSIENT_TRANSPORT_SIGNATURES.some((sig) => lower.includes(sig));
}

/** Effective HTTP status for the `pause_provider` outcome.
 *
 * An `overloaded_error` envelope normalises to the canonical 529 regardless
 * of the captured status (mid-stream overload returns 200), so the
 * status-only provider-retry classifier auto-retries it. A recognised
 * transient transport failure (timeout / connection drop) likewise
 * normalises to the auto-retryable 408 when the captured status is not
 * already auto-retryable. Otherwise the captured/extracted status passes
 * through unchanged — an unknown error keeps its captured status and stays
 * manual (the conservative, fail-open-to-resumable default). */
export function effectiveProviderHttpStatus(
  httpStatus: number | null,
  errorMessage: string | undefined | null,
): number | null {
  if (isOverloadedErrorMessage(errorMessage)) return ANTHROPIC_OVERLOADED_STATUS;
  // Already auto-retryable (null / 408 / 429 / 500–504 / 529) — leave as-is.
  if (isAutoRetryableStatus(httpStatus)) return httpStatus;
  // Any non-auto-retryable status ≥ 400 is a definitive provider rejection
  // carrying its own error envelope — keep its manual classification even
  // if the message coincidentally contains a transient-looking word. This
  // covers explicit 4xx AND the non-auto-retryable 5xx codes (505–528,
  // 530–599), matching the daemon's manual-pause classification. The
  // transient path only rescues the MID-STREAM shape (captured 2xx/3xx)
  // where the transport died after the response began. Auto-retryable
  // statuses already returned at the guard above, so a bare `>= 400`
  // here is necessarily non-auto-retryable.
  if (httpStatus !== null && httpStatus >= 400) return httpStatus;
  if (isTransientTransportErrorMessage(errorMessage)) return TRANSIENT_TRANSPORT_STATUS;
  return httpStatus;
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

/** Pure resume-decision helper, extracted for unit testability.
/** Inlined into PiLlmBackend.run; kept as a no-op export for the
 * handful of callers that imported it for type only. Pre-release; will
 * be removed once those callers are updated. */

function summarizeMessage(message: { role: string; content?: unknown }): string {
  return fullAssistantText(message).slice(0, 4_000);
}

/** Concatenate every text block in an assistant message. Caller clips for
 *  storage. */
function fullAssistantText(message: { role: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** The last `assistant`-role message in the transcript, or `undefined`.
 *  The agent loop can end on a `toolResult` message — the `abort` tool
 *  sets `terminate: true`, so its result lands after the assistant turn
 *  that called it — but `notes` must still come from assistant text. */
function lastAssistantMessage(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { role: string; content?: unknown } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") return m;
  }
  return undefined;
}

/**
 * Scan the transcript for a call to the built-in `abort` tool. The agent
 * signals "I cannot proceed" by calling `abort({ reason })`; the tool sets
 * `terminate: true` so the loop stops after its batch. The contract is
 * taught by the tool's own description and documented in
 * `docs/handler-contract.md` § "Llm self-abort".
 *
 * Walks the whole message array — not just the last message — so the abort
 * still wins when it was emitted alongside other tool calls in a
 * non-terminating batch (the loop ran one more turn but the call is still
 * in the transcript). First `abort` call wins.
 *
 * The reason is trimmed and clamped so it can be surfaced as a
 * `failure_reason` without dragging in kilobytes of reasoning. Returns
 * `null` when no `abort` call is present.
 *
 * Exported so tests can rely on the exact contract without reimplementing
 * the scan.
 */
export function findAbortToolCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { reason: string; isolated: boolean } | null {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
    let abortBlock: { arguments?: Record<string, unknown> } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "abort" && abortBlock === undefined) {
        abortBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (abortBlock === undefined) continue;
    const rawReason = typeof abortBlock.arguments?.["reason"] === "string" ? abortBlock.arguments["reason"] : "";
    const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, 400);
    return { reason: reason.length > 0 ? reason : "agent aborted without a reason", isolated: otherToolCalls === 0 };
  }
  return null;
}

/**
 * Scan the transcript for a call to the synthesised `route` tool.
 * The tool only exists for the lifetime of one llm call — see
 * `buildRouteTool` — and its sole effect is to terminate the agent
 * loop. The chosen route is recovered here from the assistant's
 * tool-call block.
 *
 * Returns `{ route, isolated }`:
 *  - `route`: the `name` argument from the first `route` tool-call block.
 *  - `isolated`: false when the assistant message containing the `route`
 *    call also contains any other `toolCall` block (any tool name). The
 *    isolation rule (D3) prevents side effects from sharing a response
 *    with the route exit — the model must commit to the route on a
 *    response of its own.
 *
 * **Last** `route` call wins. The transcript includes prior thread
 * history (shared `thread_id=` nodes pass their messages through), so
 * a forward scan would surface an UPSTREAM routing node's `route` call
 * instead of the one the current node just made — exactly what
 * happened in run `01ks012pq5jb5jyb0d` where `needs_human` correctly
 * called `route({name:"yes"})` but the scan returned triage's earlier
 * `route({name:"feature"})`. Iterating from the end recovers the
 * current node's choice; the `terminate: true` on the tool means the
 * current loop only emits one route call, so "last in transcript" is
 * always "this node's".
 *
 * Exported so tests can rely on the exact contract without
 * reimplementing the scan.
 */
export function findRouteToolCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { route: string; isolated: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
    let routeBlock: { name?: string; arguments?: Record<string, unknown> } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "route" && routeBlock === undefined) {
        routeBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (routeBlock === undefined) continue;
    const raw = typeof routeBlock.arguments?.["name"] === "string" ? routeBlock.arguments["name"] : "";
    const route = raw.trim();
    return { route, isolated: otherToolCalls === 0 };
  }
  return null;
}

/** Corrective nudge replayed once when an outputs node ends its turn without
 * calling `emit_output` (see the in-loop re-prompt in `run`). */
const EMIT_OUTPUT_REMINDER =
  "You ended your turn without calling `emit_output`, so this step is not complete. " +
  "Call `emit_output` exactly once now, on its own (no other tool calls in the same response), " +
  "with every declared output field present and correctly typed.";

/**
 * Build the `emit_output` tool for a node that declares `outputs:` but does NOT
 * route (a routing node carries its outputs on the `route` call instead).
 * Force-included (like `route`); one call closes the turn (`terminate: true`).
 * The schema is compiled from the node's `OutputsDecl` via `compileOutputsToTypeBox`.
 */
function buildEmitOutputTool(decl: OutputsDecl): AgentTool {
  const parameters = compileOutputsToTypeBox(decl);
  return {
    name: "emit_output",
    label: "emit_output",
    description:
      "Emit the structured output for this step. Call exactly once when you have produced all declared output fields. " +
      "All declared fields must be present with their correct types. This call closes the turn — call it alone, " +
      "with no other tool calls in the same response (do all other work in earlier turns first).",
    parameters,
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `emit_output called` }],
        details: { fragua_tool: "emit_output", is_error: false, data: params },
        terminate: true,
      };
    },
  };
}

/**
 * Scan the transcript for the last `emit_output` tool call.
 * Returns `{ value, isolated }`:
 *  - `value`: the raw arguments object from the `emit_output` block.
 *  - `isolated`: false when the assistant message containing the call also
 *    contains any other `toolCall` block. emit_output terminates the turn, so a
 *    tool sharing its batch runs but its result is discarded — the same D3
 *    isolation rule the `route` exit enforces (see `findRouteToolCall`).
 * Last call wins (like `findRouteToolCall`) to handle thread rehydration.
 */
export function findEmitOutputCall(
  messages: ReadonlyArray<{ role: string; content?: unknown }>,
): { value: unknown; isolated: boolean } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: unknown }>;
    let emitBlock: { arguments?: unknown } | undefined;
    let otherToolCalls = 0;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      if (block.name === "emit_output" && emitBlock === undefined) {
        emitBlock = block;
        continue;
      }
      otherToolCalls += 1;
    }
    if (emitBlock === undefined) continue;
    return { value: emitBlock.arguments, isolated: otherToolCalls === 0 };
  }
  return null;
}

/**
 * Build the ephemeral `route` tool for one routing-node invocation.
 * Inline (not a static module): the enum is materialised from the
 * node's `routes=` attribute on every call. `terminate: true` ends
 * the agent loop after the call batch — same loop-stop mechanism as
 * the `abort` tool. The chosen route is recovered from the transcript
 * by `findRouteToolCall`; the tool's execute() output exists only to
 * satisfy pi-agent-core's tool-result contract.
 */
function buildRouteTool(routes: readonly string[]): AgentTool {
  // Use a plain JSONSchema `enum` (via Type.Unsafe) rather than
  // `Type.Union(Type.Literal(...))`. The Union form lowers to
  // `anyOf: [{const: "yes"}, {const: "no"}]` which Anthropic's
  // tool-use validator does not enforce — off-list `name` values
  // reach the handler. A bare `{type:"string", enum:[...]}` is
  // enforced at the provider layer, so a wayward
  // `route({name:"feature"})` is rejected before it ever lands.
  const nameSchema = Type.Unsafe<string>({ type: "string", enum: [...routes] });
  const parameters = Type.Object({ name: nameSchema }, { additionalProperties: false });
  return {
    name: "route",
    label: "route",
    description:
      "Exit this node with the chosen route. Call exactly once when decided. Call this alone in the response; do not pair it with other tool calls.",
    parameters,
    async execute(_toolCallId, params) {
      const chosen = (params as { name: string }).name;
      return {
        content: [{ type: "text", text: `route: ${chosen}` }],
        details: { fragua_tool: "route", is_error: false, data: { route: chosen } },
        terminate: true,
      };
    },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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
