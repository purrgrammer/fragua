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
import {
  defaultSummariserModel,
  firstCredentialedProvider,
  makeCodergenHandler,
  PiCodergenBackend,
  PiSummariserBackend,
} from "@swarm/agent";
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
import { ToolRegistry } from "@swarm/workspace";
import chalk from "chalk";
import { loadConfig } from "../config.ts";

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

  // Resolve provider/model. Precedence: CLI flags > .swarm/config.yaml
  // defaults > env autodetect > stub.
  const config = await loadConfig(cwd);
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
    const auto = firstCredentialedProvider();
    if (auto?.defaultModel) {
      provider = auto.name;
      model = auto.defaultModel;
      llmSource = "env";
    }
  }
  const concurrency = opts.concurrency ?? config.concurrency ?? 4;

  const useLlm = provider != null && model != null;
  let codergenFactory: Parameters<typeof autoDispatcherResolver>[0]["codergenFactory"];
  if (useLlm) {
    // `env` is wired per-run via the WorktreeProvisioner below —
    // the backend reads it off `CodergenInput` on each call, so we
    // intentionally leave `backendOpts.env` unset here.
    const backendOpts = {
      registry: new ToolRegistry(),
      defaultModel: { provider: provider!, model: model! },
    };
    // `nextNode` is intentionally NOT forwarded to makeCodergenHandler.
    // The factory receives the first outgoing edge as a legacy-compat
    // hint for tool/transition nodes, but for codergen that would force
    // every call to route to whichever edge happens to appear first in
    // the DOT — bypassing the edge selector. Real codergen nodes need
    // the selector to pick based on outcome status + condition matching
    // (e.g. `implement -> done [condition="outcome=fail"]` vs the
    // unconditional `implement -> verify`).
    codergenFactory = (node, _nextNode) => makeCodergenHandler({ node, backendOpts });
  }
  void PiCodergenBackend;
  dispatcher.setResolver(
    autoDispatcherResolver({
      store,
      ...(codergenFactory ? { codergenFactory } : {}),
    }),
  );

  const signalCtrl = new AbortController();
  const onSig = () => signalCtrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  // Auto-title summariser — cheap cross-run call that labels each run
  // post-enqueue. Uses `defaults.summariser.{provider,model}` when set;
  // otherwise defaults to the cheapest known model for the primary
  // provider. `auto_title: "off"` disables even when a backend is
  // configured.
  const autoTitler = buildAutoTitler({
    store,
    config,
    primaryProvider: provider,
    shutdownSignal: signalCtrl.signal,
  });

  // Worktree provisioner — every run gets a `git worktree` with its
  // own branch so agents never mutate the user's working copy and
  // concurrent runs don't stomp on each other. `project.bootstrap`
  // from config.yaml runs once per fresh worktree (e.g. `bun install
  // --frozen-lockfile`). Falls back to a shared LocalEnvironment if
  // the cwd isn't inside a git repo — tests + demo paths shouldn't
  // require a worktree to get off the ground.
  const provisioner: Provisioner = (await isGitRepo(cwd))
    ? new WorktreeProvisioner({
        repoRoot: cwd,
        ...(config.project?.bootstrap ? { bootstrap: config.project.bootstrap } : {}),
      })
    : new LocalEnvironmentProvisioner(cwd);
  const provisionerLabel =
    provisioner instanceof WorktreeProvisioner
      ? `worktree (.swarm/worktrees/<run-id>${config.project?.bootstrap ? `, bootstrap: "${config.project.bootstrap}"` : ""})`
      : `local (cwd=${cwd}, no git repo detected)`;

  console.log(chalk.green(`swarm daemon running`));
  console.log(chalk.dim(`  store: ${storePath}`));
  console.log(chalk.dim(`  concurrency: ${concurrency}`));
  const sourceSuffix =
    llmSource === "env" ? " (auto-detected from env)" : llmSource === "config" ? " (from .swarm/config.yaml)" : "";
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
    const handleRef = startDaemon({
      store,
      dispatcher,
      tools,
      llmCall,
      maxConcurrentRuns: concurrency,
      shutdownSignal: signalCtrl.signal,
      ...(autoTitler.titler ? { autoTitler: autoTitler.titler } : {}),
      provisioner,
    });
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

function buildAutoTitler(args: {
  store: SqliteStore;
  config: Awaited<ReturnType<typeof loadConfig>>;
  primaryProvider: string | undefined;
  shutdownSignal: AbortSignal;
}): { titler: AutoTitler | undefined; label: string | undefined } {
  const { store, config, primaryProvider, shutdownSignal } = args;
  if (config.auto_title === "off") {
    return { titler: undefined, label: "off (config)" };
  }
  const sumProvider = config.defaults?.summariser?.provider ?? primaryProvider;
  if (!sumProvider) return { titler: undefined, label: undefined };
  const sumModel = config.defaults?.summariser?.model ?? defaultSummariserModel(sumProvider);
  if (!sumModel) return { titler: undefined, label: `no default model for ${sumProvider}` };

  const backend = new PiSummariserBackend({ provider: sumProvider, model: sumModel });
  const titler = new AutoTitler({ backend, store, shutdownSignal, enabled: true });
  return { titler, label: `${sumProvider}/${sumModel}` };
}
