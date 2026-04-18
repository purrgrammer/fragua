// `swarm daemon {start,stop,status,__daemon-run}` — lifecycle of the long-lived
// HTTP supervisor. The daemon hosts the same server as `swarm serve` plus
// a job queue + process supervisor (later phases).
//
// File layout lives under `.swarm/daemon/`:
//   daemon.json   — rendezvous written by __daemon-run, read by start/stop/status
//   daemon.log    — stdout/stderr of the detached child (no rotation yet)
//
// Command contract:
//   start [--foreground] [--port N]
//       Default: detaches a child that runs `__daemon-run` and returns
//       after the rendezvous file appears and `/health` responds.
//       `--foreground` runs the daemon body in-process for debugging.
//   stop [--grace N]
//       Reads rendezvous → SIGTERM the pid → polls until it dies or the
//       grace window expires → SIGKILL → cleans up stale rendezvous.
//   status
//       Prints JSON describing the current state. Non-zero exit when
//       not running, so scripts can branch on $?.
//   __daemon-run
//       Internal. Invoked only by `start` (detached) or by `start
//       --foreground` (same process). Binds the HTTP server, writes
//       rendezvous, waits for SIGTERM/SIGINT, cleans up.

import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve as resolvePath, join } from "node:path";
import {
  createLocalProcessSupervisor,
  createSqliteJobQueue,
  getDaemonDir,
  isPidAlive,
  readRendezvous,
  removeRendezvous,
  startScheduler,
  writeRendezvous,
} from "@swarm/server";
import type { HealthDaemonInfo, JobQueue, ProcessSupervisor, SchedulerHandle } from "@swarm/server";
import chalk from "chalk";
import { startServer } from "./serve.ts";

/** Global concurrency cap. Phase 4 will source this from
 * `.swarm/config.yaml`; for now a sensible default. */
const DEFAULT_CONCURRENCY = 2;

/** Bumped manually when the rendezvous shape or daemon protocol changes. */
const DAEMON_VERSION = "0.0.0";

/** Default port for the daemon's HTTP surface. Picked high enough to avoid
 * clashing with common dev servers; 0 (ephemeral) is also supported. */
const DEFAULT_DAEMON_PORT = 3737;

/** How long `start` waits for the child to publish its rendezvous. */
const START_HANDSHAKE_TIMEOUT_MS = 5_000;
/** How long `stop` waits for SIGTERM to take effect before SIGKILL. */
const DEFAULT_STOP_GRACE_MS = 10_000;

export interface DaemonCommandBaseOptions {
  /** Project root — defaults to `process.cwd()`. */
  cwd?: string;
}

export interface DaemonStartOptions extends DaemonCommandBaseOptions {
  /** Port to bind. Defaults to `DEFAULT_DAEMON_PORT`. 0 picks ephemeral. */
  port?: number;
  /** Run the daemon body in-process instead of detaching. */
  foreground?: boolean;
  /** Runs directory passed through to the server (default `.swarm/runs`). */
  runsDir?: string;
}

export interface DaemonStopOptions extends DaemonCommandBaseOptions {
  /** Grace period in milliseconds before SIGKILL. Default 10s. */
  graceMs?: number;
}

export interface DaemonRunOptions extends DaemonCommandBaseOptions {
  port?: number;
  runsDir?: string;
}

// ---------------------------------------------------------------------------
// swarm daemon start
// ---------------------------------------------------------------------------

