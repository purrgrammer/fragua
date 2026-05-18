// `swarm harness` — supervise the executor daemon + HTTP server as a single
// foreground process. Discovery via the DB itself: the harness publishes
// its URL onto `daemon_lock` so CLI invocations from any cwd find it
// without a JSON file.
//
// Topology:
//   - HTTP server runs in-process via `startServer` (cheap).
//   - Executor daemon runs as a `swarm daemon start --db <path>` subprocess
//     so we don't have to re-implement its 200-line setup. The subprocess
//     inherits stdio for visibility.
//   - Both share `~/.swarm/swarm.db` (override with --db). SQLite WAL
//     handles concurrent connections.
//
// Lifecycle:
//   1. Bind the HTTP server at port 0 (ephemeral) or --port <n>.
//   2. Spawn `swarm daemon start --db <path>`. The daemon acquires
//      daemon_lock as part of its boot.
//   3. Wait for the lock row to appear (poll up to LOCK_WAIT_MS).
//   4. UPDATE daemon_lock SET http_url, http_port, harness_version. CLIs
//      now discover us via the DB.
//   5. Block on SIGINT / SIGTERM / daemon-child exit.
//   6. On shutdown: clear URL columns, SIGTERM the daemon, close the
//      HTTP server.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";
import { EMBEDDED_WEB_ASSETS } from "../web-assets.ts";
import { ensureWebBundle } from "../web-build.ts";
import { startServer } from "./serve.ts";

const COMPILED = Object.keys(EMBEDDED_WEB_ASSETS).length > 0;

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;

export interface HarnessCommandOptions {
  /** Store path. Default `~/.swarm/swarm.db`. */
  dbPath?: string;
  /** TCP port for the HTTP server. When omitted, `startServer` resolves
   * via `web.port` from `~/.swarm/config.jsonc`, then `DEFAULT_WEB_PORT`
   * (6767). Pass 0 for an ephemeral bind. */
  port?: number;
}

export async function harnessCommand(opts: HarnessCommandOptions = {}): Promise<number> {
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolve(homedir(), ".swarm/swarm.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  console.log(chalk.green("swarm harness starting"));
  console.log(chalk.dim(`  store: ${dbPath}`));

  // Build / refresh the web bundle before binding so the moment the URL
  // prints, the latest UI is what gets served. Compiled binary: the
  // bundle is embedded — skip the vite spawn entirely (there's no source
  // tree to read from anyway). Dev / source install: skipped
  // automatically for production installs (no src/) and SWARM_NO_WEB_BUILD=1.
  const webDistDir = COMPILED ? undefined : (await ensureWebBundle()).distDir;

  // 1. HTTP server (in-process). Binds before the daemon spawns so the
  //    URL is ready to publish the moment the daemon takes the lock.
  //    Port resolution lives in startServer: `--port` (when set) >
  //    `web.port` from ~/.swarm/config.jsonc > DEFAULT_WEB_PORT (6767).
  let serverHandle: Awaited<ReturnType<typeof startServer>>;
  try {
    const startOpts: Parameters<typeof startServer>[0] = { dbPath, webDistDir };
    if (opts.port !== undefined) startOpts.port = opts.port;
    serverHandle = await startServer(startOpts);
  } catch (err) {
    console.error(chalk.red(`harness: failed to bind HTTP — ${(err as Error).message}`));
    return 1;
  }

  // 2. Daemon subprocess. `swarm daemon start --db <path>` does its own
  //    setup; we just spawn + monitor. Compiled binary: re-invoke
  //    ourselves (`process.execPath`) with no script arg — the entry is
  //    the binary itself. Dev: re-invoke `bun <argv[1]>` so the daemon
  //    runs from the same source tree.
  const daemonArgv = COMPILED
    ? [process.execPath, "daemon", "start", "--db", dbPath]
    : [process.execPath, process.argv[1]!, "daemon", "start", "--db", dbPath];
  const daemonProc = Bun.spawn(daemonArgv, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // 3. Wait for daemon_lock to appear (daemon's startup acquires it).
  const lockStore = new SqliteStore({ path: dbPath });
  const lockAcquired = await waitForLock(lockStore);
  if (!lockAcquired) {
    console.error(chalk.red(`harness: daemon failed to acquire lock within ${LOCK_WAIT_MS}ms`));
    daemonProc.kill();
    lockStore.close();
    await serverHandle.close();
    return 1;
  }

  // 4. Publish URL. CLIs now discover the harness via the DB.
  try {
    lockStore.setDaemonLockHttp({
      url: serverHandle.url,
      port: serverHandle.port,
      version: HARNESS_VERSION,
    });
  } finally {
    lockStore.close();
  }

  console.log("");
  console.log(chalk.green(`swarm harness ready — ${chalk.bold.underline(hyperlink(serverHandle.origin))}`));
  console.log(chalk.dim(`  api:  ${hyperlink(serverHandle.url)}`));
  console.log(chalk.dim("  press Ctrl-C to stop"));

  // 5. Block until shutdown.
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const stop = (label: string) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${label} — shutting down...`));
      shutdown(dbPath, daemonProc, serverHandle).finally(() => resolveShutdown());
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    daemonProc.exited.then((code) => stop(`daemon exited (${code})`));
  });

  return 0;
}

const HARNESS_VERSION = "0.0.0"; // TODO: read from package.json when discovery clients care

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
  dbPath: string,
  daemonProc: ReturnType<typeof Bun.spawn>,
  serverHandle: Awaited<ReturnType<typeof startServer>>,
): Promise<void> {
  // Clear URL columns before tearing down so a stale CLI invocation
  // doesn't read a dead URL between our exit and the daemon's lock-row
  // delete.
  try {
    const s = new SqliteStore({ path: dbPath });
    try {
      s.setDaemonLockHttp({ url: null, port: null, version: null });
    } finally {
      s.close();
    }
  } catch (err) {
    console.error(chalk.dim(`harness: clear URL failed — ${(err as Error).message}`));
  }

  // Stop daemon child. SIGTERM, then wait. The daemon's own SIGTERM
  // handler triggers its graceful shutdown (lock release, sweep state).
  if (!daemonProc.killed) {
    daemonProc.kill();
    await daemonProc.exited;
  }

  // Stop HTTP server.
  try {
    await serverHandle.close();
  } catch (err) {
    console.error(chalk.dim(`harness: server close failed — ${(err as Error).message}`));
  }
}
