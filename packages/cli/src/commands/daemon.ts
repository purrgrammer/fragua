// `swarm daemon` — run the packages/daemon process against the local store.
//
// Out of the box the daemon uses a stub LLM. Pass `--llm-provider` +
// `--llm-model` (or omit both for the defaults) and the auto-dispatcher
// routes every `box` node through a PiCodergenBackend so real LLM calls
// fire. Handlers of other shapes (Mdiamond start, Msquare exit, hexagon
// wait.human, etc.) stay on the trivial transitions.

import { mkdirSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  defaultSummariserModel,
  firstCredentialedProvider,
  ModelRegistry,
  makeCodergenHandler,
  PiCodergenBackend,
  PiSummariserBackend,
  type SpawnSubagentParentCtx,
  SteeringRegistry,
} from "@swarm/agent";
import { parseDurationMs } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import {
  AutoTitler,
  autoDispatcherResolver,
  Dispatcher,
  makeSpawnSubagent,
  type Provisioner,
  startDaemon,
  WorktreeProvisioner,
} from "@swarm/daemon";
import { SqliteStore } from "@swarm/store";
import { CORE_TOOLS, discoverAgents, discoverSkills, loadExtensions, ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";
import { loadConfig, loadProjectConfig, resolveTimeouts } from "../config.ts";

/**
 * Poll interval for `swarm daemon stop` — how often we check whether
 * the lock row has cleared after SIGTERM. Kept small so the CLI feels
 * responsive; the 10s timeout is enforced by a separate deadline.
 */
const STOP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 10_000;

/**
 * `swarm daemon stop` — SIGTERM the daemon identified by the
 * daemon_lock row and poll for the row to clear. Coordination is
 * DB-only; no pidfile.
 *
 * Returns:
 *   0  — daemon stopped cleanly or none was running
 *   1  — the lock pointed at a live pid that refused to exit within
 *        STOP_TIMEOUT_MS
 */
export async function daemonStopCommand(opts: { cwd?: string; dbPath?: string } = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".swarm/swarm.db");
  const store = new SqliteStore({ path: storePath });
  try {
    const lock = store.currentDaemonLock();
    if (lock == null) {
      console.log(chalk.dim("no daemon running"));
      return 0;
    }
    const pid = lock.pid;
    // Remote daemons share the store but not signal-able from here.
    if (lock.hostname !== hostnameSafe()) {
      console.error(
        chalk.yellow(`daemon lock held by pid=${pid} on host=${lock.hostname} — can't SIGTERM across hosts`),
      );
      return 1;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Pid is already gone; lock row is stale. Release it so the next
      // start doesn't have to wait for the heartbeat TTL.
      if (code === "ESRCH") {
        store.forceAcquireDaemonLock(process.pid, hostnameSafe());
        store.releaseDaemonLock(process.pid);
        console.log(chalk.dim(`stale lock cleared (pid=${pid} not running)`));
        return 0;
      }
      console.error(chalk.red(`failed to signal pid=${pid}: ${(err as Error).message}`));
      return 1;
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, STOP_POLL_MS));
      const current = store.currentDaemonLock();
      if (current == null || current.pid !== pid) {
        console.log(chalk.green(`stopped pid=${pid}`));
        return 0;
      }
    }
    console.error(chalk.red(`daemon did not exit, pid=${pid} still alive after ${STOP_TIMEOUT_MS}ms`));
    return 1;
  } finally {
    store.close();
  }
}

function hostnameSafe(): string {
  try {
    return osHostname();
  } catch {
    return "unknown";
  }
}

export interface DaemonCommandOptions {
  /** Working directory used to resolve the store path. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit store path. Overrides `<cwd>/.swarm/swarm.db`. */
  dbPath?: string;
  /** Max concurrent runs. Default 4. */
  concurrency?: number;
  /** LLM provider override. When set with `llmModel`, enables the real
   * codergen path. Mirrors workflow node `llm_provider` (attractor §2.6). */
  llmProvider?: string;
  /** LLM model id. Mirrors workflow node `llm_model` (attractor §2.6). */
  llmModel?: string;
}

