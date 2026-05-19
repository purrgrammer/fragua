// PiCodergenBackend — CodergenBackend backed by pi-agent-core + pi-ai.

import { createHash } from "node:crypto";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { CodergenBackend, CodergenInput, EventType, FidelityMode, Outcome, SummariserBackend } from "@swarm/core";
import { fail, failHalt, failProvider, ok } from "@swarm/core";
import { makeHttpClient } from "@swarm/core/handler";
import type {
  AgentDefinition,
  ExecutionEnvironment,
  Skill,
  SubagentResult,
  SubagentSpec,
  SwarmToolContext,
  ToolRegistry,
} from "@swarm/workspace";
import {
  filterAgentsCatalogueForRun,
  filterCatalogueForRun,
  filterSkillsForNode,
  renderAgentsCatalog,
  renderSkillsCatalog,
  sanitiseUnpairedToolCalls,
  toCatalogRecord,
} from "@swarm/workspace";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { buildFidelitySeed, resolveSessionId, shouldHydrateFromStore, shouldPersistToStore } from "./fidelity.ts";
import { MessageStore } from "./message-store.ts";
import { SteeringRegistry } from "./steering-registry.ts";
import { applyDefaultContextFiles, buildSystemPrompt, loadContextFiles, type RunEnvironment } from "./system-prompt.ts";
import { toAgentTool } from "./tool-adapter.ts";

export interface PiCodergenBackendOptions {
  registry: ToolRegistry;
  /** Default shell/filesystem environment. Used when `CodergenInput.env`
   * is unset (tests, bare LocalEnvironment daemons). Production daemons
   * with a WorktreeProvisioner wire a per-run env via `CodergenInput`
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
  /** Per-run isolation facts — worktree path, run id, bootstrap command.
   * When provided, the backend prepends an `<environment>` block to
   * every node's system prompt so agents know where they are and which
   * dependencies are installed. Omit for bare LocalEnvironment runs
   * that don't need the preamble. */
  runEnv?: RunEnvironment;
  /** Shared "threads we've written to" registry, keyed by `runId::threadId`.
   * Each codergen node builds its own `PiCodergenBackend` (see
   * `packages/cli/src/commands/daemon.ts`), so a per-instance Set can't
   * tell "same daemon, different node on the shared thread" from
   * "different daemon after a restart". Pass a daemon-scoped Set here so
   * all backends share the signal. The daemon seeds it at boot from
   * `store.listThreadsWithMessages()` so a post-restart dispatch on a
   * pre-existing thread still finds its key present. Omit in
   * tests/one-shots to get the per-instance behaviour. */
  inProcessWrites?: Set<string>;
  /** Shared per-run live-agent + steer-buffer registry. Each codergen
   * node builds its own `PiCodergenBackend`, so a per-instance registry
   * can't deliver a steer issued during node A to node B's agent on the
   * same run. Pass one daemon-scoped registry here and supervisor's
   * `onSteer` writes through to it; every backend that runs a node for
   * the same `runId` finds the live-agent slot it expects. Omit in
   * tests/one-shots that don't need cross-backend steering. */
  steering?: SteeringRegistry;
  /** Factory that builds a per-call sub-agent spawner for the `agent`
   * tool. Called once per `backend.run()` with the parent's resolved
   * persona + skills + pool, and returns the `spawnSubagent` closure
   * that lands on `swarmContext.spawnSubagent`. The daemon wires this
   * to its store + tool registry; tests / one-shots can omit it (the
   * tool then surfaces `is_error` to the LLM rather than silently
   * stalling). */
  spawnSubagentFactory?: (parentCtx: SpawnSubagentParentCtx) => (spec: SubagentSpec) => Promise<SubagentResult>;
  /** Named sub-agent profiles discovered by the CLI at startup (see
   * `@swarm/workspace`'s `discoverAgents`). When the run's tool pool
   * includes the `agent` tool and this list is non-empty, the backend
   * appends an `## Available sub-agents` catalogue block to the
   * system prompt and exposes the catalogue on
   * `swarmContext.agentCatalog` so the `agent` tool can resolve
   * `agent: <name>` calls. */
  agentDefinitions?: readonly AgentDefinition[];
}

/** Parent-context snapshot the spawn factory needs to materialise a
 *  child run. Captured per `backend.run()` and frozen — the same
 *  closure runs against every `agent` tool call inside that turn.
 *  Field names mirror the daemon's `SpawnSubagentParentCtx` so the
 *  factory wired by the CLI can forward this object verbatim. */
