// `swarm serve` — start the HTTP server from @swarm/server and keep it running
// in the foreground. Users then open a browser to the printed URL.
//
// Design:
// - `startServer(opts)` is the pure, test-friendly entry point. It binds the
//   Hono app via `Bun.serve`, returns `{ url, port, runsDir, close }`, and
//   installs NO signal handlers (tests must not mutate global process state).
// - `serveCommand(opts)` wraps `startServer` for CLI use: it prints the bound
//   URL, installs SIGINT/SIGTERM handlers, and resolves only once the server
//   has shut down cleanly. It returns the intended process exit code.
//
// We use `Bun.serve` directly (Bun ≥ 1.2 is the primary runtime per AGENTS.md),
// which avoids adding `@hono/node-server` as a dependency.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, daemonInfoFromStore, type ServerPorts } from "@swarm/server";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";

/**
 * Locate the built web bundle by walking up from this file.
 * `packages/cli/src/commands/serve.ts` → `packages/web/dist/`.
 * Returns `undefined` if the bundle hasn't been built yet — the server
 * then runs in API-only mode and the CLI prints a hint.
 */
function findWebDistDir(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const candidate = resolve(here, "../../../web/dist");
  return existsSync(resolve(candidate, "index.html")) ? candidate : undefined;
}

export interface ServeCommandOptions {
  /** TCP port to bind. Default 3000. Pass 0 to get an ephemeral port. */
  port?: number;
  /** Working directory. Default `process.cwd()`. */
  cwd?: string;
  /** Explicit store path. Overrides `<cwd>/.swarm/swarm.db`. The discovery
   * file (`serve.json`) is written alongside it so parallel swarms with
   * different DBs have isolated discovery. */
  dbPath?: string;
  /** Hostname to bind. Default `"::"` (dual-stack IPv4+IPv6). */
  hostname?: string;
  /** Optional port overrides forwarded to `createServer`. */
  ports?: ServerPorts;
  /**
   * When the starting port is in use, try the next N ports before failing.
   * Applies only to non-zero ports. Default 20 when `port` is omitted (the
   * CLI default-3000 path), 0 when `port` is explicitly set.
   */
  portRetries?: number;
  /**
   * Development mode. The API still runs on `<port>`; in addition we spawn
   * Vite (HMR for the React app) as a child process and tell it to proxy
   * `/api` back to us via the `SWARM_API_URL` env var. The Vite URL is the
   * one humans should open. Backend module hot-reload isn't handled here
   * — prefix the command with `bun --hot` for that.
   */
  dev?: boolean;
}

export interface ServerHandle {
  /** Scheme+host+port users open in a browser. Always bare (no `/api`). */
  origin: string;
  /** Canonical URL for API clients — equals `origin` + `/api` in web mode,
   * or `origin` in API-only mode. Mirrors the discovery file's `url`. */
  url: string;
  port: number;
  /** Absolute path of the SQLite store this server is reading from. */
  storePath: string;
  /** Absolute path of the web bundle mounted at `/`, or `undefined` when
   * the server is running API-only. */
  webDistDir: string | undefined;
  close(): Promise<void>;
}

/**
 * Bind the HTTP server and return a handle. Does NOT install signal handlers
 * or print anything — callers decide how to present the bound URL.
 *
 * Throws on bind failure (e.g. `EADDRINUSE`); Bun.serve surfaces these
 * synchronously with a descriptive `.code`.
 */