export async function daemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".swarm/swarm.db");
  mkdirSync(dirname(storePath), { recursive: true });

  const store = new SqliteStore({ path: storePath });
  const dispatcher = new Dispatcher();

  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  // Credentials + model registry. Both are global (~/.swarm/{auth,models}.json)
  // with the pi-coding-agent dirs as read-only fallback. Constructed once
  // per daemon process; cheap to hold on to for the process lifetime.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const getApiKey = (p: string) => authStorage.getApiKey(p);

  // Resolve llm_provider/llm_model. Precedence: CLI flags >
  // .swarm/config.jsonc defaults > env autodetect > stub.
  const config = await loadConfig(cwd);
  let timeouts: ReturnType<typeof resolveTimeouts>;
  try {
    timeouts = resolveTimeouts(config);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    return 1;
  }
  const cfgProvider = config.defaults?.llm_provider;
  const cfgModel = config.defaults?.llm_model;
  let provider = opts.llmProvider;
  let model = opts.llmModel;
  let llmSource: "flags" | "config" | "env" | "stub" = "stub";
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
  const concurrency = opts.concurrency ?? config.concurrency ?? 4;

  const signalCtrl = new AbortController();
  const onSig = () => signalCtrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  // Shared summariser — one PiSummariserBackend per daemon process, used
  // by BOTH the AutoTitler (run-title generation) AND every codergen
  // backend's `fidelity=summary:medium/high` path. Without reuse the
  // fidelity path has no backend wired and degrades to the deterministic
  // `summary:low` template with a soft warning (visible in events.jsonl).
  const summariserInfo = buildSummariserBackend({
    config,
    primaryProvider: provider,
    modelRegistry,
    getApiKey,
  });

  // Discover skills once at boot. Walks every cwd that has ever been a
  // run target (`store.listCwds()`) plus the daemon's own startup cwd,
  // emitting a superset across all known projects. Per-run filtering
  // happens at codergen dispatch time. New project cwds discovered after
  // boot trigger an auto-scan on first sight.
  const knownCwds = store.listCwds().map((r) => r.cwd);
  const projectCwds = Array.from(new Set([cwd, ...knownCwds]));
  const { skills: discoveredSkills, warnings: skillWarnings } = await discoverSkills({
    projectCwds,
    homeDir: homedir(),
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

  // Discover named sub-agent profiles across the same project set.
  // Catalogue lands on every codergen call whose tool pool includes
  // `agent`; per-run filter at dispatch picks the right slice.
  const { agents: discoveredAgents, warnings: agentWarnings } = await discoverAgents({
    projectCwds,
    homeDir: homedir(),
  });
  for (const w of agentWarnings) console.warn(chalk.yellow(`agents: ${w}`));
  if (discoveredAgents.length > 0) {
    console.log(
      chalk.dim(
        `discovered ${discoveredAgents.length} agent${discoveredAgents.length === 1 ? "" : "s"} (${discoveredAgents.map((a) => a.name).join(", ")})`,
      ),
    );
  }

  // Auto-scan-on-first-sight. The catalogues above are a superset across
  // every cwd known at boot. When the dispatcher prepares a codergen call
  // for a `run.cwd` that wasn't in `store.listCwds()` yet — typically the
  // first run for a freshly-onboarded project — we incrementally scan
  // that cwd and merge results into the live arrays before the backend
  // reads them. The backend's `this.skills` / `this.agentDefinitions`
  // are set once on construction, but they hold the same array
  // references mutated here, so pushed records become visible on the
  // next read.
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
      const home = homedir();
      const [skillsResult, agentsResult] = await Promise.all([
        discoverSkills({
          projectCwds: [runCwd],
          homeDir: home,
          ...(config.skills ? { config: config.skills } : {}),
        }),
        discoverAgents({ projectCwds: [runCwd], homeDir: home }),
      ]);
      // Merge by `location` — globally unique per record. Skip any
      // duplicate (e.g. user-scope records the second scan re-emits).
      const existingSkillLocs = new Set(discoveredSkills.map((s) => s.location));
      for (const s of skillsResult.skills) {
        if (!existingSkillLocs.has(s.location)) discoveredSkills.push(s);
      }
      const existingAgentLocs = new Set(discoveredAgents.map((a) => a.location));
      for (const a of agentsResult.agents) {
        if (!existingAgentLocs.has(a.location)) discoveredAgents.push(a);
      }
      for (const w of skillsResult.warnings) console.warn(chalk.yellow(`skills (auto-scan ${runCwd}): ${w}`));
      for (const w of agentsResult.warnings) console.warn(chalk.yellow(`agents (auto-scan ${runCwd}): ${w}`));
      knownProjectCwds.add(runCwd);
    })();
    inflightAutoScans.set(runCwd, promise);
    try {
      await promise;
    } finally {
      inflightAutoScans.delete(runCwd);
    }
  };

  // Discover and load extensions once at boot. Same scopes as skills
  // (`<cwd>/.swarm/extensions/`, `~/.swarm/extensions/`); precedence on
  // tool-name collision is project-beats-user. Hot reload is deferred —
  // a new extension drop requires a daemon restart.
  const {
    extensions: loadedExtensions,
    tools: extensionTools,
    warnings: extensionWarnings,
  } = await loadExtensions({
    cwd,
    homeDir: homedir(),
  });
  for (const w of extensionWarnings) console.warn(chalk.yellow(`extensions: ${w}`));
  if (loadedExtensions.length > 0) {
    const okCount = loadedExtensions.filter((e) => e.error === undefined).length;
    const errCount = loadedExtensions.length - okCount;
    const toolCount = extensionTools.length;
    const summary =
      `loaded ${okCount} extension${okCount === 1 ? "" : "s"} ` +
      `(${toolCount} tool${toolCount === 1 ? "" : "s"})` +
      (errCount > 0 ? `, ${errCount} failed` : "");
    console.log(chalk.dim(summary));
    for (const ext of loadedExtensions) {
      if (ext.error !== undefined) {
        console.warn(chalk.yellow(`  ✗ ${ext.extensionId}: ${ext.error}`));
      }
    }
  }

  const useLlm = provider != null && model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
  let steeringRegistry: SteeringRegistry | undefined;
  if (useLlm) {
    // `env` is wired per-run via the WorktreeProvisioner below —
    // the backend reads it off `CodergenInput` on each call, so we
    // intentionally leave `backendOpts.env` unset here.
    // Register the four core tools (read / write / edit / bash) on the
    // backend registry. Without this the registry is empty, pi-agent-core
    // gets `tools: []`, and the model has no schemas to structure tool
    // calls against — it falls back to emitting `<tool_call>` XML as raw
    // text (mimicking what it saw in training). Symptom: zero
    // `tool.execution_*` events across an entire run and the agent
    // "hallucinates" command output that never ran.
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    // Append extension-loaded tools after built-ins. The loader already
    // applied project-beats-user precedence; the registry's
    // `registerAll` throws on duplicates so a custom tool named after a
    // built-in (e.g. `bash`) surfaces here as a startup error rather
    // than silently shadowing.
    if (extensionTools.length > 0) {
      try {
        registry.registerAll(extensionTools);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`extensions: failed to merge tools: ${message}`));
        return 1;
      }
    }
    // Shared `inProcessWrites` — one Set for the whole daemon process so
    // every codergen backend (one per workflow node — see the factory
    // below) sees the same "we've written to this (runId, threadId)"
    // signal. The Set's job is to stop `computeResumeDecision` from
    // misreading a legitimate cross-node dispatch (e.g. `implement` →
    // `verify` on shared `thread_id="dev"`) as a process-boundary resume.
    //
    // Seeded at boot from the messages table + llm.start events of
    // non-terminal runs: a resumed node on a pre-existing thread finds
    // its key already present and the decision stays `resumed=false`.
    // Without this seed, an honest cross-restart resume would flip
    // `resumed=true` purely on the basis of "we don't have this key yet"
    // — which is observational but still noisy in event logs.
    const inProcessWrites = new Set<string>();
    for (const pair of store.listThreadsWithMessages()) {
      inProcessWrites.add(`${pair.runId}::${pair.threadId}`);
    }
    // Shared steer-buffer registry. The daemon entrypoint hands this same
    // registry to the supervisor's `onSteer` so an `intent.steering_requested`
    // routes into pi-agent-core's `steeringQueue` (drained at end-of-turn)
    // rather than tripping the abort controller — which would force the
    // codergen handler to classify the in-flight call's `stopReason: "aborted"`
    // as a fail outcome.
    steeringRegistry = new SteeringRegistry();
    const backendOpts = {
      registry,
      defaultModel: { provider: provider!, model: model! },
      // Route model resolution through the ModelRegistry so custom
      // providers (Ollama etc.) and models.json overrides are honoured.
      // Throws if the id is unknown — backend.run catches and surfaces.
      resolveModel: (p: string, id: string): Model<string> => {
        const m = modelRegistry.find(p, id);
        if (!m) throw new Error(`model "${p}/${id}" not registered`);
        return m as Model<string>;
      },
      getApiKey,
      inProcessWrites,
      steering: steeringRegistry,
      // Tier-1 skills catalog — rendered into the system prompt of every
      // codergen call, filtered per-node by `attrs.skills` /
      // `skills_disabled`. Empty array is a valid no-op.
      skills: discoveredSkills,
      // Named sub-agent profiles. The backend renders the `## Available
      // sub-agents` block into the system prompt only when the node's
      // tool pool includes `agent`; otherwise the catalogue is silent.
      agentDefinitions: discoveredAgents,
      ...(summariserInfo.backend ? { summariser: summariserInfo.backend } : {}),
      // Wire the per-call sub-agent spawner. The closure built by
      // makeSpawnSubagent runs the sub-agent's codergen call inline
      // against the parent's event stream — no child run, no separate
      // dispatcher path. Each spawn synthesises a one-off backend so
      // the per-call factory has a `backend` reference that doesn't
      // capture the parent's per-node backend (which carries
      // node-scoped attrs irrelevant to the sub-agent).
      spawnSubagentFactory: (parentCtx: SpawnSubagentParentCtx) => {
        const subagentBackend = new PiCodergenBackend(backendOpts);
        return makeSpawnSubagent(
          {
            store,
            registry,
            backend: subagentBackend,
            shutdownSignal: signalCtrl.signal,
          },
          parentCtx,
        );
      },
    };
    // `nextNode` is intentionally NOT forwarded to makeCodergenHandler.
    // The factory receives the first outgoing edge as a legacy-compat
    // hint for tool/transition nodes, but for codergen that would force
    // every call to route to whichever edge happens to appear first in
    // the DOT — bypassing the edge selector. Real codergen nodes need
    // the selector to pick based on outcome status + condition matching
    // (e.g. `implement -> done [condition="outcome=fail"]` vs the
    // unconditional `implement -> verify`).
    codergenFactory = (node, _nextNode, maxMs) => {
      const factoryOpts: Parameters<typeof makeCodergenHandler>[0] = { node, backendOpts };
      if (maxMs !== undefined) factoryOpts.maxMs = maxMs;
      const inner = makeCodergenHandler(factoryOpts);
      // Run auto-scan before the inner handler dispatches: if the run's
      // project cwd hasn't been catalogued yet, scan it and merge.
      // First-run-of-a-new-project pays one extra frontmatter walk;
      // every subsequent dispatch hits the `knownProjectCwds.has()`
      // fast path and is a no-op.
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
  const defaultMaxMs: { codergen?: number; tool?: number } = {};
  if (timeouts.codergen !== undefined) defaultMaxMs.codergen = timeouts.codergen;
  if (timeouts.tool !== undefined) defaultMaxMs.tool = timeouts.tool;
  dispatcher.setResolver(
    autoDispatcherResolver({
      store,
      ...(codergenFactory ? { codergenFactory } : {}),
      ...(Object.keys(defaultMaxMs).length > 0 ? { defaultMaxMs } : {}),
    }),
  );

  // Auto-title summariser — cheap cross-run call that labels each run
  // post-enqueue. Uses `defaults.summariser.{llm_provider,llm_model}`
  // when set; otherwise defaults to the cheapest known model for the
  // primary provider. `autoTitle: false` disables even when a backend
  // is configured.
  const autoTitler = buildAutoTitler({
    store,
    config,
    summariser: summariserInfo,
    shutdownSignal: signalCtrl.signal,
  });

  // Worktree provisioner — every run gets a `git worktree` with its
  // own branch so agents never mutate the user's working copy and
  // concurrent runs don't stomp on each other. Bootstrap is
  // **resolved per run** against the run's project root via
  // `loadProjectConfig(<run.cwd>)` — so one daemon can serve runs
  // from many projects, each picking up its own
  // `.swarm/config.jsonc` `bootstrap` field. No global / no
  // daemon-startup-cwd fallback: a project that doesn't declare a
  // bootstrap gets no bootstrap (the previous behaviour silently
  // leaked the daemon's startup-cwd config to every project, which
  // broke as soon as a second project entered the picture).
  //
  // The worktree/local choice itself is **per-run** (decided inside
  // `WorktreeProvisioner.create()` against the run's cwd), so the
  // daemon's own startup cwd is irrelevant — a run from a git-repo
  // cwd gets a worktree, a run from a non-git cwd gets a
  // LocalEnvironment rooted at *its own* cwd.
  const resolveRunBootstrap = async (runCwd: string) => {
    const projectCfg = await loadProjectConfig(runCwd);
    const projectTimeouts = resolveTimeouts(projectCfg);
    const out: { bootstrap?: string; bootstrapTimeoutMs?: number } = {};
    if (projectCfg.bootstrap !== undefined) out.bootstrap = projectCfg.bootstrap;
    // Top-level `bootstrapTimeoutMs` wins over nested `timeouts.bootstrap`
    // when both are set — the top-level form is more explicit about
    // pairing with `bootstrap`. `timeouts.bootstrap` stays supported for
    // back-compat and for users who prefer duration strings ("10m").
    if (projectCfg.bootstrapTimeoutMs !== undefined) {
      out.bootstrapTimeoutMs = projectCfg.bootstrapTimeoutMs;
    } else if (projectTimeouts.bootstrap !== undefined) {
      out.bootstrapTimeoutMs = projectTimeouts.bootstrap;
    }
    return out;
  };
  const provisioner: Provisioner = new WorktreeProvisioner({
    repoRoot: cwd,
    resolveRunBootstrap,
    ...(timeouts.shell !== undefined ? { defaultShellTimeoutMs: timeouts.shell } : {}),
  });
  const provisionerLabel =
    `worktree per-run when run cwd is a git repo, else LocalEnvironment rooted at run cwd ` +
    `(bootstrap: per-run from <project>/.swarm/config.jsonc)`;

  console.log(chalk.green(`swarm daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${concurrency}`));
  const sourceSuffix =
    llmSource === "env" ? " (auto-detected from env)" : llmSource === "config" ? " (from .swarm/config.jsonc)" : "";
  const llmLabel = useLlm
    ? `${provider}/${model}${sourceSuffix}`
    : "stub (set a provider API key, or pass --llm-provider + --llm-model)";
  console.log(chalk.dim(`  llm default: ${llmLabel}`));
  if (useLlm) {
    console.log(chalk.dim(`  nodes can override via \`llm_provider=\`/\`llm_model=\` attrs`));
  }
  // Explicit summariser line so operators see the wired model. When
  // `buildSummariserBackend` rejected the configured model at validation
  // (model not registered / no default for provider), `summariserInfo.backend`
  // is undefined and the label carries the rejection reason — surface it
  // loudly so the operator updates `.swarm/config.jsonc` rather than
  // chasing the failure through extension tools at runtime.
  if (summariserInfo.backend) {
    console.log(chalk.dim(`  summariser: ${summariserInfo.label}`));
  } else if (summariserInfo.label) {
    console.log(chalk.yellow(`  summariser: disabled — ${summariserInfo.label}`));
  }
  if (autoTitler.label !== undefined) {
    console.log(chalk.dim(`  auto-title: ${autoTitler.label}`));
  }
  console.log(chalk.dim(`  runtime: ${provisionerLabel}`));
  console.log(chalk.dim(`  press Ctrl-C to stop`));

  let exitCode = 0;
  try {
    const daemonOpts: Parameters<typeof startDaemon>[0] = {
      store,
      dispatcher,
      tools,
      llmCall,
      maxConcurrentRuns: concurrency,
      shutdownSignal: signalCtrl.signal,
      provisioner,
    };
    if (autoTitler.titler) daemonOpts.autoTitler = autoTitler.titler;
    if (timeouts.leakGrace !== undefined) daemonOpts.leakGraceMs = timeouts.leakGrace;
    if (timeouts.shutdownDrain !== undefined) daemonOpts.shutdownDrainMs = timeouts.shutdownDrain;
    if (timeouts.http !== undefined) daemonOpts.defaultHttpTimeoutMs = timeouts.http;
    if (config.maxLoops !== undefined) daemonOpts.maxLoops = config.maxLoops;
    if (config.abortLoopCeiling !== undefined) daemonOpts.abortLoopCeiling = config.abortLoopCeiling;
    if (config.maxLeakedHandlers !== undefined) daemonOpts.maxLeakedHandlers = config.maxLeakedHandlers;
    if (config.blobGc?.interval !== undefined) {
      try {
        daemonOpts.blobGcIntervalMs = parseDurationMs(config.blobGc.interval);
      } catch (err) {
        console.error(chalk.red(`config: blobGc.interval: ${(err as Error).message}`));
        return 1;
      }
    }
    if (config.blobGc?.maxRows !== undefined) daemonOpts.blobGcMaxRows = config.blobGc.maxRows;
    if (steeringRegistry !== undefined) {
      const reg = steeringRegistry;
      daemonOpts.onSteer = (runId, text) => reg.steer(runId, text);
    }
    const handleRef = startDaemon(daemonOpts);
    await handleRef.done;
  } catch (err) {
    console.error(chalk.red(`daemon error: ${(err as Error).message}`));
    exitCode = 1;
  } finally {
    store.close();
  }
  return exitCode;
}