export interface SpawnSubagentParentCtx {
  parentRunId: string;
  parentNodeId: string;
  parentIteration: number;
  /** The fully-built parent system prompt (post-merge with protocol /
   *  skills / context-files / environment). Kept for callers that want
   *  to inspect the parent's full prompt; sub-agent assembly itself
   *  uses `parentContextBlock` + `parentRunEnv` so the child sees the
   *  same framework framing without inheriting the parent's persona. */
  parentSystemPrompt: string;
  /** Pre-rendered `<project-conventions>` block from the parent's
   *  `loadContextFiles` pass. Reused verbatim by the sub-agent so the
   *  child sees the same project primer (AGENTS.md and friends). */
  parentContextBlock: string;
  /** Per-run isolation facts (cwd, bootstrap, runId) the parent saw.
   *  Sub-agents inherit verbatim — same worktree, same bootstrap. */
  parentRunEnv?: RunEnvironment;
  /** Skills the parent codergen call had visible. Sub-agents intersect
   *  `spec.skills` against this set. */
  parentSkills: readonly Skill[];
  /** Parent's `allowed_tools` attribute (or undefined when the node
   *  used the catch-all). Becomes the default for the child's pool
   *  unless `spec.allowed_tools` is set. */
  parentAllowedTools?: readonly string[];
  /** Parent's `denied_tools`. */
  parentDeniedTools?: readonly string[];
  /** Provider the parent codergen call resolved to. The child inherits
   *  by default — no per-call model selection from the LLM. */
  parentProvider: string;
  /** Model id the parent codergen call resolved to. */
  parentModel: string;
  /** Execution environment from the parent codergen call. Sub-agents
   *  inherit verbatim — no per-call worktree isolation, the
   *  sub-agent's read/write/edit/bash see the same filesystem the
   *  parent did. */
  parentEnv: ExecutionEnvironment;
  /** Forwards every observability event the sub-agent emits onto the
   *  parent's stream. The factory layers a `subagent_id` discriminator
   *  on top before invoking this. The host typically wraps
   *  `appendObservabilityEvents(parentRunId, …)` here — same channel
   *  the parent's own `input.emit` writes through. */
  parentEmit: (type: EventType, data: Record<string, unknown>) => Promise<void>;
}

export class PiCodergenBackend implements CodergenBackend {
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
   * missing is the resume signal — purely observational now: fidelity is
   * invariant across restarts, rehydration is byte-identical, and provider
   * caches either key off the stable thread_id (OpenAI Responses) or the
   * content itself (Anthropic / OpenAI Completions / Google). Shared across
   * every PiCodergenBackend in the daemon when the caller wires
   * `opts.inProcessWrites` (see `packages/cli/src/commands/daemon.ts`);
   * per-instance otherwise. Purely in-memory — never persisted. */
  private readonly inProcessWrites: Set<string>;
  private readonly spawnSubagentFactory:
    | ((parentCtx: SpawnSubagentParentCtx) => (spec: SubagentSpec) => Promise<SubagentResult>)
    | undefined;
  private readonly agentDefinitions: readonly AgentDefinition[];

