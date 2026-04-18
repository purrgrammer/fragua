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

import { resolve } from "node:path";
import { createServer, type ServerPorts } from "@swarm/server";
import chalk from "chalk";
import { loadConfig } from "../config.ts";

export interface ServeCommandOptions {
  /** TCP port to bind. Default 3000. Pass 0 to get an ephemeral port. */
  port?: number;
  /** Runs directory (default `.swarm/runs` under cwd). */
  runsDir?: string;
  /** Working directory used to resolve `runsDir`. Default `process.cwd()`. */
  cwd?: string;
  /**
   * Hostname to bind. Default `"::"` (dual-stack, accepts v4 + v6 on
   * all interfaces) matches the user-facing `swarm serve` semantics.
   * The daemon passes `"127.0.0.1"` so its HTTP surface is not
   * reachable off-box.
   */
  hostname?: string;
  /**
   * Optional port overrides forwarded to `createServer`. The daemon
   * uses this to inject its SQLite `JobQueue`; the default `swarm
   * serve` invocation leaves it empty and the server returns 503 on
   * `/jobs` requests.
   */
  ports?: ServerPorts;
}

/**
 * Handle returned by `startServer`. Tests use `close()` for teardown; CLI code
 * uses `url` for the "listening on …" banner.
 */
export interface ServerHandle {
  /** Bound URL, e.g. `http://localhost:54321`. */
  url: string;
  /** Bound port (resolved even when caller passed 0). */
  port: number;
  /** Absolute path of the runs directory the server is exposing. */
  runsDir: string;
  /** Stop accepting new connections and release the port. */
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
  const runsDir = resolve(cwd, opts.runsDir ?? ".swarm/runs");
  // Load `.swarm/config.yaml` so the server's `SkillReader` honors
  // `skills.paths` / `skills.disabled` / `skills.trust_project`. Without
  // this, the server falls back to auto-discovery of every well-known
  // path (~/.claude/skills etc.), which ignores the user's explicit pin.
  const config = await loadConfig(cwd);
  const app = createServer({
    runsDir,
    cwd,
    ...(config.skills !== undefined ? { skillsConfig: config.skills } : {}),
    ...(opts.ports !== undefined ? { ports: opts.ports } : {}),
  });
  // Bind to "::" so the socket accepts both IPv6 and IPv4-mapped connections
  // (kernel default IPV6_V6ONLY=0 on Linux/macOS). This makes EADDRINUSE fire
  // regardless of which address family an existing listener is using, so the
  // printed `http://localhost:<port>` URL is actually the one we own.
  const hostname = opts.hostname ?? "::";
  const server = Bun.serve({ port: opts.port ?? 3000, hostname, fetch: app.fetch });
  const port = server.port ?? opts.port ?? 0;
  return {
    url: `http://localhost:${port}`,
    port,
    runsDir,
    async close() {
      await server.stop(true);
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
      console.error(chalk.red(`serve: port ${opts.port ?? 3000} is already in use`));
      console.error(chalk.dim("  hint: pick another with `swarm serve --port <n>`"));
    } else {
      console.error(chalk.red(`serve: failed to start — ${e.message ?? String(err)}`));
    }
    return 1;
  }

  console.log(chalk.green(`swarm serve listening on ${handle.url}`));
  console.log(chalk.dim(`  runs-dir: ${handle.runsDir}`));
  console.log(chalk.dim("  press Ctrl-C to stop"));

  await new Promise<void>((resolveShutdown) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      console.log(chalk.dim(`\n${signal} received — shutting down...`));
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