interface SummariserInfo {
  backend: PiSummariserBackend | undefined;
  label: string | undefined;
}

/** Construct the shared `PiSummariserBackend` used by AutoTitler + every
 * codergen backend's fidelity=summary:* path. Returns `{ backend:
 * undefined }` when there's no usable provider/model combination — the
 * caller decides how to surface that (AutoTitler disables itself;
 * fidelity paths already warn + fall back to `summary:low`). */
function buildSummariserBackend(args: {
  config: Awaited<ReturnType<typeof loadConfig>>;
  primaryProvider: string | undefined;
  modelRegistry: ModelRegistry;
  getApiKey: (provider: string) => Promise<string | undefined>;
}): SummariserInfo {
  const { config, primaryProvider, modelRegistry, getApiKey } = args;
  const sumProvider = config.defaults?.summariser?.llm_provider ?? primaryProvider;
  if (!sumProvider) return { backend: undefined, label: undefined };
  const sumModel = config.defaults?.summariser?.llm_model ?? defaultSummariserModel(sumProvider);
  if (!sumModel) return { backend: undefined, label: `no default model for ${sumProvider}` };
  // Validate at boot — the summariser's resolveModel throws lazily on
  // first call, which surfaces deep inside whatever path triggered it
  // (autoTitler / fidelity=summary:* / extension tool's `ctx.summarise`)
  // and looks like a tool failure rather than a config error. Catching
  // it here gives the operator one obvious "fix this in config.jsonc"
  // line at startup. `swarm providers` lists valid ids per provider.
  if (!modelRegistry.find(sumProvider, sumModel)) {
    return {
      backend: undefined,
      label: `model "${sumProvider}/${sumModel}" not registered (run \`swarm providers\` for valid ids)`,
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

function buildAutoTitler(args: {
  store: SqliteStore;
  config: Awaited<ReturnType<typeof loadConfig>>;
  summariser: SummariserInfo;
  shutdownSignal: AbortSignal;
}): { titler: AutoTitler | undefined; label: string | undefined } {
  const { store, config, summariser, shutdownSignal } = args;
  if (config.autoTitle === false) {
    return { titler: undefined, label: "off (config)" };
  }
  if (!summariser.backend) {
    return { titler: undefined, label: summariser.label };
  }
  const titler = new AutoTitler({ backend: summariser.backend, store, shutdownSignal, enabled: true });
  return { titler, label: summariser.label };
}