export async function daemonStartCommand(opts: DaemonStartOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const port = opts.port ?? DEFAULT_DAEMON_PORT;

  // Already running? Print its rendezvous and exit 0 (idempotent).
  const existing = await readRendezvous(cwd);
  if (existing && isPidAlive(existing.pid)) {
    console.log(chalk.green(`swarm daemon already running`));
    console.log(chalk.dim(`  pid:  ${existing.pid}`));
    console.log(chalk.dim(`  port: ${existing.port}`));
    return 0;
  }
  if (existing) {
    // Stale rendezvous — pid is dead. Remove it before starting fresh.
    console.log(chalk.yellow(`swarm daemon: removing stale rendezvous (pid ${existing.pid} not alive)`));
    await removeRendezvous(cwd);
  }

  if (opts.foreground) {
    return daemonRunCommand({
      cwd,
      port,
      ...(opts.runsDir !== undefined ? { runsDir: opts.runsDir } : {}),
    });
  }

  // Detached mode. Spawn the same binary with `__daemon-run` and wait for
  // its rendezvous to appear. Stdout/stderr go to daemon.log; stdin is
  // ignored. Without `.unref()` the parent keeps a handle to the child
  // and refuses to exit until it does.
  const daemonDir = getDaemonDir(cwd);
  await mkdir(daemonDir, { recursive: true });
  const logFd = openSync(`${daemonDir}/daemon.log`, "a");

  const argv0 = process.argv[0];
  const script = process.argv[1];
  if (argv0 === undefined || script === undefined) {
    console.error(chalk.red("swarm daemon: cannot determine interpreter path — refusing to detach"));
    return 1;
  }

  const childArgs = [
    script,
    "__daemon-run",
    "--cwd",
    cwd,
    "--port",
    String(port),
    ...(opts.runsDir !== undefined ? ["--runs-dir", opts.runsDir] : []),
  ];

  const child = Bun.spawn([argv0, ...childArgs], {
    cwd,
    stdin: "ignore",
    stdout: logFd,
    stderr: logFd,
    // Detach so the child outlives the parent.
    env: { ...process.env, SWARM_DAEMON_CHILD: "1" },
  });
  // The returned Bun subprocess handle keeps the event loop alive; unref
  // lets the parent exit cleanly once rendezvous is detected.
  (child as { unref?: () => void }).unref?.();

  // Poll for rendezvous to appear AND for /health to respond. Fall back
  // to a failure message if the child dies before publishing.
  const deadline = Date.now() + START_HANDSHAKE_TIMEOUT_MS;
  let lastErr: string | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(chalk.red(`swarm daemon: child exited with code ${child.exitCode} before rendezvous appeared`));
      console.error(chalk.dim(`  check ${daemonDir}/daemon.log for details`));
      return 1;
    }
    const r = await readRendezvous(cwd);
    if (r && r.pid === child.pid) {
      try {
        const res = await fetch(`http://127.0.0.1:${r.port}/health`, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          console.log(chalk.green(`swarm daemon started`));
          console.log(chalk.dim(`  pid:  ${r.pid}`));
          console.log(chalk.dim(`  port: ${r.port}`));
          console.log(chalk.dim(`  log:  ${daemonDir}/daemon.log`));
          return 0;
        }
        lastErr = `health check returned ${res.status}`;
      } catch (err) {
        lastErr = (err as Error).message;
      }
    }
    await sleep(100);
  }
  console.error(chalk.red(`swarm daemon: timed out waiting for child to come up (${START_HANDSHAKE_TIMEOUT_MS}ms)`));
  if (lastErr) console.error(chalk.dim(`  last error: ${lastErr}`));
  console.error(chalk.dim(`  check ${daemonDir}/daemon.log for details`));
  return 1;
}

// ---------------------------------------------------------------------------
// swarm daemon stop
// ---------------------------------------------------------------------------

