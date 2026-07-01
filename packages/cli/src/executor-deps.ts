// Shared executor-assembly factory. Builds the dependencies an executor
// needs to run real workflows — the dispatcher with its auto-dispatcher
// resolver (real llm path: tool registry + backend opts + per-node
// codergen factory), the graph loader, the credential + model registries,
// the summariser, and skills discovery — out of a store + config.
//
// Two callers share it so they can't drift:
//   - `fragua daemon` (the long-running executor) — wraps these deps in
//     `startDaemon` (poll/claim/drain + supervisor + lock/heartbeat).
//   - `fragua ci` (the one-shot embedded executor) — drives `runOne` to
//     terminal over an ephemeral store.
//
// What stays with the caller, because it genuinely differs between the two:
//   - the store (daemon: `<cwd>/.fragua/fragua.db`; ci: ephemeral temp/--db),
//   - the provisioner (daemon: a worktree per run; ci: none / the checkout cwd),
//   - the auto-titler (daemon-only),
//   - concurrency (daemon: config; ci: 1) and the run loop itself.
//
// Credentials are NOT a parameter here: both callers resolve them from the
// store's `provider_credentials` rows via `AuthStorage.fromStore`. CI seeds
// those rows from env *before* calling this (the env→creds bridge), so the
// assembly is credential-source-agnostic.

import { homedir } from "node:os";
import type { Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  defaultSummariserModel,
  firstCredentialedProvider,
  ModelRegistry,
  makeLlmHandler,
  PiSummariserBackend,
  SteeringRegistry,
} from "@fragua/agent";
import * as handler from "@fragua/core/handler";
import { autoDispatcherResolver, Dispatcher, type GraphLoader, makeGraphLoader } from "@fragua/daemon";
import type { SqliteStore } from "@fragua/store";
import {
  CORE_TOOLS,
  createMcpConnector,
  discoverSkills,
  MCP_OAUTH_CALLBACK_URL,
  StoredOAuthProvider,
  ToolRegistry,
} from "@fragua/workspace";
import chalk from "chalk";
import type { FraguaConfig, ResolvedTimeouts } from "./config.ts";
import { makeMcpOAuthStore } from "./mcp-oauth-store.ts";

/** Where the resolved provider/model came from — drives the operator-facing
 * label so it's clear whether the daemon picked up flags, config, or env. */
export type LlmSource = "flags" | "config" | "env" | "stub";

export interface ExecutorDepsInput {
  /** The store both the executor and the credential/model registries read. */
  store: SqliteStore;
  /** Startup cwd — seeds skills discovery + run-target enumeration. */
  cwd: string;
  /** Already-loaded config (`loadConfig(cwd)`). */
  config: FraguaConfig;
  /** Already-resolved timeouts (`resolveTimeouts(config)`). */
  timeouts: ResolvedTimeouts;
  /** Provider override (CLI flag). Falls back to config defaults, then env. */
  provider?: string;
  /** Model override (CLI flag). */
  model?: string;
  /** Home dir for user-scope skills discovery. Default `os.homedir()`.
   * Injectable so CI / tests can scan a controlled tree rather than `~`. */
  homeDir?: string;
}

export interface ExecutorDeps {
  /** Dispatcher with the auto-dispatcher resolver already set. */
  dispatcher: Dispatcher;
  /** Parse-once graph boundary shared by resolver + executor. */
  graphLoader: GraphLoader;
  /** Legacy `LlmCallFn` path registry (the real llm path lives on the resolver). */
  tools: handler.InMemoryToolRegistry;
  llmCall: handler.LlmCallFn;
  /** Credential + model registries (both store-backed). */
  modelRegistry: ModelRegistry;
  authStorage: AuthStorage;
  /** Steer-buffer registry — set only when the real llm path is wired. */
  steeringRegistry: SteeringRegistry | undefined;
  /** Shared summariser (auto-title + per-node `summary=`), or a reason it's off. */
  summariser: SummariserInfo;
  /** Resolved llm target + provenance, for the caller's startup logging. */
  llm: { provider: string | undefined; model: string | undefined; source: LlmSource; useLlm: boolean };
}

