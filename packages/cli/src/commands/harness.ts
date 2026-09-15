// `fragua harness` — supervise the executor daemon + HTTP server as a single
// foreground process. Discovery via the DB itself: `startServer` publishes the
// URL onto the store's `server_endpoint` row so CLI invocations from any cwd
// find it without a JSON file.
//
// Topology:
//   - HTTP server runs in-process via `startServer` (cheap). It writes
//     `server_endpoint` on bind and clears it on close.
//   - Executor daemon runs as a `fragua daemon start --db <path>` subprocess
//     so we don't have to re-implement its 200-line setup. The subprocess
//     inherits stdio for visibility.
//   - Both share `~/.fragua/fragua.db` (override with --db). SQLite WAL
//     handles concurrent connections.
//
// Lifecycle:
//   1. Bind the HTTP server at port 0 (ephemeral) or --port <n>. startServer
//      publishes `server_endpoint` — a row independent of the daemon lock, so
//      the daemon's lock insert/release can never clobber it (no re-assert loop).
//   2. Spawn `fragua daemon start --db <path>`. The daemon acquires
//      daemon_lock as part of its boot.
//   3. Wait for the lock row to appear (poll up to LOCK_WAIT_MS) for readiness.
//   4. Supervise: an unexpected daemon exit triggers a restart with exponential
//      backoff (RESTART_INITIAL_BACKOFF_MS doubling to RESTART_MAX_BACKOFF_MS,
//      reset after HEALTHY_RESET_MS of uptime); MAX_FAST_FAILURES consecutive
//      fast crashes give up and stop the harness non-zero. Block on
//      SIGINT / SIGTERM otherwise.
//   5. On shutdown: SIGTERM the daemon, wait up to SHUTDOWN_GRACE_MS, then
//      SIGKILL; `serverHandle.close()` clears `server_endpoint` and stops the
//      HTTP server.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";
import { startUpdateNotice } from "../update-notice.ts";
import { FRAGUA_VERSION } from "../version.ts";
import { EMBEDDED_WEB_ASSETS } from "../web-assets.ts";
import { ensureWebBundle } from "../web-build.ts";
import { startServer } from "./serve.ts";

const COMPILED = Object.keys(EMBEDDED_WEB_ASSETS).length > 0;

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

/** First restart waits this long; each subsequent fast failure doubles it. */
const RESTART_INITIAL_BACKOFF_MS = 500;
/** Backoff ceiling — restarts never wait longer than this. */
const RESTART_MAX_BACKOFF_MS = 30_000;
/** A daemon that stayed up at least this long is "healthy": the backoff and
 *  fast-failure counter reset on its next exit. */
const HEALTHY_RESET_MS = 60_000;
/** Consecutive fast crashes before the harness gives up and exits non-zero. */
const MAX_FAST_FAILURES = 5;
/** Grace period after SIGTERM before the daemon is SIGKILLed on shutdown. */
const SHUTDOWN_GRACE_MS = 5_000;

/** The subset of a spawned daemon process the supervisor drives. Bun's
 *  `Subprocess` satisfies it; tests inject a fake via `spawn`. */
export interface DaemonProcess {
  readonly exited: Promise<number>;
  readonly killed: boolean;
  kill(signal?: number): void;
}

export type SpawnDaemon = (argv: string[]) => DaemonProcess;

export interface HarnessCommandOptions {
  /** Store path. Default `~/.fragua/fragua.db`. */
  dbPath?: string;
  /** TCP port for the HTTP server. When omitted, `startServer` resolves
   * via `web.port` from `~/.fragua/config.yaml`, then `DEFAULT_WEB_PORT`
   * (6767). Pass 0 for an ephemeral bind. */
  port?: number;
  /** Spawn seam for the daemon subprocess. Defaults to `Bun.spawn` with
   * inherited stdio; injected by tests to simulate crashes / hung shutdown. */
  spawn?: SpawnDaemon;
  /** First-restart backoff. Default RESTART_INITIAL_BACKOFF_MS (500ms). */
  restartInitialBackoffMs?: number;
  /** Backoff ceiling. Default RESTART_MAX_BACKOFF_MS (30s). */
  restartMaxBackoffMs?: number;
  /** Healthy-uptime threshold that resets the backoff. Default HEALTHY_RESET_MS (60s). */
  healthyResetMs?: number;
  /** Consecutive fast crashes before giving up. Default MAX_FAST_FAILURES (5). */
  maxFastFailures?: number;
  /** SIGTERM→SIGKILL grace on shutdown. Default SHUTDOWN_GRACE_MS (5s). */
  shutdownGraceMs?: number;
}

