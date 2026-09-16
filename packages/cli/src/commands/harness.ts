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
  /** OS pid — matched against the `daemon_lock` row to confirm the child, not a
   *  stale predecessor, holds the lock. */
  readonly pid: number;
  readonly exited: Promise<number>;
  /** `null` while running; the exit code once exited. Bun's `Subprocess`
   *  exposes this; it is the single liveness gate on shutdown. */
  readonly exitCode: number | null;
  kill(signal?: number): void;
}

export type SpawnDaemon = (argv: string[]) => DaemonProcess;

/** Timing + wiring the supervisor needs. All fields required — production
 *  defaults live in `harnessCommand`; tests pass shortened waits directly to
 *  `superviseDaemon` so these knobs never leak onto the operator-facing
 *  `HarnessCommandOptions`. */
export interface SupervisorConfig {
  /** Store path — reopened `migrate: false` for each readiness probe. */
  dbPath: string;
  /** Bound HTTP server; `superviseDaemon` closes it (clearing
   * `server_endpoint`) when it stops. */
  serverHandle: Awaited<ReturnType<typeof startServer>>;
  /** First-restart backoff; each subsequent fast failure doubles it. */
  restartInitialBackoffMs: number;
  /** Backoff ceiling. */
  restartMaxBackoffMs: number;
  /** A daemon that stayed up at least this long resets the backoff + counter. */
  healthyResetMs: number;
  /** Consecutive fast failures before giving up and exiting non-zero. */
  maxFastFailures: number;
  /** SIGTERM→SIGKILL grace on shutdown. */
  shutdownGraceMs: number;
  /** How long the readiness gate polls `daemon_lock` for the child's pid
   *  before declaring failure. Cancellable: a shutdown mid-gate breaks the
   *  poll early rather than blocking the full deadline. */
  lockWaitMs: number;
}

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

  // 3. Hand off to the supervisor: it spawns the daemon, gates on
  //    `daemon_lock` readiness, then watches / restarts / shuts down. The
  //    server already published its `server_endpoint` row when it bound (in
  //    `startServer`); `superviseDaemon` closes the server on stop, clearing
  //    that row.
  return await superviseDaemon(spawnDaemon, daemonArgv, {
    dbPath,
    serverHandle,
    restartInitialBackoffMs: RESTART_INITIAL_BACKOFF_MS,
    restartMaxBackoffMs: RESTART_MAX_BACKOFF_MS,
    healthyResetMs: HEALTHY_RESET_MS,
    maxFastFailures: MAX_FAST_FAILURES,
    shutdownGraceMs: SHUTDOWN_GRACE_MS,
    lockWaitMs: LOCK_WAIT_MS,
  });
}

/** Spawn + supervise the daemon subprocess: gate on `daemon_lock` readiness,
 *  restart on unexpected exit with exponential backoff, give up after
 *  `maxFastFailures` consecutive fast crashes, and stop cleanly on
 *  SIGINT / SIGTERM. Resolves with the harness exit code. */
export async function superviseDaemon(spawn: SpawnDaemon, argv: string[], cfg: SupervisorConfig): Promise<number> {
  const { serverHandle } = cfg;

  // A prior harness/daemon that hard-crashed within the heartbeat TTL leaves a
  // stale `daemon_lock` row that would make this child's `acquireDaemonLock`
  // throw — the daemon only self-heals *after* the TTL. Evict it (crediting any
  // pre-crash active time to in-flight runs) so the first child acquires
  // cleanly, exactly as every restart path does.
  evictStaleLock(cfg.dbPath);

  let daemonProc = spawn(argv);
  // Initial readiness gate: report ready only once *this* child holds the lock
  // (its pid, not a stale predecessor's). `lastStart` is credited after the
  // gate so the up-to-lockWaitMs wait never counts as daemon uptime.
  const ready = await gateReady(cfg.dbPath, daemonProc.pid, cfg.lockWaitMs);
  let lastStart = Date.now();
  if (!ready) {
    console.error(chalk.red(`harness: daemon failed to acquire lock within ${cfg.lockWaitMs}ms`));
    await shutdown(daemonProc, serverHandle, cfg.shutdownGraceMs);
    return 1;
  }

  console.log("");
  console.log(chalk.green(`fragua harness ready — ${chalk.bold.underline(hyperlink(serverHandle.origin))}`));
  console.log(chalk.dim(`  api:  ${hyperlink(serverHandle.url)}`));
  console.log(chalk.dim("  press Ctrl-C to stop"));

  return await new Promise<number>((resolveExit) => {
    let stopping = false;
    let backoff = cfg.restartInitialBackoffMs;
    let fastFailures = 0;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const onSigint = () => finish("SIGINT", 0);
    const onSigterm = () => finish("SIGTERM", 0);

    const finish = (label: string, code: number) => {
      // `stopping` (not `process.removeListener`) is the double-invocation
      // barrier: a SIGINT+SIGTERM pair, or a crash racing a signal, both land
      // here — the first flips `stopping` and the rest return immediately, so
      // `shutdown` runs once. It also cancels an in-flight readiness gate.
      if (stopping) return;
      stopping = true;
      if (restartTimer) clearTimeout(restartTimer);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      console.log(chalk.dim(`\n${label} — shutting down...`));
      // `.catch` neutralises a SIGKILL-path ESRCH: `shutdown`'s `kill(9)` may
      // reject if the child exits first, and this promise is `void`-discarded,
      // so an unhandled rejection would otherwise defeat the bounded shutdown.
      void shutdown(daemonProc, serverHandle, cfg.shutdownGraceMs)
        .catch(() => {})
        .finally(() => resolveExit(code));
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    // Count one failure, then either give up or schedule a backed-off restart.
    const registerFailure = (label: string) => {
      fastFailures += 1;
      if (fastFailures >= cfg.maxFastFailures) {
        console.error(chalk.red(`harness: ${label} — ${fastFailures} fast failures in a row, giving up`));
        finish("daemon unstable", 1);
        return;
      }
      console.warn(
        chalk.yellow(`harness: ${label} — restarting in ${backoff}ms (failure ${fastFailures}/${cfg.maxFastFailures})`),
      );
      const waitMs = backoff;
      backoff = Math.min(backoff * 2, cfg.restartMaxBackoffMs);
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (stopping) return;
        restart().catch((err) => finish(`restart error: ${err}`, 1));
      }, waitMs);
    };

    const restart = async () => {
      // A hard crash never runs the daemon's `finally` lock release, so the
      // stale `daemon_lock` row survives — fresh enough (heartbeat under TTL)
      // to make the replacement's `acquireDaemonLock` throw. Evict it first so
      // the new child can take the lock cleanly.
      evictStaleLock(cfg.dbPath);
      daemonProc = spawn(argv);
      // A restarted daemon replays events + runs the startup sweep before it
      // takes the lock; re-gate on *this* child's pid so "ready" keeps meaning
      // "the daemon we just spawned is up". The gate cancels the moment
      // `stopping` flips so a SIGINT mid-restart isn't blocked on the deadline.
      const restartReady = await gateReady(cfg.dbPath, daemonProc.pid, cfg.lockWaitMs, () => stopping);
      if (stopping) return;
      if (!restartReady) {
        try {
          daemonProc.kill();
        } catch {
          /* ESRCH — already gone */
        }
        registerFailure(`daemon failed to acquire lock within ${cfg.lockWaitMs}ms on restart`);
        return;
      }
      // Credit uptime only once the gate confirms the child is up, so a failed
      // gate never advances the healthy-reset clock.
      lastStart = Date.now();
      watch(daemonProc);
    };

    const watch = (proc: DaemonProcess) => {
      proc.exited.then(
        (code) => {
          // A clean exit during shutdown must not restart.
          if (stopping) return;
          const uptime = Date.now() - lastStart;
          if (uptime >= cfg.healthyResetMs) {
            backoff = cfg.restartInitialBackoffMs;
            fastFailures = 0;
          }
          registerFailure(`daemon exited (${code})`);
        },
        (err) => finish(`daemon watch error: ${err}`, 1),
      );
    };

    watch(daemonProc);
  });
}