/**
 * Assemble the executor dependencies from a store + config. Performs
 * skills discovery (and logs the count + any warnings, as the daemon
 * always has), resolves the provider/model, and wires the auto-dispatcher
 * resolver's real-llm path when a provider+model resolve.
 */
export async function buildExecutorDeps(input: ExecutorDepsInput): Promise<ExecutorDeps> {
  const { store, cwd, config, timeouts } = input;
  const homeDir = input.homeDir ?? homedir();

  const dispatcher = new Dispatcher();
  // One shared parse-once boundary: the auto-dispatcher and the executor
  // both consume it so each workflow sha parses once across every run.
  const graphLoader = makeGraphLoader(store);

  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  // Credentials + model registry. Both live on the store:
  // `provider_credentials` (api_key + OAuth) and `provider_config`
  // (custom-provider definitions).
  const authStorage = AuthStorage.fromStore(store);
  const modelRegistry = ModelRegistry.create(authStorage, store);
  const getApiKey = (p: string) => authStorage.getApiKey(p);

  // Resolve provider/model. Precedence: CLI flags >
  // .fragua/config.yaml defaults > env autodetect > stub.
  const cfgProvider = config.defaults?.provider;
  const cfgModel = config.defaults?.model;
  let provider = input.provider;
  let model = input.model;
  let llmSource: LlmSource = "stub";
  if (provider != null && model != null) {
    llmSource = "flags";
  } else if (provider == null && model == null && cfgProvider && cfgModel) {
    provider = cfgProvider;
    model = cfgModel;
    llmSource = "config";
  } else if (provider == null && model == null) {
    const auto = firstCredentialedProvider(modelRegistry);
    if (auto) {
      provider = auto.provider;
      model = auto.model.id;
      llmSource = "env";
    }
  }

  // Shared summariser — one PiSummariserBackend, used by BOTH the
  // AutoTitler (run-title generation) AND every llm backend's per-node
  // `summary=low|medium|high` path. Without it the summary path degrades to
  // a deterministic role-census + tail template with a soft warning.
  const summariser = buildSummariserBackend({
    config,
    primaryProvider: provider,
    modelRegistry,
    getApiKey,
  });

  // Discover skills once. Walks every cwd that has ever been a run target
  // (`store.listCwds()`) plus the startup cwd, emitting a superset across
  // all known projects. Per-run filtering happens at llm dispatch time.
  const knownCwds = store.listCwds().map((r) => r.cwd);
  const projectCwds = Array.from(new Set([cwd, ...knownCwds]));
  const { skills: discoveredSkills, warnings: skillWarnings } = await discoverSkills({
    projectCwds,
    homeDir,
    ...(config.skills ? { config: config.skills } : {}),
  });
  for (const w of skillWarnings) console.warn(chalk.yellow(`skills: ${w}`));
  if (discoveredSkills.length > 0) {
    console.log(
      chalk.dim(
        `discovered ${discoveredSkills.length} skill${discoveredSkills.length === 1 ? "" : "s"} across ${projectCwds.length} project${projectCwds.length === 1 ? "" : "s"} (${discoveredSkills.map((s) => s.name).join(", ")})`,
      ),
    );
  }

  // Auto-scan-on-first-sight. The catalogue above is a superset across every
  // cwd known at boot. When the dispatcher prepares a llm call for a `run.cwd`
  // that wasn't in `store.listCwds()` yet — typically the first run for a
  // freshly-onboarded project — we incrementally scan that cwd and merge into
  // the live array before the backend reads it. The backend holds the same
  // array reference mutated here, so pushed records become visible next read.
  const knownProjectCwds = new Set<string>(projectCwds);
  const inflightAutoScans = new Map<string, Promise<void>>();
  const ensureCatalogueForCwd = async (runCwd: string): Promise<void> => {
    if (knownProjectCwds.has(runCwd)) return;
    const inflight = inflightAutoScans.get(runCwd);
    if (inflight !== undefined) {
      await inflight;
      return;
    }
    const promise = (async () => {
      const skillsResult = await discoverSkills({
        projectCwds: [runCwd],
        homeDir,
        ...(config.skills ? { config: config.skills } : {}),
      });
      // Merge by `location` — globally unique per record. Skip any duplicate
      // (e.g. a user-scope record the second scan re-emits).
      const existingSkillLocs = new Set(discoveredSkills.map((s) => s.location));
      for (const s of skillsResult.skills) {
        if (!existingSkillLocs.has(s.location)) discoveredSkills.push(s);
      }
      for (const w of skillsResult.warnings) console.warn(chalk.yellow(`skills (auto-scan ${runCwd}): ${w}`));
      knownProjectCwds.add(runCwd);
    })();
    inflightAutoScans.set(runCwd, promise);
    try {
      await promise;
    } finally {
      inflightAutoScans.delete(runCwd);
    }
  };

  const useLlm = provider != null && model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
  let steeringRegistry: SteeringRegistry | undefined;
  if (useLlm) {
    // Register the four core tools (read / write / edit / bash) on the backend
    // registry. Without this the registry is empty, pi-agent-core gets
    // `tools: []`, and the model has no schemas to structure tool calls
    // against — it falls back to emitting `<tool_call>` XML as raw text.
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    // Shared `inProcessWrites` — one Set so every llm backend (one per node)
    // sees the same "we've written to this (runId, threadId)" signal, so
    // `computeResumeDecision` doesn't misread a legitimate cross-node dispatch
    // on a shared `thread_id` as a process-boundary resume. Seeded at boot
    // from threads with messages so an honest cross-restart resume stays
    // `resumed=false` when its key already exists.
    const inProcessWrites = new Set<string>();
    for (const pair of store.listThreadsWithMessages()) {
      inProcessWrites.add(`${pair.runId}::${pair.threadId}`);
    }
    // Shared steer-buffer registry. The caller hands this to the supervisor's
    // `onSteer` so an `intent.steering_requested` routes into pi-agent-core's
    // `steeringQueue` (drained at end-of-turn) rather than tripping the abort
    // controller.
    steeringRegistry = new SteeringRegistry();
    const backendOpts = {
      registry,
      defaultModel: { provider: provider!, model: model! },
      // Route model resolution through the ModelRegistry so custom providers
      // (Ollama etc.) and provider_config overrides are honoured. Throws if
      // the id is unknown — backend.run catches and surfaces.
      resolveModel: (p: string, id: string): Model<string> => {
        const m = modelRegistry.find(p, id);
        if (!m) throw new Error(`model "${p}/${id}" not registered`);
        return m as Model<string>;
      },
      getApiKey,
      inProcessWrites,
      steering: steeringRegistry,
      // Tier-1 skills catalog — rendered into the system prompt of every llm
      // call, filtered per-node by `attrs.skills` / `skills_disabled`.
      skills: discoveredSkills,
      // Materialises MCP-server tools for nodes that declare `mcp-servers:`.
      // Reads `<run cwd>/.mcp.json` lazily per node. Remote http servers
      // with no static `Authorization` header authenticate through a stored
      // OAuth token; the daemon's `onRedirect` throws (never opens a browser)
      // so an un-authed server is skipped via the connect-failure path with a
      // clear "run `fragua mcp login`" message rather than hanging startup.
      mcpConnector: createMcpConnector({
        oauthProviderFor: (url) =>
          new StoredOAuthProvider({
            url,
            store: makeMcpOAuthStore(store),
            redirectUrl: MCP_OAUTH_CALLBACK_URL,
            onRedirect: () => {
              throw new Error(`MCP server ${url} requires OAuth — run \`fragua mcp login\` for it`);
            },
          }),
      }),
      ...(summariser.backend ? { summariser: summariser.backend } : {}),
    };
    // `nextNode` is intentionally NOT forwarded to makeLlmHandler — for llm
    // that would force every call to route to whichever edge appears first,
    // bypassing the edge selector (which picks on outcome status + condition).
    codergenFactory = (node, _nextNode, maxMs) => {
      const factoryOpts: Parameters<typeof makeLlmHandler>[0] = { node, backendOpts };
      if (maxMs !== undefined) factoryOpts.maxMs = maxMs;
      const inner = makeLlmHandler(factoryOpts);
      // Run auto-scan before the inner handler dispatches: first-run-of-a-new
      // -project pays one extra frontmatter walk; every later dispatch hits the
      // `knownProjectCwds.has()` fast path and is a no-op.
      const innerHandler = inner.handler;
      return {
        ...inner,
        handler: async (ctx) => {
          if (ctx.env !== undefined) await ensureCatalogueForCwd(ctx.env.projectCwd());
          return innerHandler(ctx);
        },
      };
    };
  }
  const defaultMaxMs: { llm?: number; tool?: number } = {};
  if (timeouts.llm !== undefined) defaultMaxMs.llm = timeouts.llm;
  if (timeouts.tool !== undefined) defaultMaxMs.tool = timeouts.tool;
  dispatcher.setResolver(
    autoDispatcherResolver({
      store,
      graphLoader,
      ...(codergenFactory ? { codergenFactory } : {}),
      ...(Object.keys(defaultMaxMs).length > 0 ? { defaultMaxMs } : {}),
    }),
  );

  return {
    dispatcher,
    graphLoader,
    tools,
    llmCall,
    modelRegistry,
    authStorage,
    steeringRegistry,
    summariser,
    llm: { provider, model, source: llmSource, useLlm },
  };
}