export async function harnessCommand(opts: HarnessCommandOptions = {}): Promise<number> {
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolve(homedir(), ".fragua/fragua.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  console.log(chalk.green("fragua harness starting"));
  console.log(chalk.dim(`  store: ${dbPath}`));

  // Best-effort "new version available" notice. Detached + not awaited so it
  // can never delay startup; prints at most one dim line later, or nothing.
  startUpdateNotice();

  // Build / refresh the web bundle before binding so the moment the URL
  // prints, the latest UI is what gets served. Compiled binary: the
  // bundle is embedded — skip the vite spawn entirely (there's no source
  // tree to read from anyway). Dev / source install: skipped
  // automatically for production installs (no src/) and FRAGUA_NO_WEB_BUILD=1.
  const webDistDir = COMPILED ? undefined : (await ensureWebBundle()).distDir;

  // 1. HTTP server (in-process). Binds before the daemon spawns so the
  //    URL is ready to publish the moment the daemon takes the lock.
  //    Port resolution lives in startServer: `--port` (when set) >
  //    `web.port` from ~/.fragua/config.yaml > DEFAULT_WEB_PORT (6767).
  let serverHandle: Awaited<ReturnType<typeof startServer>>;
  try {
    const startOpts: Parameters<typeof startServer>[0] = { dbPath, webDistDir, version: FRAGUA_VERSION };
    if (opts.port !== undefined) startOpts.port = opts.port;
    serverHandle = await startServer(startOpts);
  } catch (err) {
    console.error(chalk.red(`harness: failed to bind HTTP — ${(err as Error).message}`));
    return 1;
  }

  // 2. Daemon subprocess. `fragua daemon start --db <path>` does its own
  //    setup; we just spawn + monitor. Compiled binary: re-invoke
  //    ourselves (`process.execPath`) with no script arg — the entry is
  //    the binary itself. Dev: re-invoke `bun <argv[1]>` so the daemon
  //    runs from the same source tree.
  const daemonArgv = COMPILED
    ? [process.execPath, "daemon", "start", "--db", dbPath]
    : [process.execPath, process.argv[1]!, "daemon", "start", "--db", dbPath];
  const spawnDaemon: SpawnDaemon =
    opts.spawn ?? ((argv) => Bun.spawn(argv, { stdio: ["ignore", "inherit", "inherit"] }));
  let daemonProc = spawnDaemon(daemonArgv);

  // 3. Wait for daemon_lock to appear (daemon's startup acquires it). The
  //    daemon owns migrations; this readiness probe must not open a second
  //    migrating handle beside it — `migrate: false`.
  const lockStore = new SqliteStore({ path: dbPath, migrate: false });
  const lockAcquired = await waitForLock(lockStore);
  if (!lockAcquired) {
    console.error(chalk.red(`harness: daemon failed to acquire lock within ${LOCK_WAIT_MS}ms`));
    daemonProc.kill();
    lockStore.close();
    await serverHandle.close();
    return 1;
  }

  // 4. The server already published its `server_endpoint` row when it bound
  //    (in `startServer`). That row is independent of the daemon lock, so the
  //    daemon's lock insert/release can't clobber it — no re-assert loop, and
  //    `serverHandle.close()` clears it on shutdown.
  lockStore.close();

  console.log("");
  console.log(chalk.green(`fragua harness ready — ${chalk.bold.underline(hyperlink(serverHandle.origin))}`));
  console.log(chalk.dim(`  api:  ${hyperlink(serverHandle.url)}`));
  console.log(chalk.dim("  press Ctrl-C to stop"));

  // 5. Supervise + block until shutdown.
  const initialBackoff = opts.restartInitialBackoffMs ?? RESTART_INITIAL_BACKOFF_MS;
  const maxBackoff = opts.restartMaxBackoffMs ?? RESTART_MAX_BACKOFF_MS;
  const healthyResetMs = opts.healthyResetMs ?? HEALTHY_RESET_MS;
  const maxFastFailures = opts.maxFastFailures ?? MAX_FAST_FAILURES;
  const shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;

  return await new Promise<number>((resolveExit) => {
    let stopping = false;
    let backoff = initialBackoff;
    let fastFailures = 0;
    let lastStart = Date.now();

    const finish = (label: string, code: number) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${label} — shutting down...`));
      void shutdown(daemonProc, serverHandle, shutdownGraceMs).finally(() => resolveExit(code));
    };

    process.once("SIGINT", () => finish("SIGINT", 0));
    process.once("SIGTERM", () => finish("SIGTERM", 0));

    const watch = (proc: DaemonProcess) => {
      proc.exited.then((code) => {
        // A clean exit during shutdown must not restart.
        if (stopping) return;

        const uptime = Date.now() - lastStart;
        if (uptime >= healthyResetMs) {
          backoff = initialBackoff;
          fastFailures = 0;
        }
        fastFailures += 1;

        if (fastFailures >= maxFastFailures) {
          console.error(
            chalk.red(`harness: daemon exited (${code}) — ${fastFailures} fast failures in a row, giving up`),
          );
          finish("daemon unstable", 1);
          return;
        }

        console.warn(
          chalk.yellow(
            `harness: daemon exited (${code}) — restarting in ${backoff}ms (failure ${fastFailures}/${maxFastFailures})`,
          ),
        );
        const nextBackoff = Math.min(backoff * 2, maxBackoff);
        setTimeout(() => {
          if (stopping) return;
          lastStart = Date.now();
          daemonProc = spawnDaemon(daemonArgv);
          backoff = nextBackoff;
          watch(daemonProc);
        }, backoff);
      });
    };

    watch(daemonProc);
  });
}

/** OSC 8 terminal hyperlink. Modern terminals (iTerm2, macOS Terminal,
 *  kitty, wezterm, alacritty, vscode) render it as a click-target;
 *  older terminals strip the escapes and show the bare URL. */
function hyperlink(url: string, label?: string): string {
  return `\x1b]8;;${url}\x1b\\${label ?? url}\x1b]8;;\x1b\\`;
}

async function waitForLock(store: SqliteStore): Promise<boolean> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    if (store.currentDaemonLock() != null) return true;
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  return false;
}

async function shutdown(
  daemonProc: DaemonProcess,
  serverHandle: Awaited<ReturnType<typeof startServer>>,
  graceMs: number,
): Promise<void> {
  // Stop daemon child. SIGTERM triggers its graceful shutdown (lock
  // release, sweep state). Bound the wait: a hung daemon must not hang
  // Ctrl-C — escalate to SIGKILL after `graceMs`.
  if (!daemonProc.killed) {
    daemonProc.kill();
    const exitedInTime = await raceExit(daemonProc.exited, graceMs);
    if (exitedInTime) {
      console.log(chalk.dim("harness: daemon stopped"));
    } else {
      console.log(chalk.dim(`harness: daemon did not stop within ${graceMs}ms — sending SIGKILL`));
      daemonProc.kill(9);
      await daemonProc.exited;
    }
  }

  // Stop HTTP server.
  try {
    await serverHandle.close();
  } catch (err) {
    console.error(chalk.dim(`harness: server close failed — ${(err as Error).message}`));
  }
}

/** Resolve `true` if `exited` settles within `ms`, `false` on timeout. */
async function raceExit(exited: Promise<number>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  const result = await Promise.race([exited.then(() => true), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