  constructor(opts: PiCodergenBackendOptions) {
    this.registry = opts.registry;
    this.env = opts.env;
    // biome-ignore lint/suspicious/noExplicitAny: getModel is overloaded with KnownProvider; we intentionally accept any string so custom/faux providers work.
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
    this.spawnSubagentFactory = opts.spawnSubagentFactory;
    this.agentDefinitions = opts.agentDefinitions ?? [];
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
    const provider = input.node.attrs.llm_provider ?? this.defaultModel.provider;
    const modelId = input.node.attrs.llm_model ?? this.defaultModel.model;
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
    // Fail loudly when the node asked for tools but the registry produced
    // none. Silent empty-tools is the worst kind of misconfig — the model
    // happily generates `<tool_call>` XML as plain text and the run looks
    // like it succeeded while nothing actually ran. Caller should populate
    // the registry (e.g. `registry.registerAll(CORE_TOOLS)`) before
    // constructing the backend. Gated on `selectedTools` (not the
    // post-skill-merge `finalTools` below) so the diagnostic still fires
    // when the registry is genuinely empty — a registry that holds only
    // the force-included `skill` is still misconfigured.
    if (allow && allow.length > 0 && selectedTools.length === 0) {
      const registered = this.registry.list().map((t) => t.name);
      return fail(
        `allowed_tools=[${allow.join(", ")}] requested but none matched the backend registry (registered: [${registered.join(", ")}]). ` +
          "The registry must be populated before backend.run() — call `registry.registerAll(CORE_TOOLS)` at daemon setup.",
      );
    }

    // Force-include the built-in `skill` and `abort` tools. Even when the
    // node pins `allowed_tools` (excluding them) or lists them under
    // `denied_tools`, they must remain available — both are universal
    // affordances ("always available, zero .dot migration"). The system
    // prompt and tool descriptions advertise them; if they weren't
    // actually wired the model would call them and get a hard-to-diagnose
    // unknown-tool error. Skipped only when the registry doesn't carry
    // them (tests with a hand-rolled registry); workflow `allowed_tools`
    // / `denied_tools` cannot exclude them.
    const skillTool = this.registry.get("skill");
    const abortTool = this.registry.get("abort");
    let finalTools = selectedTools;
    if (skillTool && !finalTools.some((t) => t.name === "skill")) finalTools = [...finalTools, skillTool];
    if (abortTool && !finalTools.some((t) => t.name === "abort")) finalTools = [...finalTools, abortTool];

    // Prefer per-call env (wired via HandlerContext → CodergenInput by
    // the executor when a WorktreeProvisioner is active). Falls back
    // to the construction-time env for tests + callers that still pass
    // a shared LocalEnvironment. Resolved here ahead of the catalogue
    // filter — `env.projectCwd()` is what slices the discovery superset
    // down to this run's project.
    const effectiveEnv = input.env ?? this.env;
    if (!effectiveEnv) {
      return fail(
        "PiCodergenBackend: no execution environment available — configure `env` on backendOpts or wire a WorktreeProvisioner on the daemon",
      );
    }

    // Slice the discovery superset down to what this run can see: user-
    // scope records plus project-scope records whose `project_cwd`
    // matches `env.projectCwd()`, with project-scope shadowing user-
    // scope by name within the slice. Without this, a run in project A
    // would see project B's project-scope skills.
    const runProjectCwd = effectiveEnv.projectCwd();
    const runCwdSkills = filterCatalogueForRun(this.skills, runProjectCwd);
    const runCwdAgents = filterAgentsCatalogueForRun(this.agentDefinitions, runProjectCwd);

    // Resolve the skill catalog for this call. Filter by node attrs, render
    // the catalog block for the system prompt. The catalog drives both
    // the system-prompt advertisement and the `skill` tool's name lookup
    // (via swarmContext.skillCatalog patched onto the closure below).
    const nodeSkills = input.node.attrs.skills as string[] | undefined;
    const skillFilter: { skills?: readonly string[]; skills_disabled?: boolean } = {
      skills_disabled: input.node.attrs.skills_disabled === true,
    };
    if (nodeSkills !== undefined) skillFilter.skills = nodeSkills;
    const effectiveSkills = filterSkillsForNode(runCwdSkills, skillFilter);
    const skillsCatalog = renderSkillsCatalog(effectiveSkills);
    // Render the named-sub-agent catalogue only when (a) the node's
    // tool pool actually includes `agent` and (b) at least one profile
    // was discovered. Cost-control: a node that doesn't allow `agent`
    // also doesn't pay for the catalogue's tokens (~1 KB per profile).
    const wantsAgentTool = selectedTools.some((t) => t.name === "agent");
    const agentsCatalog = wantsAgentTool && runCwdAgents.length > 0 ? renderAgentsCatalog(runCwdAgents) : "";
    // Per-run swarm context. Built-in I/O tools ignore this field; the
    // `agent` tool reads `spawnSubagent` + `skillCatalog` + `agentCatalog`
    // to drive sub-agent runs. Captured by closure on each `toAgentTool`
    // call — a fresh `Agent({tools})` is built per `backend.run()`,
    // so closure values are correct for that run.
    const swarmEmit = input.emit;
    const summariser = this.summariser;
    // The `agent` tool needs the resolved parent system prompt + skills
    // to seed sub-agent runs, but `systemPrompt` isn't built until
    // after context-file loading below. Stage swarmContext as a
    // `let` and patch in `spawnSubagent` + `skillCatalog` once those
    // resources are ready. Tools captured by `toAgentTool` close over
    // the SAME object reference, so the patches are visible to every
    // tool call without re-mapping.
    const swarmContext: SwarmToolContext & {
      spawnSubagent?: SwarmToolContext["spawnSubagent"];
      skillCatalog?: readonly Skill[];
      agentCatalog?: readonly AgentDefinition[];
    } = {
      runId: input.run_id,
      nodeId: input.node.id,
      iteration: input.iteration?.n ?? 0,
      http: makeHttpClient({ signal: input.signal }),
      emit: swarmEmit
        ? (type, payload) => {
            void swarmEmit(type as EventType, payload);
          }
        : () => {},
      ...(summariser ? { summarise: (i) => summariser.summarise(i) } : {}),
    };
    const tools: AgentTool[] = finalTools.map((t) => toAgentTool(t, effectiveEnv, swarmContext));

    // Route-tool synthesis (docs/proposals/llm-routing.md D2). When the
    // node declares `routes=`, append an ephemeral, per-call `route`
    // tool whose `name` parameter is enum-constrained to the declared
    // routes. Provider rejects off-list values at the tool-call layer,
    // so an unknown route never reaches the handler. The tool sets
    // `terminate: true` so pi-agent-core stops the loop after the
    // batch — same loop-terminator pattern as the `abort` tool. The
    // chosen route is recovered post-loop by `findRouteToolCall`
    // scanning the transcript; the synthesised tool itself is purely a
    // loop-end signal. Force-included regardless of
    // `allowed_tools`/`denied_tools` because the route surface is
    // structural for a routing node — excluding it would leave the
    // model with no way to exit and the run would land
    // `route_not_picked`.
    const nodeRoutes = input.node.attrs.routes as string[] | undefined;
    if (Array.isArray(nodeRoutes) && nodeRoutes.length > 0) {
      tools.push(buildRouteTool(nodeRoutes));
    }

    const declared = (input.node.attrs.context_files as string[] | undefined) ?? [];
    const contextFiles = applyDefaultContextFiles(declared);
    const {
      text: contextBlock,
      warnings,
      files: contextFileRecords,
    } = await loadContextFiles(effectiveEnv, contextFiles);
    if (input.emit) {
      for (const msg of warnings) await input.emit("agent.warning", { message: msg });
    }
    const perNodeSystemPrompt =
      typeof input.node.attrs["system_prompt"] === "string" ? (input.node.attrs["system_prompt"] as string) : undefined;
    // Derive the per-call RunEnvironment from the resolved env.
    // `deriveRunEnv` always returns a value (every env has `cwd()`),
    // so every codergen call sees an `<environment>` block in its
    // system prompt regardless of env implementation. The
    // construction-time `this.runEnv` is honoured only as a fallback
    // for callers that wired it explicitly — it can override the
    // derived bootstrap line without affecting `cwd` / `runId`, which
    // must reflect the actual env.
    const effectiveRunEnv: RunEnvironment = deriveRunEnv(effectiveEnv, input.run_id);
    if (this.runEnv?.bootstrapCommand !== undefined && effectiveRunEnv.bootstrapCommand === undefined) {
      effectiveRunEnv.bootstrapCommand = this.runEnv.bootstrapCommand;
    }
    // Sub-agent path: `skipFrameworkSystemPrompt` makes the perNode
    // string the COMPLETE system prompt — no protocol wrap, no skills
    // catalog, no context-files, no run-env block. The calling LLM has
    // full control over the sub-agent's context window.
    const systemPrompt = input.skipFrameworkSystemPrompt
      ? (perNodeSystemPrompt ?? "")
      : buildSystemPrompt({
          global: this.systemPrompt,
          perNode: perNodeSystemPrompt,
          contextBlock,
          skillsCatalog,
          agentsCatalog,
          runEnv: effectiveRunEnv,
        });

    // Now that the parent's system prompt is fully resolved, wire the
    // `agent` tool. Sub-agents inherit this exact string verbatim when
    // their spec leaves `system_prompt` undefined (see
    // `materialiseForChild`). `skillCatalog` makes the parent's
    // resolved skill set available so `spec.skills` can be intersected
    // against it on each spawn.
    Object.assign(swarmContext, { skillCatalog: effectiveSkills, agentCatalog: runCwdAgents });
    if (this.spawnSubagentFactory !== undefined) {
      // The sub-agent's emit channel: same `input.emit` the parent's
      // codergen call uses, so sub-agent observability lands on the
      // parent's stream as a slice. The factory stamps `subagent_id`
      // on every payload before calling this. When the parent has no
      // emit (tests), sub-agents become a no-op stream.
      const parentEmit = input.emit
        ? async (type: EventType, data: Record<string, unknown>) => {
            await input.emit!(type, data);
          }
        : async () => {};
      const parentCtx: SpawnSubagentParentCtx = {
        parentRunId: input.run_id,
        parentNodeId: input.node.id,
        parentIteration: input.iteration?.n ?? 0,
        parentSystemPrompt: systemPrompt,
        parentContextBlock: contextBlock,
        parentSkills: effectiveSkills,
        parentProvider: provider,
        parentModel: modelId,
        parentEnv: effectiveEnv,
        parentEmit,
        parentRunEnv: effectiveRunEnv,
        ...(allow !== undefined ? { parentAllowedTools: allow } : {}),
        ...(deny !== undefined ? { parentDeniedTools: deny } : {}),
      };
      Object.assign(swarmContext, { spawnSubagent: this.spawnSubagentFactory(parentCtx) });
    }

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
      !isFresh && threadId ? (externalPrior ?? this.messageStore.get(input.run_id, threadId)) : [];
    if (externalPrior !== undefined && threadId) {
      // Keep the in-memory cache in sync so a subsequent same-process
      // call that omits priorMessages still sees the right history.
      this.messageStore.set(input.run_id, threadId, storedForThread);
    }

    // Resume detection — purely observational. Fidelity is invariant
    // across daemon restarts: rehydration from the messages table is
    // byte-identical, so Anthropic / OpenAI-Completions / Google hit their
    // content-addressed prompt caches on identical prefixes, and the
    // OpenAI-Responses family's `prompt_cache_key` is derived from the
    // stable `thread_id`. The flag lets us log "this thread was last
    // written by a prior process" without changing any behaviour.
    const decision = computeResumeDecision({
      fidelity: input.fidelity,
      isFresh,
      threadId,
      externalPriorLen: externalPrior !== undefined ? storedForThread.length : -1,
      hasInProcessWrite: threadId != null && this.inProcessWrites.has(sessionKey(input.run_id, threadId)),
    });
    const resumed = decision.resumed;
    const effectiveFidelity = decision.effectiveFidelity;
    const effectiveHydrate = hydrate;
    if (resumed && input.emit && threadId) {
      await input.emit("agent.info", {
        event: "thread_rehydrated",
        thread_id: threadId,
        message_count: storedForThread.length,
      });
    }

    let hydrateMessages: AgentMessage[] = effectiveHydrate && threadId ? storedForThread : [];

    // Pair any unpaired toolCall left at the tail of the rehydrated
    // transcript before pi-ai sees it. A daemon crash mid-tool-execute
    // leaves `[..., assistant{toolCall}]` in the messages table; the
    // anthropic API rejects an unpaired tool_use, so we either re-run
    // the tool (agent / idempotentOnReplay reads) or synthesise an
    // error toolResult. No-op when the trailing assistant has no
    // toolCalls or the transcript is empty. See
    // `docs/proposals/sub-agent-crash-resilience.md`.
    if (hydrateMessages.length > 0) {
      hydrateMessages = await sanitiseUnpairedToolCalls(hydrateMessages, {
        toolRegistry: this.registry,
        env: effectiveEnv,
        swarmContext,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    }

    // Build the fidelity seed prepended to the user prompt for non-full
    // modes. `full` returns "" and the user prompt is unchanged. `truncate`
    // / `compact` / `summary:*` produce a <swarm-context> block framing
    // the agent with goal + run + digest of priorMessages.
    const graphGoal = typeof input.goal === "string" && input.goal.length > 0 ? input.goal : undefined;
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

    // Capture the last HTTP response status pi-ai received per LLM call.
    // Pi-agent-core wires `onResponse` through to its `streamFn`, which in
    // turn forwards to pi-ai's `StreamOptions.onResponse`. The status lets
    // us classify a `stopReason="error"` end as a transport failure (4xx
    // / 5xx) versus a content/tool failure, and route the run to `paused`
    // (with reason `provider_error` or `payment_required` for 402) instead
    // of an unrecoverable halt.
    let lastHttpStatus: number | null = null;
    let lastRetryAfterMs: number | undefined;
    const captureResponse = (response: { status: number; headers: Record<string, string> }) => {
      lastHttpStatus = response.status;
      lastRetryAfterMs = parseRetryAfterMs(response.headers);
    };

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools,
        ...(hydrateMessages.length > 0 ? { messages: hydrateMessages } : {}),
      },
      onResponse: captureResponse,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(this.getApiKey !== undefined ? { getApiKey: this.getApiKey } : {}),
    });

