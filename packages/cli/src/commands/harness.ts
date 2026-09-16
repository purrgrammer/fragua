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
import { DAEMON_LOCK_TTL_MS, SqliteStore } from "@fragua/store";
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
  /** Daemon-lock heartbeat TTL. The harness will not give up on a crash loop
   *  until this window has elapsed since the first failure, so the store's
   *  unconditional TTL eviction arm gets a chance to fire even when a crashed
   *  daemon's pid was recycled by an unrelated live process. */
  lockTtlMs: number;
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
    lockTtlMs: DAEMON_LOCK_TTL_MS,
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

  return await new Promise<number>((resolveExit) => {
    // `undefined` until the first spawn — a throw in `evictStaleLock`/`spawn`
    // before it is set must still reach `shutdown` (which tolerates it) so the
    // server is closed and `server_endpoint` cleared.
    let daemonProc: DaemonProcess | undefined;
    let lastStart = Date.now();
    let stopping = false;
    let backoff = cfg.restartInitialBackoffMs;
    let fastFailures = 0;
    let firstFailureAt: number | undefined;
    let firstReady = false;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    // Per-spawn outcome, so the readiness gate and the exit watcher can't both
    // account for the same attempt: `pending` until either the gate confirms
    // readiness (`ready`) or the boot fails (`failed`, from a gate timeout or a
    // crash mid-gate). Only a `ready` daemon's later exit runs the restart
    // path; a `failed` attempt's `exited` (e.g. from our own kill) is ignored.
    type Attempt = { state: "pending" | "ready" | "failed" };

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

    // Count one failure, then either give up or schedule a backed-off restart.
    const registerFailure = (label: string) => {
      fastFailures += 1;
      firstFailureAt ??= Date.now();
      // Don't give up until BOTH the fast-failure count is exhausted AND the
      // lock TTL window has elapsed since the first failure. A crashed daemon
      // whose pid was recycled by a live process reads as "alive" to the
      // liveness probe, so eviction only happens once the heartbeat crosses
      // `lockTtlMs` — giving up before then would strand the stale lock the
      // TTL arm is about to clear.
      const windowElapsed = Date.now() - firstFailureAt;
      if (fastFailures >= cfg.maxFastFailures && windowElapsed >= cfg.lockTtlMs) {
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
        bootOrRestart().catch((err) => finish(`restart error: ${err}`, 1));
      }, waitMs);
    };

    // Spawn (or respawn) the daemon and gate on *this* child's pid. The exit
    // watcher is attached BEFORE the gate so a boot-time crash (the daemon
    // releasing its lock in `finally` before the gate times out) routes through
    // `registerFailure` with backoff instead of falling through to a bare
    // exit 1. A hard crash never runs the daemon's lock release, so the stale
    // row survives; `evictStaleLock` clears it (TTL/liveness-gated, sweep
    // first) so the new child acquires cleanly.
    const bootOrRestart = async () => {
      evictStaleLock(cfg.dbPath);
      const proc = spawn(argv);
      daemonProc = proc;
      const current: Attempt = { state: "pending" };
      watch(proc, current);
      const ready = await gateReady(cfg.dbPath, proc.pid, cfg.lockWaitMs, () => stopping);
      // A mid-gate crash already flipped this attempt to `failed` (and counted
      // the failure); don't double-count it here.
      if (stopping || current.state !== "pending") return;
      if (!ready) {
        current.state = "failed";
        try {
          proc.kill();
        } catch {
          /* ESRCH — already gone */
        }
        registerFailure(`daemon failed to acquire lock within ${cfg.lockWaitMs}ms`);
        return;
      }
      current.state = "ready";
      // Credit uptime only once the gate confirms the child is up, so a failed
      // gate never advances the healthy-reset clock.
      lastStart = Date.now();
      if (!firstReady) {
        firstReady = true;
        console.log("");
        console.log(chalk.green(`fragua harness ready — ${chalk.bold.underline(hyperlink(serverHandle.origin))}`));
        console.log(chalk.dim(`  api:  ${hyperlink(serverHandle.url)}`));
        console.log(chalk.dim("  press Ctrl-C to stop"));
      }
    };

    const watch = (proc: DaemonProcess, current: Attempt) => {
      proc.exited.then(
        (code) => {
          // A clean exit during shutdown must not restart.
          if (stopping) return;
          // Already accounted (a failed gate killed this proc): ignore its exit.
          if (current.state === "failed") return;
          if (current.state === "pending") {
            // Crash during boot, before the gate settled: claim the attempt so
            // the gate skips it, and retry with backoff (no healthy-reset — the
            // daemon never came up).
            current.state = "failed";
            registerFailure(`daemon exited during boot (${code})`);
            return;
          }
          // A `ready` daemon crashed: honour the healthy-uptime reset.
          const uptime = Date.now() - lastStart;
          if (uptime >= cfg.healthyResetMs) {
            backoff = cfg.restartInitialBackoffMs;
            fastFailures = 0;
            firstFailureAt = undefined;
          }
          registerFailure(`daemon exited (${code})`);
        },
        (err) => finish(`daemon watch error: ${err}`, 1),
      );
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    // Initial boot shares the restart path, so `evictStaleLock`/`spawn` throws
    // land in the same error handler as the supervisor body: close the server
    // (clearing `server_endpoint`) and resolve the harness exit code instead of
    // leaking the exception past the ready gate.
    bootOrRestart().catch((err) => {
      console.error(chalk.red(`harness: daemon boot failed — ${err}`));
      finish("daemon boot error", 1);
    });
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

/** `process.kill(pid, 0)` liveness probe: send no signal, just test whether the
 *  pid is reachable. `ESRCH` → the process is gone (`"dead"`); a successful
 *  probe → `"alive"`; `EPERM` → the pid exists but belongs to another user, so
 *  we can't attribute it to our crashed daemon (a recycled pid is common in
 *  small PID namespaces) — `"unknown"`, decided by the TTL instead. Any other
 *  error is treated as `"dead"`. */
function probePidState(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" ? "unknown" : "dead";
  }
}

/** Liveness adapter for `evictDaemonLockIfStale`: only a provably-dead pid
 *  (`"dead"`) accelerates eviction of a still-fresh lock. `"alive"` and
 *  `"unknown"` both defer to the store's TTL arm — an EPERM pid is never
 *  asserted alive, but nor is a possibly-live daemon evicted early. */
function pidHolderAlive(pid: number): boolean {
  return probePidState(pid) !== "dead";
}

/** Evict a stale `daemon_lock` row left by a hard-crashed child so the
 *  replacement daemon acquires cleanly — but ONLY when the holder is provably
 *  gone: its heartbeat is past `DAEMON_LOCK_TTL_MS`, or `kill(pid, 0)` reports
 *  the pid dead. A live daemon (fresh heartbeat + reachable pid), including an
 *  orphan from a SIGKILLed sibling harness, is left untouched so the
 *  replacement can't acquire the lock beside it and violate single-writer.
 *  On eviction the startup sweep runs FIRST (crediting the dead daemon's last
 *  heartbeat as `priorHeartbeatAt` so in-flight runs keep their pre-crash
 *  active-time credit), THEN the row is deleted — mirroring the server reaper.
 *  Opened `migrate: false`: the daemon owns migrations. Exported for tests to
 *  drive both the TTL arm and the dead-pid arm deterministically. */
export function evictStaleLock(
  dbPath: string,
  opts?: { now?: () => number; isPidAlive?: (pid: number) => boolean },
): void {
  const isPidAlive = opts?.isPidAlive ?? pidHolderAlive;
  const store = new SqliteStore({ path: dbPath, migrate: false });
  try {
    store.evictDaemonLockIfStale({
      ttlMs: DAEMON_LOCK_TTL_MS,
      ...(opts?.now ? { now: opts.now } : {}),
      isHolderAlive: (lock) => isPidAlive(lock.pid),
    });
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
  daemonProc: DaemonProcess | undefined,
  serverHandle: Awaited<ReturnType<typeof startServer>>,
  graceMs: number,
): Promise<void> {
  // Stop daemon child. SIGTERM triggers its graceful shutdown (lock
  // release, sweep state). Bound the wait: a hung daemon must not hang
  // Ctrl-C — escalate to SIGKILL after `graceMs`. A daemon that already
  // exited (natural crash), or was never spawned (a pre-gate boot throw), is
  // skipped. Both the SIGTERM and the SIGKILL escalation guard against the
  // TOCTOU where the child exits between the gate and the signal (ESRCH) — the
  // caller `void`-discards this promise, so an escaping rejection would surface
  // as an unhandledRejection.
  if (daemonProc != null && daemonProc.exitCode === null) {
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
      // Bound the post-SIGKILL wait too: a child wedged in uninterruptible
      // D-state (NFS / block-device I/O) never reaps even on SIGKILL, and an
      // unbounded await here would hang Ctrl-C forever — the exact failure the
      // SIGTERM bound above guards against. Abandon the wait and close the
      // server regardless.
      const reaped = await raceExit(daemonProc.exited, graceMs);
      if (!reaped) {
        console.log(chalk.dim(`harness: daemon did not exit after SIGKILL within ${graceMs}ms — abandoning wait`));
      }
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