export interface SummariserInfo {
  backend: PiSummariserBackend | undefined;
  label: string | undefined;
}

/** Construct the shared `PiSummariserBackend` used by AutoTitler + every llm
 * backend's per-node `summary=` path. Returns `{ backend: undefined }` when
 * there's no usable provider/model combination — the caller decides how to
 * surface that (AutoTitler disables itself; summary paths warn + fall back to
 * the deterministic template). */
export function buildSummariserBackend(args: {
  config: FraguaConfig;
  primaryProvider: string | undefined;
  modelRegistry: ModelRegistry;
  getApiKey: (provider: string) => Promise<string | undefined>;
}): SummariserInfo {
  const { config, primaryProvider, modelRegistry, getApiKey } = args;
  const sumProvider = config.summariser?.provider ?? primaryProvider;
  if (!sumProvider) return { backend: undefined, label: undefined };
  const sumModel = config.summariser?.model ?? defaultSummariserModel(sumProvider);
  if (!sumModel) return { backend: undefined, label: `no default model for ${sumProvider}` };
  // Validate at boot — the summariser's resolveModel throws lazily on first
  // call, which surfaces deep inside whatever path triggered it and looks like
  // a tool failure rather than a config error. Catching it here gives the
  // operator one obvious "fix this in config.yaml" line at startup.
  if (!modelRegistry.find(sumProvider, sumModel)) {
    return {
      backend: undefined,
      label: `model "${sumProvider}/${sumModel}" not registered (run \`fragua providers\` for valid ids)`,
    };
  }
  const backend = new PiSummariserBackend({
    provider: sumProvider,
    model: sumModel,
    resolveModel: (p, id) => {
      const m = modelRegistry.find(p, id);
      if (!m) throw new Error(`summariser model "${p}/${id}" not registered`);
      return m as Model<string>;
    },
    getApiKey,
  });
  return { backend, label: `${sumProvider}/${sumModel}` };
}
