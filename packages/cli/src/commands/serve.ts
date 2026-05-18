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

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry, validateWorkflowModels } from "@swarm/agent";
import { createServer, daemonInfoFromStore, registryPreflight, type ServerPorts } from "@swarm/server";
import { SqliteStore } from "@swarm/store";
import chalk from "chalk";
import { loadConfig } from "../config.ts";
import { EMBEDDED_WEB_ASSETS } from "../web-assets.ts";
import { ensureWebBundle } from "../web-build.ts";

/** True when running inside a `bun build --compile` binary. In that mode
 * the source tree is gone and the web bundle ships embedded; on-disk
 * discovery would fail. */
const COMPILED = Object.keys(EMBEDDED_WEB_ASSETS).length > 0;

/** TCP port used when neither `--port` nor `web.port` (in
 * `~/.swarm/config.jsonc`) is set. Picked once and stable so the user
 * can bookmark `http://localhost:6767/` across harness restarts. When
 * 6767 is occupied, `startServer` walks up one port at a time (see
 * `portRetries` below) so a stray collision doesn't kill startup. */
export const DEFAULT_WEB_PORT = 6767;

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
  /** TCP port to bind. When omitted, falls back to `web.port` from the
   * merged config, then to `DEFAULT_WEB_PORT` (6767). Pass 0 to get an
   * ephemeral port. The CLI bin layer threads `--port` here directly
   * without supplying a default, so this stays the single source of
   * truth for port resolution. */
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
   * Applies only to non-zero ports. Default 20 when `port` is omitted
   * (the auto-bump path that lets a second harness quietly take 6768),
   * 0 when `port` is explicitly set (a forced port should hard-fail on
   * collision so the operator notices).
   */
  portRetries?: number;
  /**
   * Explicit web bundle directory. When set, overrides the walk-up
   * discovery — pass the directory `ensureWebBundle()` resolved (or
   * `undefined` to force API-only mode without scanning). Tests omit
   * this and rely on the discovery so they don't pay a vite build.
   */
  webDistDir?: string | undefined;
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
  // Compiled binary: skip the on-disk walk entirely and serve from the
  // embedded asset map. The caller's `webDistDir` (even if explicitly
  // undefined) is ignored — there is no fs in the binary.
  // Dev / source install: callers (CLI commands) supply an explicit
  // `webDistDir` after running `ensureWebBundle()` so a fresh build is
  // mounted; tests omit it and fall back to the no-build discovery walk
  // so they don't spawn vite.
  const webDistDir = COMPILED ? undefined : "webDistDir" in opts ? opts.webDistDir : findWebDistDir();
  // Default daemon detection: read the daemon_lock row (and runStateCounts)
  // from the shared store on every /health request. Caller-provided
  // `opts.ports.daemonInfo` wins (lets tests inject fixtures).
  const ports: ServerPorts = {
    ...(opts.ports ?? {}),
    daemonInfo: opts.ports?.daemonInfo ?? daemonInfoFromStore({ store }),
  };
  // Credential + model state for the /providers routes. Same pair the
  // daemon uses, so the web UI and backend share a single view of which
  // providers are credentialed. Credentials live in the same store as
  // every other coordination surface (`provider_credentials` table).
  const authStorage = AuthStorage.fromStore(store);
  const modelRegistry = ModelRegistry.create(authStorage, store);
  // Backpressure cap on `status='queued'` runs from `.swarm/config.jsonc`.
  // Opt-in (default uncapped); non-positive / unparseable values are
  // silently ignored.
  const cfg = await loadConfig(cwd);
  const maxQueuedRuns =
    typeof cfg.maxQueuedRuns === "number" && Number.isFinite(cfg.maxQueuedRuns) && cfg.maxQueuedRuns > 0
      ? cfg.maxQueuedRuns
      : undefined;
  const app = createServer({
    cwd,
    store,
    ports,
    preflightProviders: registryPreflight({
      hasAnyAuth: () => modelRegistry.getAvailable().length > 0,
    }),
    validateWorkflowModels,
    authStorage,
    modelRegistry,
    ...(maxQueuedRuns !== undefined ? { maxQueuedRuns } : {}),
    ...(webDistDir !== undefined ? { webDistDir } : {}),
    ...(COMPILED ? { webBundle: EMBEDDED_WEB_ASSETS } : {}),
  });
  // Bind to "::" so the socket accepts both IPv6 and IPv4-mapped connections
  // (kernel default IPV6_V6ONLY=0 on Linux/macOS). This makes EADDRINUSE fire
  // regardless of which address family an existing listener is using, so the
  // printed `http://localhost:<port>` URL is actually the one we own.
  const hostname = opts.hostname ?? "::";
  const portExplicit = opts.port !== undefined;
  // Resolution: explicit caller arg > config.web.port > DEFAULT_WEB_PORT.
  // Keeping this here (not in the bin layer) means `swarm serve`,
  // `swarm harness`, and any future programmatic caller share one
  // resolution path — config-without-flag works the same everywhere.
  const startPort = portExplicit ? (opts.port as number) : (cfg.web?.port ?? DEFAULT_WEB_PORT);
  // Auto-bump on collision when the port came from config-or-default —
  // a second harness on the same box quietly takes 6768, 6769, … and
  // operators don't have to wrangle ports manually. When the caller
  // typed an explicit `--port`, respect it: a hard fail is the right
  // signal that THAT port is busy.
  const retries = opts.portRetries ?? (portExplicit ? 0 : 20);
  let server: ReturnType<typeof Bun.serve>;
  let lastErr: unknown;
  const maxAttempts = startPort === 0 ? 1 : retries + 1;
  let attempt = 0;
  while (true) {
    const tryPort = startPort === 0 ? 0 : startPort + attempt;
    try {
      // idleTimeout: 0 — SSE streams and slow read endpoints must not be
      // killed mid-flight under load.
      server = Bun.serve({ port: tryPort, hostname, fetch: app.fetch, idleTimeout: 0 });
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
  // verbatim (e.g. `${url}/runs`) regardless of mode. The compiled binary
  // ships the SPA embedded, so it's "web mode" with no distDir.
  const webMode = webDistDir !== undefined || COMPILED;
  const url = webMode ? `${origin}/api` : origin;
  // For diagnostics: the on-disk dist path if available, otherwise a
  // marker so the discovery file shows the SPA is embedded.
  const webSource = webDistDir ?? (COMPILED ? "(embedded)" : null);
  try {
    writeFileSync(
      discoveryPath,
      JSON.stringify({ url, origin, port, pid: process.pid, storePath, webDistDir: webSource }, null, 2),
    );
  } catch {
    // Non-fatal: discovery file is a convenience, not a requirement.
  }
  return {
    origin,
    url,
    port,
    storePath,
    webDistDir: webSource ?? undefined,
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
  // Build / refresh the web bundle before binding so the moment the URL
  // prints, the latest UI is what gets served. Compiled binary: skip the
  // vite spawn entirely — the bundle ships embedded. Caller-supplied
  // `webDistDir` (including the explicit `undefined` for API-only) wins
  // in dev — that's how tests skip the vite spawn too.
  const startOpts: ServeCommandOptions = COMPILED
    ? opts
    : "webDistDir" in opts
      ? opts
      : { ...opts, webDistDir: (await ensureWebBundle()).distDir };
  let handle: ServerHandle;
  try {
    handle = await startServer(startOpts);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "EADDRINUSE") {
      // The port that hard-failed is whatever the caller forced via
      // `--port` — startServer auto-bumps in the unset path so this
      // branch only fires for an explicit collision.
      const start = opts.port ?? DEFAULT_WEB_PORT;
      console.error(chalk.red(`serve: port ${start} is already in use`));
      console.error(
        chalk.dim("  hint: pick another with `swarm serve --port <n>`, or set web.port in ~/.swarm/config.jsonc"),
      );
    } else {
      console.error(chalk.red(`serve: failed to start — ${e.message ?? String(err)}`));
    }
    return 1;
  }

  console.log(chalk.green(`swarm serve listening on ${handle.origin}`));
  console.log(chalk.dim(`  store: ${handle.storePath}`));
  if (handle.webDistDir) {
    console.log(chalk.dim(`  web:   ${handle.origin}/ (${handle.webDistDir})`));
    console.log(chalk.dim(`  api:   ${handle.url}`));
  } else {
    console.log(chalk.dim(`  api:   ${handle.url}`));
    console.log(chalk.dim(`  web:   API-only — build the UI with \`bun run --filter @swarm/web build\``));
    console.log(
      chalk.dim(
        `         or run Vite separately: \`SWARM_API_URL=${handle.origin}/api bun run --filter @swarm/web dev\``,
      ),
    );
  }
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
