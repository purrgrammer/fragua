// `swarm daemon` — run the packages/daemon process against the local store.
//
// Out of the box the daemon uses a stub LLM. Pass `--provider` + `--model`
// (or omit both for the defaults) and the auto-dispatcher routes every
// `box` node through a PiCodergenBackend so real LLM calls fire. Handlers
// of other shapes (Mdiamond start, Msquare exit, hexagon wait.human, etc.)
// stay on the trivial transitions.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { hostname as osHostname } from "node:os";
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
} from "@swarm/agent";
import { parseDurationMs } from "@swarm/core";
import * as handler from "@swarm/core/handler";
import {
  AutoTitler,
  autoDispatcherResolver,
  Dispatcher,
  LocalEnvironmentProvisioner,
  type Provisioner,
  startDaemon,
  WorktreeProvisioner,
} from "@swarm/daemon";
import { SqliteStore } from "@swarm/store";
import { CORE_TOOLS, ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";
import { loadConfig, resolveTimeouts } from "../config.ts";

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
  /** LLM provider. When set with `--model`, enables the real codergen path. */
  provider?: string;
  /** Model id. */
  model?: string;
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

  // Resolve provider/model. Precedence: CLI flags > .swarm/config.jsonc
  // defaults > env autodetect > stub.
  const config = await loadConfig(cwd);
  let timeouts: ReturnType<typeof resolveTimeouts>;
  try {
    timeouts = resolveTimeouts(config);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    return 1;
  }
  const cfgProvider = config.defaults?.provider;
  const cfgModel = config.defaults?.model;
  let provider = opts.provider;
  let model = opts.model;
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

  const useLlm = provider != null && model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
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
      ...(summariserInfo.backend ? { summariser: summariserInfo.backend } : {}),
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
      return makeCodergenHandler(factoryOpts);
    };
  }
  void PiCodergenBackend;
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
  // post-enqueue. Uses `defaults.summariser.{provider,model}` when set;
  // otherwise defaults to the cheapest known model for the primary
  // provider. `autoTitle: false` disables even when a backend is
  // configured.
  const autoTitler = buildAutoTitler({
    store,
    config,
    summariser: summariserInfo,
    shutdownSignal: signalCtrl.signal,
  });

  // Worktree provisioner — every run gets a `git worktree` with its
  // own branch so agents never mutate the user's working copy and
  // concurrent runs don't stomp on each other. `bootstrap` from
  // config.jsonc runs once per fresh worktree (e.g. `bun install
  // --frozen-lockfile`). Falls back to a shared LocalEnvironment if
  // the cwd isn't inside a git repo — tests + demo paths shouldn't
  // require a worktree to get off the ground.
  const provisioner: Provisioner = (await isGitRepo(cwd))
    ? new WorktreeProvisioner({
        repoRoot: cwd,
        ...(config.bootstrap ? { bootstrap: config.bootstrap } : {}),
        ...(timeouts.bootstrap !== undefined ? { bootstrapTimeoutMs: timeouts.bootstrap } : {}),
        ...(timeouts.shell !== undefined ? { defaultShellTimeoutMs: timeouts.shell } : {}),
      })
    : new LocalEnvironmentProvisioner(
        cwd,
        timeouts.shell !== undefined ? { defaultShellTimeoutMs: timeouts.shell } : {},
      );
  const provisionerLabel =
    provisioner instanceof WorktreeProvisioner
      ? `worktree (.swarm/worktrees/<run-id>${config.bootstrap ? `, bootstrap: "${config.bootstrap}"` : ""})`
      : `local (cwd=${cwd}, no git repo detected)`;

  console.log(chalk.green(`swarm daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${concurrency}`));
  const sourceSuffix =
    llmSource === "env" ? " (auto-detected from env)" : llmSource === "config" ? " (from .swarm/config.jsonc)" : "";
  const llmLabel = useLlm
    ? `${provider}/${model}${sourceSuffix}`
    : "stub (set a provider API key, or pass --provider + --model)";
  console.log(chalk.dim(`  llm default: ${llmLabel}`));
  if (useLlm) {
    console.log(chalk.dim(`  nodes can override via \`provider=\`/\`model=\` attrs`));
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

/** Cheap `git rev-parse --is-inside-work-tree` check. Non-git cwds
 * fall back to a LocalEnvironmentProvisioner so test suites / demo
 * runs don't require a repo. */
function isGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("close", (code) => resolvePromise(code === 0));
    child.on("error", () => resolvePromise(false));
  });
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
  const sumProvider = config.defaults?.summariser?.provider ?? primaryProvider;
  if (!sumProvider) return { backend: undefined, label: undefined };
  const sumModel = config.defaults?.summariser?.model ?? defaultSummariserModel(sumProvider);
  if (!sumModel) return { backend: undefined, label: `no default model for ${sumProvider}` };
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