export async function startServer(opts: ServeCommandOptions = {}): Promise<ServerHandle> {
  if (typeof Bun?.serve !== "function") {
    throw new Error("swarm serve requires the Bun runtime (>=1.2). Run via `bun run` instead of `node`.");
  }
  const cwd = opts.cwd ?? process.cwd();
  const storePath = opts.dbPath ? resolve(opts.dbPath) : resolve(cwd, ".swarm/swarm.db");
  mkdirSync(dirname(storePath), { recursive: true });
  const discoveryPath = resolve(dirname(storePath), "serve.json");
  const store = new SqliteStore({ path: storePath });
  const webDistDir = findWebDistDir();
  // Default daemon detection: read the daemon_lock row (and runStateCounts)
  // from the shared store on every /health request. Caller-provided
  // `opts.ports.daemonInfo` wins (lets tests inject fixtures).
  const ports: ServerPorts = {
    ...(opts.ports ?? {}),
    daemonInfo: opts.ports?.daemonInfo ?? daemonInfoFromStore({ store }),
  };
  const app = createServer({
    cwd,
    store,
    ports,
    ...(webDistDir !== undefined ? { webDistDir } : {}),
  });
  // Bind to "::" so the socket accepts both IPv6 and IPv4-mapped connections
  // (kernel default IPV6_V6ONLY=0 on Linux/macOS). This makes EADDRINUSE fire
  // regardless of which address family an existing listener is using, so the
  // printed `http://localhost:<port>` URL is actually the one we own.
  const hostname = opts.hostname ?? "::";
  const startPort = opts.port ?? 3000;
  const retries = opts.portRetries ?? 0;
  let server: ReturnType<typeof Bun.serve>;
  let lastErr: unknown;
  const maxAttempts = startPort === 0 ? 1 : retries + 1;
  let attempt = 0;
  while (true) {
    const tryPort = startPort === 0 ? 0 : startPort + attempt;
    try {
      server = Bun.serve({ port: tryPort, hostname, fetch: app.fetch });
      break;
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string } | null)?.code;
      attempt++;
      if (code !== "EADDRINUSE" || attempt >= maxAttempts) {
        store.close();
        throw err;
      }
    }
  }
  void lastErr;
  const port = server.port ?? 0;
  const origin = `http://localhost:${port}`;
  // In web mode the API is scoped under `/api/*`; API-only mode keeps bare
  // paths. Discovery publishes the prefix so `swarm run` appends routes
  // verbatim (e.g. `${url}/runs`) regardless of mode.
  const url = webDistDir ? `${origin}/api` : origin;
  try {
    writeFileSync(
      discoveryPath,
      JSON.stringify({ url, origin, port, pid: process.pid, storePath, webDistDir: webDistDir ?? null }, null, 2),
    );
  } catch {
    // Non-fatal: discovery file is a convenience, not a requirement.
  }
  return {
    origin,
    url,
    port,
    storePath,
    webDistDir,
    async close() {
      try {
        unlinkSync(discoveryPath);
      } catch {}
      await server.stop(true);
      store.close();
    },
  };
}

/**
 * CLI entry point. Starts the server, prints the URL, and blocks until SIGINT
 * or SIGTERM. Returns the intended process exit code (0 on clean shutdown,
 * 1 on bind failure).
 */
export async function serveCommand(opts: ServeCommandOptions = {}): Promise<number> {
  let handle: ServerHandle;
  try {
    handle = await startServer(opts);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "EADDRINUSE") {
      const start = opts.port ?? 3000;
      const retries = opts.portRetries ?? 0;
      if (retries > 0) {
        console.error(chalk.red(`serve: no free port in ${start}..${start + retries - 1}`));
      } else {
        console.error(chalk.red(`serve: port ${start} is already in use`));
      }
      console.error(chalk.dim("  hint: pick another with `swarm serve --port <n>`"));
    } else {
      console.error(chalk.red(`serve: failed to start — ${e.message ?? String(err)}`));
    }
    return 1;
  }

  console.log(chalk.green(`swarm serve listening on ${handle.origin}`));
  console.log(chalk.dim(`  store: ${handle.storePath}`));
  if (handle.webDistDir && !opts.dev) {
    console.log(chalk.dim(`  web:   ${handle.origin}/ (${handle.webDistDir})`));
    console.log(chalk.dim(`  api:   ${handle.url}`));
  } else if (opts.dev) {
    console.log(chalk.dim(`  api:   ${handle.origin}/api (HMR'd UI starts below)`));
  } else {
    console.log(chalk.dim(`  api:   ${handle.url}`));
    console.log(chalk.dim(`  web:   API-only — build the UI with \`bun run --filter @swarm/web build\``));
  }
  console.log(chalk.dim("  press Ctrl-C to stop"));

  // --dev: spawn Vite as a child process. Its proxy reads SWARM_API_URL
  // and forwards `/api/**` back to us with the path intact.
  let viteChild: ChildProcess | undefined;
  if (opts.dev) {
    viteChild = spawn("bun", ["run", "--filter", "@swarm/web", "dev"], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: "inherit",
      env: {
        ...process.env,
        SWARM_API_URL: `${handle.origin}/api`,
      },
    });
    viteChild.on("exit", (code, signal) => {
      if (signal !== "SIGINT" && signal !== "SIGTERM" && code !== 0) {
        console.error(chalk.red(`vite exited with code ${code} — shutting down serve`));
        process.kill(process.pid, "SIGINT");
      }
    });
  }

  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${signal} received — shutting down...`));
      if (viteChild && viteChild.exitCode === null) {
        try {
          viteChild.kill("SIGINT");
        } catch {}
      }
      handle
        .close()
        .catch((err) => console.error(chalk.red(`serve: close failed — ${(err as Error).message}`)))
        .finally(() => resolveShutdown());
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });

  return 0;
}