    // Persist the system prompt as a swarm `system` custom message
    // (declaration-merged into pi-agent-core's CustomAgentMessages in
    // @swarm/store) so the full text is recoverable from the messages
    // table. Keeps `llm.start` under the 4KB event cap (§I7) — prior
    // turns + a sizable system_prompt easily blow past it. The messages
    // table is JSON + unbounded (§I9), so full content lives there.
    // Filtered back out before feeding priorMessages to pi-agent-core —
    // pi-ai carries the system prompt separately on each call.
    if (input.persistMessage && systemPrompt.length > 0) {
      input.persistMessage({ role: "system", content: systemPrompt, timestamp: Date.now() });
    }

    // Emit the resolved LLM-call snapshot. See docs/SPEC.md §3.5 for the
    // contract. Adding fields is additive — schema_version on the
    // envelope only bumps on incompatible renames/removals.
    //
    // Large fields are NOT inlined:
    //   - `system_prompt` → persisted as a role='system' message; the
    //     envelope carries sha256 + byte length for verification.
    //   - prior transcript snapshot → fully duplicated in the messages
    //     table; dropping it avoids O(N²) blow-up on threaded nodes.
    if (input.emit) {
      const systemPromptBytes = Buffer.byteLength(systemPrompt, "utf8");
      const llmStart: Record<string, unknown> = {
        provider,
        model: modelId,
        prompt: effectivePrompt,
        system_prompt_sha256: sha256Hex(systemPrompt),
        system_prompt_bytes: systemPromptBytes,
      };
      if (threadId) llmStart["thread_id"] = threadId;
      if (allow) llmStart["allowed_tools"] = allow;
      if (deny) llmStart["denied_tools"] = deny;
      if (input.iteration) llmStart["iteration"] = input.iteration;
      const priorMessageCount = agent.state.messages.length;
      if (priorMessageCount > 0) llmStart["prior_message_count"] = priorMessageCount;
      const settings = captureSettings(input.node.attrs);
      if (settings) llmStart["settings"] = settings;
      if (contextFileRecords.length > 0) llmStart["context_files"] = contextFileRecords;
      if (effectiveSkills.length > 0) llmStart["skills"] = effectiveSkills.map(toCatalogRecord);
      // Budget snapshot: prefer the executor-supplied value (real cumulative
      // from `run_state.metrics`); fall back to the zeroed shape derived from
      // node attrs alone for callers that haven't been threaded yet (legacy
      // tests). Zero-snapshot is harmless — the UI just renders 0/N until
      // the first node_completed lands.
      const budget = input.budgetSnapshot ?? captureBudget(input.node.attrs);
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
        // Persist the fully-assembled AgentMessage to the messages
        // table (§I9 — JSON, unbounded, stays out of the 4KB event
        // envelope §I7). Full block structure round-trips: text,
        // thinking (with thinkingSignature / redacted), toolCall (with
        // thoughtSignature), toolResult (with toolCallId pairing).
        //
        // Skip empty-content error/abort envelopes — pi-agent-core
        // synthesises an assistant message with `content: []` +
        // `stopReason: "error" | "aborted"` + `errorMessage` for a
        // provider transport failure or in-flight abort (see
        // `handleRunFailure` in pi-agent-core/dist/agent.js). The
        // row carries no tokens and no recoverable content; it's a
        // pure failure marker. Persisting it bloats the `messages`
        // table with N duplicates on every provider-error retry chain
        // (the auto-resume path re-dispatches `resumeOf:"fresh"` and
        // each fresh attempt that hits the same overloaded_error
        // appends another empty assistant + system + user) and
        // makes the conversation view look like the LLM is talking
        // to itself. The corresponding `cost.recorded` event still
        // fires above (with zeros), so cost accounting is unaffected.
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
    });

    // Register this agent as this run's steer target and drain any messages
    // that landed while no agent was active for this run (e.g. a steer fired
    // between nodes). `steer()` below calls agent.steer() directly when the
    // run's agent is set.
    const runId = input.run_id;
    this.steering.beginRun(runId, agent);

    // Wire the executor's abort signal to agent.abort() so control.cancel
    // actually stops the in-flight LLM stream / tool loop. Without this the
    // executor trips its AbortController but the Agent keeps running to
    // completion, leaving the run streaming minutes after cancel landed.
    //
    // Escape hatch for wedged provider fetches: agent.abort() forwards the
    // Agent's internal AbortController to streamSimple → provider SDK →
    // fetch. A well-behaved SDK tears the socket down promptly. A misbehaving
    // one (TCP wedge, lost signal wiring, slow upstream) leaves the awaited
    // promise inside agent.prompt() suspended for minutes — long enough to
    // blow past the executor's `maxMs + LEAK_GRACE_MS` window and trip
    // `fact.handler_timeout_leaked`. Race the awaited prompt against
    // `input.signal` plus a short cooperative-unwind grace; if the grace
    // expires throw a synthetic AbortError so the executor's `wasAborted`
    // path runs and the dispatch lands as `fact.node_aborted` instead of
    // halting the run. The grace must stay tight enough that the wrapper
    // exits inside the executor's 10s leak window.
    const abortListener = () => agent.abort();
    if (input.signal) {
      // Always register the listener — addEventListener does NOT fire
      // synchronously for an already-aborted signal, and the
      // already-aborted branch below queues the abort against the
      // live activeRun.
      input.signal.addEventListener("abort", abortListener, { once: true });
    }

    let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const promptDone = (async () => {
      await agent.prompt(effectivePrompt);
      await agent.waitForIdle();
    })();
    // Already-aborted case: agent.abort() called before agent.prompt()
    // existed is a no-op (no activeRun yet to abort). agent.prompt()
    // synchronously creates activeRun inside its body before the
    // first await, so a queueMicrotask scheduled AFTER promptDone's
    // synchronous prologue hits the live controller. Without this
    // the stream runs for the full ABORT_TEARDOWN_GRACE_MS (2s)
    // window before the outer race rejects — real provider tokens
    // get billed during those 2s. Hits the sub-agent fan-out case
    // where the parent's abort already fired (executor's reactive
    // budget gate) by the time spawn-subagent's child backend.run
    // starts: the child's input.signal is aborted at entry.
    if (input.signal?.aborted) {
      queueMicrotask(() => agent.abort());
    }
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
          else input.signal!.addEventListener("abort", arm, { once: true });
        })
      : undefined;

    try {
      if (abortRace) await Promise.race([promptDone, abortRace]);
      else await promptDone;
    } finally {
      if (abortGraceTimer !== undefined) clearTimeout(abortGraceTimer);
      this.steering.endRun(runId, agent);
      unsubscribe();
      if (input.signal) input.signal.removeEventListener("abort", abortListener);
    }

    // Persist the final transcript for `full` fidelity on a shared thread
    // so subsequent nodes with the same thread_id actually see it. Every
    // other mode is explicitly fresh (SPEC §3.3) and must not contaminate
    // the full-mode cache under the same thread.
    if (persist && threadId) {
      this.messageStore.set(input.run_id, threadId, agent.state.messages);
    }
    // Stamp `inProcessWrites` whenever a threaded node runs so the next
    // call in this process isn't misread as a resume. This has to fire
    // regardless of `persist` — e.g. a compact-mode node on the same
    // thread still proves "we're alive and past any pre-crash state".
    if (threadId) {
      this.inProcessWrites.add(sessionKey(input.run_id, threadId));
    }

    const last = agent.state.messages[agent.state.messages.length - 1];
    if (!last) {
      // No messages at all is the strongest signal that the very first
      // call failed transport-level. Pause-not-halt so the run can
      // resume after the operator fixes the upstream issue.
      return failProvider("provider returned no response", {
        httpStatus: lastHttpStatus,
        provider,
        ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
      });
    }

    if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      if (last.stopReason === "error") {
        const httpIs4xx5xx = lastHttpStatus !== null && lastHttpStatus >= 400 && lastHttpStatus < 600;
        const noContent = !Array.isArray(last.content) || last.content.length === 0;
        if (httpIs4xx5xx || noContent) {
          return failProvider(last.errorMessage ?? `provider stream error (HTTP ${lastHttpStatus ?? "n/a"})`, {
            httpStatus: lastHttpStatus,
            provider,
            ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
          });
        }
      }
      // Signal-driven abort (operator pause/cancel, supervisor timeout,
      // shutdown drain): pi-ai stops gracefully and surfaces
      // stopReason="aborted", but to the executor this is the same
      // class as a tool handler throwing AbortError — the dispatch
      // didn't choose to fail, an external signal stopped it. Rethrow
      // so the executor's `wasAborted` path runs: emit
      // `fact.node_aborted` (not a node_completed-into-terminal halt),
      // leave the run running, and let the next dispatch's fold consume
      // the pending pause/cancel intent through the normal R1/R4 rules.
      // Without this rethrow, an operator-paused codergen turn halts
      // with `reason="aborted_exit"` instead of pausing.
      if (last.stopReason === "aborted" && input.signal?.aborted) {
        const err = new Error(last.errorMessage ?? "stream aborted");
        err.name = "AbortError";
        throw err;
      }
      return fail(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
        notes: summarizeMessage(last),
      });
    }

    // Empty assistant turn without an explicit error — the stream ended
    // cleanly but produced nothing. Observed against real provider 402s
    // where pi-ai's stream parsed an HTTP error body as a benign
    // termination. Pause-not-halt; the operator's resume re-enters the
    // same node with the rehydrated transcript intact.
    if (last.role === "assistant" && (!Array.isArray(last.content) || last.content.length === 0)) {
      return failProvider("provider returned an empty response", {
        httpStatus: lastHttpStatus,
        provider,
        ...(lastRetryAfterMs !== undefined ? { retryAfterMs: lastRetryAfterMs } : {}),
      });
    }

    // Self-abort: an agent may decide its task is unreachable (missing target,
    // contradictory constraints, external blocker) and call the built-in
    // `abort` tool. Treating that as a `fail` outcome lets workflows wire an
    // early-exit edge with `condition="outcome=fail"` instead of forwarding
    // the whole run through a no-op plan → implement → verify chain. We also
    // flag it `non_retryable` so the goal-gate retry machinery doesn't
    // relaunch the run after an explicit stop.
    //
    // The `abort` tool sets `terminate: true`, so the loop stops after its
    // batch and the genuinely-last message is the tool result — `notes` is
    // taken from the last assistant message, and the abort scan walks the
    // whole transcript so it still wins when emitted in a non-terminating
    // batch alongside other tool calls.
    const lastAssistant = lastAssistantMessage(agent.state.messages);
    const notes = lastAssistant ? fullAssistantText(lastAssistant).slice(0, 4_000) : "";
    const aborted = findAbortToolCall(agent.state.messages);
    if (aborted) return fail(aborted.reason, { notes, non_retryable: true });

    // Route-tool resolution (docs/proposals/llm-routing.md D3). Only
    // considered when the node opted into routing via `routes=`. Abort
    // wins above — a self-abort cancels the route concern entirely.
    if (Array.isArray(nodeRoutes) && nodeRoutes.length > 0) {
      const routeCall = findRouteToolCall(agent.state.messages);
      if (routeCall == null) {
        return failHalt("route_not_picked", "agent ended turn without calling route()");
      }
      if (!routeCall.isolated) {
        return failHalt("route_call_not_isolated", "route() shared an assistant response with other tool calls");
      }
      return ok({ notes, route: routeCall.route });
    }

    return ok({ notes });
  }

  /** Inject a user message into the currently active agent for `runId`,
   * or buffer it for that run's next agent when nothing is running.
   * Called by the executor's control loop when a `control.steer` request
   * arrives. Fire-and-forget from the caller's point of view.
   *
   * `runId` is required so a steer can never leak across concurrent runs
   * on this shared backend — a caller that doesn't know the target runId
   * shouldn't be calling steer at all. */
  steer(runId: string, message: string): void {
    this.steering.steer(runId, message);
  }

  /** Release every per-run resource this backend holds for `runId`.
   * Called by the executor after a run reaches a terminal status. Without
   * this, a run that buffered a steer but never started another codergen
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

/** Cooperative-unwind window between `input.signal` aborting and the
 *  wrapper synthesising an AbortError. Long enough for a well-behaved
 *  provider SDK to tear its socket down (existing cancel-signal test
 *  unwinds in ~50ms); short enough to stay well inside the executor's
 *  10s `LEAK_GRACE_MS`, so a wedged fetch lands as `fact.node_aborted`
 *  instead of `fact.handler_timeout_leaked`. */