/** Open a short-lived `migrate: false` handle and poll `daemon_lock` until the
 *  child with `expectedPid` holds it. The daemon owns migrations; this probe
 *  must not open a second migrating handle beside it. */
async function gateReady(
  dbPath: string,
  expectedPid: number,
  lockWaitMs: number,
  shouldCancel?: () => boolean,
): Promise<boolean> {
  const lockStore = new SqliteStore({ path: dbPath, migrate: false });
  try {
    return await waitForLock(lockStore, expectedPid, lockWaitMs, shouldCancel);
  } finally {
    lockStore.close();
  }
}

/** Clear a stale `daemon_lock` row left by a hard-crashed child so the
 *  replacement daemon acquires cleanly, and run the startup sweep with the
 *  dead daemon's last heartbeat as `priorHeartbeatAt` so in-flight runs keep
 *  their pre-crash active-time credit (mirroring the server reaper). The
 *  daemon will sweep again on boot — idempotent, finding nothing left to
 *  requeue. Opened `migrate: false`: the daemon owns migrations. */
function evictStaleLock(dbPath: string): void {
  const store = new SqliteStore({ path: dbPath, migrate: false });
  try {
    const priorHeartbeatAt = store.currentDaemonLock()?.heartbeatAt;
    store.clearDaemonLock(process.pid);
    store.startupSweep(priorHeartbeatAt != null ? { priorHeartbeatAt } : undefined);
  } finally {
    store.close();
  }
}

/** OSC 8 terminal hyperlink. Modern terminals (iTerm2, macOS Terminal,
 *  kitty, wezterm, alacritty, vscode) render it as a click-target;
 *  older terminals strip the escapes and show the bare URL. */
function hyperlink(url: string, label?: string): string {
  return `\x1b]8;;${url}\x1b\\${label ?? url}\x1b]8;;\x1b\\`;
}

async function waitForLock(
  store: SqliteStore,
  expectedPid: number,
  lockWaitMs: number,
  shouldCancel?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + lockWaitMs;
  while (Date.now() < deadline) {
    if (shouldCancel?.()) return false;
    if (store.currentDaemonLock()?.pid === expectedPid) return true;
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
  // Ctrl-C — escalate to SIGKILL after `graceMs`. A daemon that already
  // exited (natural crash) is skipped via `exitCode`. Both the SIGTERM and the
  // SIGKILL escalation guard against the TOCTOU where the child exits between
  // the gate and the signal (ESRCH) — the caller `void`-discards this promise,
  // so an escaping rejection would surface as an unhandledRejection.
  if (daemonProc.exitCode === null) {
    try {
      daemonProc.kill();
    } catch {
      /* ESRCH — process already gone; fall through to close the server */
    }
    const exitedInTime = await raceExit(daemonProc.exited, graceMs);
    if (exitedInTime) {
      console.log(chalk.dim("harness: daemon stopped"));
    } else {
      console.log(chalk.dim(`harness: daemon did not stop within ${graceMs}ms — sending SIGKILL`));
      try {
        daemonProc.kill(9);
      } catch {
        /* ESRCH — the child exited between the grace timeout and the SIGKILL */
      }
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
  try {
    const timeout = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), ms);
    });
    return await Promise.race([exited.then(() => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
