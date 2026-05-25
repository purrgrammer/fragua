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
//   4. Block on SIGINT / SIGTERM / daemon-child exit.
//   5. On shutdown: SIGTERM the daemon, then `serverHandle.close()` clears
//      `server_endpoint` and stops the HTTP server.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SqliteStore } from "@fragua/store";
import chalk from "chalk";
import { FRAGUA_VERSION } from "../version.ts";
import { EMBEDDED_WEB_ASSETS } from "../web-assets.ts";
import { ensureWebBundle } from "../web-build.ts";
import { startServer } from "./serve.ts";

const COMPILED = Object.keys(EMBEDDED_WEB_ASSETS).length > 0;

const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
// Re-assert the discovery URL on the lock row at this cadence. Must stay
// well under the daemon lock TTL so a transient row reset is corrected
// long before any discovery client could read a stale/empty value.

export interface HarnessCommandOptions {
  /** Store path. Default `~/.fragua/fragua.db`. */
  dbPath?: string;
  /** TCP port for the HTTP server. When omitted, `startServer` resolves
   * via `web.port` from `~/.fragua/config.yaml`, then `DEFAULT_WEB_PORT`
   * (6767). Pass 0 for an ephemeral bind. */
  port?: number;
}

export async function harnessCommand(opts: HarnessCommandOptions = {}): Promise<number> {
  const dbPath = opts.dbPath ? resolve(opts.dbPath) : resolve(homedir(), ".fragua/fragua.db");
  mkdirSync(dirname(dbPath), { recursive: true });

  console.log(chalk.green("fragua harness starting"));
  console.log(chalk.dim(`  store: ${dbPath}`));

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

  // 4. The server already published its `server_endpoint` row when it bound
  //    (in `startServer`). That row is independent of the daemon lock, so the
  //    daemon's lock insert/release can't clobber it — no re-assert loop, and
  //    `serverHandle.close()` clears it on shutdown.
  lockStore.close();

  console.log("");
  console.log(chalk.green(`fragua harness ready — ${chalk.bold.underline(hyperlink(serverHandle.origin))}`));
  console.log(chalk.dim(`  api:  ${hyperlink(serverHandle.url)}`));
  console.log(chalk.dim("  press Ctrl-C to stop"));

  // 5. Block until shutdown.
  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const stop = (label: string) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${label} — shutting down...`));
      shutdown(daemonProc, serverHandle).finally(() => resolveShutdown());
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    daemonProc.exited.then((code) => stop(`daemon exited (${code})`));
  });

  return 0;
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
  daemonProc: ReturnType<typeof Bun.spawn>,
  serverHandle: Awaited<ReturnType<typeof startServer>>,
): Promise<void> {
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