export async function daemonStopCommand(opts: DaemonStopOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const grace = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const r = await readRendezvous(cwd);
  if (!r) {
    console.log(chalk.dim(`swarm daemon: not running`));
    return 0;
  }
  if (!isPidAlive(r.pid)) {
    console.log(chalk.yellow(`swarm daemon: stale rendezvous (pid ${r.pid} not alive) — cleaning up`));
    await removeRendezvous(cwd);
    return 0;
  }

  try {
    process.kill(r.pid, "SIGTERM");
  } catch (err) {
    console.error(chalk.red(`swarm daemon stop: kill SIGTERM failed — ${(err as Error).message}`));
    return 1;
  }

  const deadline = Date.now() + grace;
  while (Date.now() < deadline) {
    if (!isPidAlive(r.pid)) {
      await removeRendezvous(cwd);
      console.log(chalk.green(`swarm daemon stopped (pid ${r.pid})`));
      return 0;
    }
    await sleep(100);
  }

  // Grace window expired. Escalate to SIGKILL.
  console.log(chalk.yellow(`swarm daemon: graceful shutdown timed out after ${grace}ms — sending SIGKILL`));
  try {
    process.kill(r.pid, "SIGKILL");
  } catch {
    // Fall through: the next isPidAlive check will tell us.
  }
  // SIGKILL is synchronous in-kernel; one more short wait is enough.
  for (let i = 0; i < 20; i++) {
    if (!isPidAlive(r.pid)) break;
    await sleep(50);
  }
  await removeRendezvous(cwd);
  if (isPidAlive(r.pid)) {
    console.error(chalk.red(`swarm daemon: pid ${r.pid} still alive after SIGKILL`));
    return 1;
  }
  console.log(chalk.green(`swarm daemon killed (pid ${r.pid})`));
  return 0;
}

// ---------------------------------------------------------------------------
// swarm daemon status
// ---------------------------------------------------------------------------

export interface DaemonStatusReport {
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
  version?: string;
  health?: "ok" | "failed";
  stale?: boolean;
}

export async function daemonStatusCommand(opts: DaemonCommandBaseOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const r = await readRendezvous(cwd);
  if (!r) {
    console.log(JSON.stringify({ running: false } satisfies DaemonStatusReport));
    return 1;
  }
  if (!isPidAlive(r.pid)) {
    console.log(
      JSON.stringify({
        running: false,
        stale: true,
        pid: r.pid,
        port: r.port,
        startedAt: r.startedAt,
        version: r.version,
      } satisfies DaemonStatusReport),
    );
    return 1;
  }
  let health: "ok" | "failed" = "failed";
  try {
    const res = await fetch(`http://127.0.0.1:${r.port}/health`, { signal: AbortSignal.timeout(1_000) });
    if (res.ok) health = "ok";
  } catch {
    // keep "failed"
  }
  const report: DaemonStatusReport = {
    running: true,
    pid: r.pid,
    port: r.port,
    startedAt: r.startedAt,
    version: r.version,
    health,
  };
  console.log(JSON.stringify(report));
  return health === "ok" ? 0 : 2;
}

// ---------------------------------------------------------------------------
// swarm __daemon-run (internal; invoked by start or by start --foreground)
// ---------------------------------------------------------------------------

/**
 * The actual long-lived daemon body. Binds the HTTP server, writes the
 * rendezvous, and waits for SIGTERM/SIGINT. On shutdown, stops the
 * server and unlinks the rendezvous before returning.
 */