const ABORT_TEARDOWN_GRACE_MS = 2_000;

function sessionKey(runId: string, threadId: string): string {
  return `${runId}::${threadId}`;
}

/** Parse `Retry-After` from a response-headers map. RFC 7231 allows two
 * formats: integer seconds OR an HTTP-date. We honour seconds (the
 * common provider convention) and ignore HTTP-date (rare in LLM APIs).
 * Returns `undefined` when absent or malformed so the daemon falls back
 * to its full-jitter exponential schedule. */
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

/** Derive a `RunEnvironment` from the execution env. Always returns a
 *  value — every env has `cwd()`, so every codergen call gets a uniform
 *  `<environment>` block (no structural `worktreePath` probe that
 *  silently skipped `LocalEnvironment`). A `WorktreeEnvironment`'s own
 *  `runId` / `bootstrapCommand` are picked up when present so the
 *  block surfaces the bootstrap-ran signal. Exported for unit tests. */
export function deriveRunEnv(env: ExecutionEnvironment, runId: string): RunEnvironment {
  const wt = env as unknown as {
    runId?: unknown;
    bootstrapCommand?: unknown;
  };
  const out: RunEnvironment = {
    cwd: env.cwd(),
    runId: typeof wt.runId === "string" ? wt.runId : runId,
  };
  if (typeof wt.bootstrapCommand === "string") out.bootstrapCommand = wt.bootstrapCommand;
  return out;
}

