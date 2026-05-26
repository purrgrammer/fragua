// `fragua daemon` — run the packages/daemon process against the local store.
//
// Out of the box the daemon uses a stub LLM. Pass `--provider` +
// `--model` (or omit both for the defaults) and the auto-dispatcher
// routes every `llm` node through a PiLlmBackend so real LLM calls
// fire. Handlers of other kinds (start, exit, tool, human) stay on
// the trivial transitions.

import { mkdirSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, resolve } from "node:path";
import { parseDurationMs } from "@fragua/core";
import { AutoTitler, type Provisioner, startDaemon, WorktreeProvisioner } from "@fragua/daemon";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";
import { loadConfig, resolveProjectBootstrap, resolveTimeouts } from "../config.ts";
import { buildExecutorDeps, type SummariserInfo } from "../executor-deps.ts";

/**
 * Poll interval for `fragua daemon stop` — how often we check whether
 * the lock row has cleared after SIGTERM. Kept small so the CLI feels
 * responsive; the 10s timeout is enforced by a separate deadline.
 */
const STOP_POLL_MS = 100;
const STOP_TIMEOUT_MS = 10_000;

/**
 * `fragua daemon stop` — SIGTERM the daemon identified by the
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
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".fragua/fragua.db");
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
  /** Explicit store path. Overrides `<cwd>/.fragua/fragua.db`. */
  dbPath?: string;
  /** Max concurrent runs. Default 4. */
  concurrency?: number;
  /** LLM provider override. When set with `model`, enables the real llm path. */
  provider?: string;
  /** LLM model id. */
  model?: string;
}

export async function daemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".fragua/fragua.db");
  mkdirSync(dirname(storePath), { recursive: true });

  const store = new SqliteStore({ path: storePath });

  const config = await loadConfig(cwd);
  let timeouts: ReturnType<typeof resolveTimeouts>;
  try {
    timeouts = resolveTimeouts(config);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    return 1;
  }
  const concurrency = opts.concurrency ?? config.concurrency ?? 16;

  const signalCtrl = new AbortController();
  const onSig = () => signalCtrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  // The shared executor assembly: dispatcher + auto-dispatcher resolver
  // (the real llm path — tool registry, backend opts, per-node codergen
  // factory), graph loader, credential/model registries, summariser, and
  // skills discovery. `fragua ci` builds the same deps from the same factory
  // so the two embedded-executor callers can't drift. The daemon owns what
  // genuinely differs: the worktree provisioner, the auto-titler, and the
  // long-running poll/claim/drain loop below.
  const deps = await buildExecutorDeps({
    store,
    cwd,
    config,
    timeouts,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });

  // Auto-title summariser — cheap cross-run call that labels each run
  // post-enqueue. Uses `summariser.{provider,model}` when set;
  // otherwise defaults to the cheapest known model for the
  // primary provider. `auto-title: false` disables even when a backend
  // is configured.
  const autoTitler = buildAutoTitler({
    store,
    config,
    summariser: deps.summariser,
    shutdownSignal: signalCtrl.signal,
  });

  // Worktree provisioner — every run gets a `git worktree` with its
  // own branch so agents never mutate the user's working copy and
  // concurrent runs don't stomp on each other. Bootstrap is
  // **resolved per run** against the run's project root via
  // `loadProjectConfig(<run.cwd>)` — so one daemon can serve runs
  // from many projects, each picking up its own
  // `.fragua/config.yaml` `bootstrap` field. No global / no
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
  const provisioner: Provisioner = new WorktreeProvisioner({
    resolveRunBootstrap: resolveProjectBootstrap,
    ...(timeouts.shell !== undefined ? { defaultShellTimeoutMs: timeouts.shell } : {}),
  });
  const provisionerLabel =
    `worktree per-run when run cwd is a git repo, else LocalEnvironment rooted at run cwd ` +
    `(bootstrap: per-run from <project>/.fragua/config.yaml)`;

  console.log(chalk.green(`fragua daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${concurrency}`));
  const sourceSuffix =
    deps.llm.source === "env"
      ? " (auto-detected from env)"
      : deps.llm.source === "config"
        ? " (from .fragua/config.yaml)"
        : "";
  const llmLabel = deps.llm.useLlm
    ? `${deps.llm.provider}/${deps.llm.model}${sourceSuffix}`
    : "stub (set a provider API key, or pass --provider + --model)";
  console.log(chalk.dim(`  llm default: ${llmLabel}`));
  if (deps.llm.useLlm) {
    console.log(chalk.dim(`  nodes can override via \`provider=\`/\`model=\` attrs`));
  }
  // Explicit summariser line so operators see the wired model. When
  // `buildSummariserBackend` rejected the configured model at validation
  // (model not registered / no default for provider), `deps.summariser.backend`
  // is undefined and the label carries the rejection reason — surface it
  // loudly so the operator updates `.fragua/config.yaml` rather than
  // chasing the failure at runtime.
  if (deps.summariser.backend) {
    console.log(chalk.dim(`  summariser: ${deps.summariser.label}`));
  } else if (deps.summariser.label) {
    console.log(chalk.yellow(`  summariser: disabled — ${deps.summariser.label}`));
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
      dispatcher: deps.dispatcher,
      tools: deps.tools,
      llmCall: deps.llmCall,
      maxConcurrentRuns: concurrency,
      shutdownSignal: signalCtrl.signal,
      provisioner,
      graphLoader: deps.graphLoader,
    };
    if (autoTitler.titler) daemonOpts.autoTitler = autoTitler.titler;
    if (timeouts.leakGrace !== undefined) daemonOpts.leakGraceMs = timeouts.leakGrace;
    if (timeouts.shutdownDrain !== undefined) daemonOpts.shutdownDrainMs = timeouts.shutdownDrain;
    if (timeouts.http !== undefined) daemonOpts.defaultHttpTimeoutMs = timeouts.http;
    if (config["max-loops"] !== undefined) daemonOpts.maxLoops = config["max-loops"];
    if (config["abort-loop-ceiling"] !== undefined) daemonOpts.abortLoopCeiling = config["abort-loop-ceiling"];
    if (config["max-leaked-handlers"] !== undefined) daemonOpts.maxLeakedHandlers = config["max-leaked-handlers"];
    if (config["blob-gc"]?.interval !== undefined) {
      try {
        daemonOpts.blobGcIntervalMs = parseDurationMs(config["blob-gc"].interval);
      } catch (err) {
        console.error(chalk.red(`config: blob-gc.interval: ${(err as Error).message}`));
        return 1;
      }
    }
    if (config["blob-gc"]?.["max-rows"] !== undefined) daemonOpts.blobGcMaxRows = config["blob-gc"]["max-rows"];
    if (deps.steeringRegistry !== undefined) {
      const reg = deps.steeringRegistry;
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

function buildAutoTitler(args: {
  store: SqliteStore;
  config: Awaited<ReturnType<typeof loadConfig>>;
  summariser: SummariserInfo;
  shutdownSignal: AbortSignal;
}): { titler: AutoTitler | undefined; label: string | undefined } {
  const { store, config, summariser, shutdownSignal } = args;
  if (config["auto-title"] === false) {
    return { titler: undefined, label: "off (config)" };
  }
  if (!summariser.backend) {
    return { titler: undefined, label: summariser.label };
  }
  const titler = new AutoTitler({ backend: summariser.backend, store, shutdownSignal, enabled: true });
  return { titler, label: summariser.label };
}