export async function daemonRunCommand(opts: DaemonRunOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const port = opts.port ?? DEFAULT_DAEMON_PORT;

  // Refuse to start if another daemon already owns the rendezvous. This
  // is a second layer of defence on top of `start`'s existing-check, in
  // case two `__daemon-run` processes race.
  const existing = await readRendezvous(cwd);
  if (existing && isPidAlive(existing.pid)) {
    console.error(chalk.red(`swarm daemon: another daemon is already running (pid ${existing.pid})`));
    return 1;
  }

  // SQLite-backed job queue lives under `.swarm/daemon/queue.db`. The
  // daemon is the only writer; `swarm run` becomes a client that POSTs
  // to `/jobs` (phase 7).
  const dbPath = join(getDaemonDir(cwd), "queue.db");
  let jobQueue: JobQueue | undefined;
  try {
    jobQueue = createSqliteJobQueue({ dbPath });
  } catch (err) {
    console.error(chalk.red(`swarm daemon: failed to open job queue — ${(err as Error).message}`));
    return 1;
  }

  const startedAt = new Date().toISOString();
  const concurrency = DEFAULT_CONCURRENCY;
  const resolvedRunsDir = resolvePath(cwd, opts.runsDir ?? ".swarm/runs");

  // ProcessSupervisor spawns `swarm run` children per job. It's pure
  // shell-out plumbing; the scheduler owns the lifecycle logic.
  const argv0 = process.argv[0];
  const swarmScript = process.argv[1];
  if (argv0 === undefined || swarmScript === undefined) {
    console.error(chalk.red("swarm daemon: cannot determine interpreter path — refusing to start"));
    await jobQueue.close().catch(() => {});
    return 1;
  }
  const supervisor: ProcessSupervisor = createLocalProcessSupervisor({
    argv0,
    swarmScript,
    cwd,
    runsDir: resolvedRunsDir,
  });

  // Captured in a closure so `/health` sees live counters. `handle.port`
  // is filled in after `startServer` returns; we reference it lazily.
  let boundPort = port;
  const daemonInfo = async (): Promise<HealthDaemonInfo> => ({
    pid: process.pid,
    port: boundPort,
    startedAt,
    version: DAEMON_VERSION,
    concurrency,
    inflight: await jobQueue.count("running"),
    queued: await jobQueue.count("queued"),
  });

  let handle: Awaited<ReturnType<typeof startServer>>;
  try {
    handle = await startServer({
      port,
      hostname: "127.0.0.1",
      cwd,
      ...(opts.runsDir !== undefined ? { runsDir: opts.runsDir } : {}),
      ports: { jobQueue, daemonInfo },
    });
    boundPort = handle.port;
  } catch (err) {
    await jobQueue.close().catch(() => {});
    const e = err as { code?: string; message?: string };
    if (e.code === "EADDRINUSE") {
      console.error(chalk.red(`swarm daemon: port ${port} already in use`));
      console.error(chalk.dim(`  hint: another daemon may be running without a rendezvous file, or pass --port`));
    } else {
      console.error(chalk.red(`swarm daemon: failed to start — ${e.message ?? String(err)}`));
    }
    return 1;
  }

  await writeRendezvous(cwd, {
    pid: process.pid,
    port: handle.port,
    startedAt,
    version: DAEMON_VERSION,
  });

  // Start the scheduler after the HTTP server so `/health` can report
  // `inflight:0` from the first request.
  const scheduler: SchedulerHandle = startScheduler({
    queue: jobQueue,
    supervisor,
    concurrency,
    runsDir: handle.runsDir,
  });

  console.log(chalk.green(`swarm daemon listening on ${handle.url}`));
  console.log(chalk.dim(`  pid:         ${process.pid}`));
  console.log(chalk.dim(`  runs-dir:    ${handle.runsDir}`));
  console.log(chalk.dim(`  concurrency: ${concurrency}`));

  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${signal} received — shutting down daemon...`));
      (async () => {
        // Order matters: stop accepting new work (scheduler) → stop
        // accepting new HTTP requests (handle) → flush queue → drop
        // rendezvous. In-flight worker children are detached and
        // continue running — phase 6 orphan recovery adopts them on
        // the next startup.
        await scheduler
          .stop()
          .catch((err) => console.error(chalk.red(`daemon scheduler stop failed — ${(err as Error).message}`)));
        await handle
          .close()
          .catch((err) => console.error(chalk.red(`daemon close failed — ${(err as Error).message}`)));
        await jobQueue
          ?.close()
          .catch((err) => console.error(chalk.red(`daemon queue close failed — ${(err as Error).message}`)));
        await removeRendezvous(cwd).catch((err) =>
          console.error(chalk.red(`daemon rendezvous cleanup failed — ${(err as Error).message}`)),
        );
        resolveShutdown();
      })();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });

  return 0;
}