/** Pure resume-decision helper, extracted for unit testability.
 *
 * `resumed` is purely observational: true when the caller supplied a
 * non-empty prior transcript for a (runId, threadId) that this process
 * has no record of writing. Fidelity is invariant across restarts —
 * rehydration is byte-identical and provider caches either content-hash
 * or key off the stable `thread_id`, so a resumed dispatch and a
 * same-process dispatch produce the same effective context. The flag
 * exists to emit an `agent.info` `thread_rehydrated` signal, not to
 * drive behaviour.
 */
export function computeResumeDecision(args: {
  fidelity: FidelityMode;
  isFresh: boolean;
  threadId: string | undefined;
  externalPriorLen: number;
  hasInProcessWrite: boolean;
}): { resumed: boolean; effectiveFidelity: FidelityMode } {
  const resumed = !args.isFresh && args.threadId != null && args.externalPriorLen > 0 && !args.hasInProcessWrite;
  return { resumed, effectiveFidelity: args.fidelity };
}

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
 * `docs/handler-contract.md` § "Codergen self-abort".
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
): { reason: string } | null {
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<{ type: string; name?: string; arguments?: Record<string, unknown> }>;
    for (const block of blocks) {
      if (block.type !== "toolCall" || block.name !== "abort") continue;
      const rawReason = typeof block.arguments?.["reason"] === "string" ? block.arguments["reason"] : "";
      const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, 400);
      return { reason: reason.length > 0 ? reason : "agent aborted without a reason" };
    }
  }
  return null;
}

/**
 * Scan the transcript for a call to the synthesised `route` tool
 * (docs/proposals/llm-routing.md D2/D3). The tool only exists for the
 * lifetime of one codergen call — see `buildRouteTool` — and its sole
 * effect is to terminate the agent loop. The chosen route is recovered
 * here from the assistant's tool-call block.
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
  const parameters = Type.Object(
    {
      name: nameSchema,
    },
    { additionalProperties: false },
  );
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
        details: { swarm_tool: "route", is_error: false, data: { route: chosen } },
        terminate: true,
      };
    },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
