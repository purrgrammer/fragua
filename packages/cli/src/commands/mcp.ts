// `fragua mcp` — inspect the project's MCP servers + drive remote OAuth.
//
//   fragua mcp ls               list servers in <cwd>/.mcp.json + cred/OAuth state
//   fragua mcp check [server]   connect (all, or one) and list the tools each exposes
//   fragua mcp login <server>   run the interactive OAuth flow for an http server
//   fragua mcp logout <server>  forget an http server's stored OAuth tokens
//
// `ls`/`check` are read-only off the current directory's mcp.json. `login`/
// `logout` persist OAuth state through the store (via the store-client seam).
// See docs/proposals/mcp-tools.md.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  createMcpConnector,
  loadMcpConfig,
  MCP_OAUTH_CALLBACK_URL,
  type McpHttpServerConfig,
  type McpServerConfig,
  type McpToolset,
  mcpConfigPath,
  mcpToolPrefix,
  resolveMcpServer,
  StoredOAuthProvider,
} from "@fragua/workspace";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import chalk from "chalk";
import { makeMcpOAuthStore } from "../mcp-oauth-store.ts";
import { type StoreClient, withStoreClient } from "../store-client.ts";

export interface McpOptions {
  /** Project directory whose `.mcp.json` to read. Default `process.cwd()`. */
  cwd?: string;
  /** Store path for OAuth state. Default `~/.fragua/fragua.db`. */
  dbPath?: string;
}

export function mcpHelp(): number {
  console.log(`${chalk.bold("fragua mcp")} — inspect this project's MCP servers`);
  console.log("");
  console.log("  fragua mcp ls               list configured servers + credential/OAuth state");
  console.log("  fragua mcp check [server]   connect and list the tools a server exposes");
  console.log("  fragua mcp login <server>   run the interactive OAuth flow for an http server");
  console.log("  fragua mcp logout <server>  forget an http server's stored OAuth tokens");
  console.log("");
  console.log(chalk.dim("  Servers are declared in <cwd>/.mcp.json (env-var credentials)."));
  return 0;
}

/** The static Authorization header on an http server, if any (case-insensitive). */
function staticAuthHeader(server: McpHttpServerConfig): string | undefined {
  for (const [k, v] of Object.entries(server.headers ?? {})) {
    if (k.toLowerCase() === "authorization") return v;
  }
  return undefined;
}

/** An http server that could carry stored OAuth state — no static Authorization
 * header, so the store must be consulted for its login status. Anything else
 * (stdio, or http with a static header) needs no store, so `mcp ls` stays a
 * pure inspection that works before the harness/store exists. */
function needsOAuthState(server: McpServerConfig): boolean {
  return server.transport === "http" && staticAuthHeader(server) === undefined;
}

export function mcpLsCommand(opts: McpOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const load = loadMcpConfig(cwd);
  console.log(chalk.bold("mcp servers") + chalk.dim(`  (${mcpConfigPath(cwd)})`));
  if (!load.ok) {
    console.log(load.error ? chalk.red(`  ${load.error}`) : chalk.yellow("  no mcp.json found"));
    return Promise.resolve(load.error ? 1 : 0);
  }
  const names = Object.keys(load.servers);
  const unsupported = Object.entries(load.unsupported);
  if (names.length === 0 && unsupported.length === 0) {
    console.log(chalk.yellow("  no servers defined"));
    return Promise.resolve(0);
  }

  const render = (loggedIn?: (url: string) => boolean): number => {
    for (const name of names) {
      const server = load.servers[name];
      if (!server) continue;
      const target = server.transport === "http" ? server.url : server.command;
      const resolved = resolveMcpServer(server, process.env);
      const status = resolved.ok ? chalk.green("ready") : chalk.yellow(`missing env: ${resolved.missing.join(", ")}`);
      // OAuth column only when the row itself resolved — a missing-env row shows
      // `missing env: …` and nothing more (never a false `ready`).
      let oauth = "";
      if (server.transport === "http" && resolved.ok && resolved.server.transport === "http") {
        if (staticAuthHeader(server) !== undefined) oauth = chalk.green("  ready");
        else if (loggedIn)
          oauth = loggedIn(resolved.server.url) ? chalk.green("  logged in") : chalk.yellow("  login required");
      }
      console.log(`  ${chalk.cyan(name)}  ${chalk.dim(`${server.transport}:${target}`)}  ${status}${oauth}`);
    }
    for (const [name, reason] of unsupported) {
      console.log(`  ${chalk.cyan(name)}  ${chalk.yellow(reason)}`);
    }
    return 0;
  };

  // Only open the store when an OAuth server needs its login status — otherwise
  // `ls` works on a fresh checkout with no store yet.
  if (
    !names.some((n) => {
      const s = load.servers[n];
      return s !== undefined && needsOAuthState(s);
    })
  ) {
    return Promise.resolve(render());
  }
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  // "logged in" means a usable token, not merely a row: `runLoginFlow` writes the
  // client-registration row before the browser redirect and only writes tokens on
  // callback, so a Ctrl-C in between leaves a token-less row. Report that as
  // "login required" (what the daemon does with it), not a false "logged in".
  return withStoreClient(clientOpts, ({ store }) => render((url) => hasStoredTokens(store.getMcpOAuth(url))));
}

/** True only when the stored OAuth payload actually carries a token set — a row
 * holding only client-registration (a login interrupted before callback) is not
 * logged in. */
function hasStoredTokens(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    return (JSON.parse(raw) as { tokens?: unknown }).tokens != null;
  } catch {
    return false;
  }
}

export async function mcpCheckCommand(server: string | undefined, opts: McpOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const load = loadMcpConfig(cwd);
  if (!load.ok) {
    console.log(load.error ? chalk.red(load.error) : chalk.yellow(`no mcp.json at ${mcpConfigPath(cwd)}`));
    return 1;
  }
  const targets = server ? [server] : Object.keys(load.servers);
  if (targets.length === 0) {
    console.log(chalk.yellow("no servers defined"));
    return 0;
  }

  const runCheck = async (oauthProviderFor?: (url: string) => StoredOAuthProvider): Promise<number> => {
    let set: McpToolset | undefined;
    try {
      set = await createMcpConnector(oauthProviderFor ? { oauthProviderFor } : {}).materialize(targets, { cwd });
      let failed = false;
      for (const name of targets) {
        const unavailable = set.errors.find((e) => e.server === name && e.kind === "unavailable");
        if (unavailable) {
          console.log(`${chalk.cyan(name)}  ${chalk.red(unavailable.message)}`);
          failed = true;
          continue;
        }
        const prefix = mcpToolPrefix(name);
        const tools = set.tools.filter((t) => t.name.startsWith(prefix));
        console.log(`${chalk.cyan(name)}  ${chalk.green(`${tools.length} tool(s)`)}`);
        for (const t of tools) console.log(`  ${chalk.dim(t.name)}`);
        // A collision is non-fatal — the server is live and its other tools listed.
        for (const c of set.errors.filter((e) => e.server === name && e.kind === "collision")) {
          console.log(`  ${chalk.yellow(c.message)}`);
        }
      }
      return failed ? 1 : 0;
    } finally {
      await set?.dispose();
    }
  };

  // OAuth-only servers need the daemon-style provider (stored tokens, no browser)
  // to connect; open the store only when a target actually needs it.
  if (
    !targets.some((n) => {
      const s = load.servers[n];
      return s !== undefined && needsOAuthState(s);
    })
  ) {
    return runCheck();
  }
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  return withStoreClient(clientOpts, ({ store }) =>
    runCheck(
      (url) =>
        new StoredOAuthProvider({
          url,
          store: makeMcpOAuthStore(store),
          redirectUrl: MCP_OAUTH_CALLBACK_URL,
          onRedirect: () => {
            throw new Error(`not logged in — run \`fragua mcp login\` for ${url}`);
          },
        }),
    ),
  );
}

/** Locate a server in mcp.json and validate it as an http OAuth target. `login`
 * additionally rejects a static-auth server (`requireOAuth`); `logout` accepts
 * one so its stored tokens can still be cleared. Returns the resolved url or a
 * non-zero exit after printing the error. */
function resolveOAuthTarget(
  server: string,
  cwd: string,
  requireOAuth: boolean,
): { ok: true; url: string; headers: Record<string, string> } | { ok: false; code: number } {
  const load = loadMcpConfig(cwd);
  if (!load.ok) {
    console.error(load.error ? chalk.red(load.error) : chalk.yellow(`no mcp.json at ${mcpConfigPath(cwd)}`));
    return { ok: false, code: 1 };
  }
  const config: McpServerConfig | undefined = load.servers[server];
  if (!config) {
    console.error(chalk.red(`mcp: server "${server}" not found in ${mcpConfigPath(cwd)}`));
    return { ok: false, code: 1 };
  }
  if (config.transport !== "http") {
    console.error(chalk.red(`mcp: "${server}" is a ${config.transport} server — OAuth applies to http servers only`));
    return { ok: false, code: 1 };
  }
  if (requireOAuth && staticAuthHeader(config) !== undefined) {
    console.error(chalk.yellow(`mcp: "${server}" already uses static auth (Authorization header) — no login needed`));
    return { ok: false, code: 1 };
  }
  const resolved = resolveMcpServer(config, process.env);
  if (!resolved.ok || resolved.server.transport !== "http") {
    const missing = resolved.ok ? "" : resolved.missing.join(", ");
    console.error(chalk.red(`mcp: cannot resolve url for "${server}"${missing ? ` (missing env: ${missing})` : ""}`));
    return { ok: false, code: 1 };
  }
  return { ok: true, url: resolved.server.url, headers: resolved.server.headers };
}

export function mcpLogoutCommand(server: string, opts: McpOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const target = resolveOAuthTarget(server, cwd, false);
  if (!target.ok) return Promise.resolve(target.code);
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  return withStoreClient(clientOpts, ({ store }) => {
    const existed = store.getMcpOAuth(target.url) !== undefined;
    store.deleteMcpOAuth(target.url);
    if (existed) console.log(chalk.green(`Logged out of ${server}.`));
    else console.log(chalk.dim(`No stored OAuth state for ${server}; nothing to do.`));
    return 0;
  });
}

/** A login transport as `runLoginFlow` uses it — the real one wraps an MCP
 * `Client` + `StreamableHTTPClientTransport`; tests inject a fake to drive the
 * valid-token fast-path and the auth-required path without a live server. */
export interface LoginTransport {
  connect(): Promise<void>;
  finishAuth(code: string): Promise<void>;
  close(): Promise<void>;
}
export type LoginTransportFactory = (
  url: string,
  headers: Record<string, string>,
  authProvider: StoredOAuthProvider,
) => LoginTransport;

const defaultLoginTransport: LoginTransportFactory = (url, headers, authProvider) => {
  const mcpClient = new Client({ name: "fragua", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider, requestInit: { headers } });
  return {
    connect: () => mcpClient.connect(transport as Transport),
    finishAuth: (code) => transport.finishAuth(code),
    close: async () => {
      await transport.close().catch(() => {});
      await mcpClient.close().catch(() => {});
    },
  };
};

export function mcpLoginCommand(
  server: string,
  creds: { clientId?: string; clientSecret?: string } = {},
  opts: McpOptions = {},
  deps: { transportFactory?: LoginTransportFactory } = {},
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const target = resolveOAuthTarget(server, cwd, true);
  if (!target.ok) return Promise.resolve(target.code);
  const factory = deps.transportFactory ?? defaultLoginTransport;
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  return withStoreClient(clientOpts, (client) =>
    runLoginFlow(server, target.url, target.headers, creds, client, factory),
  );
}

/** Best-effort platform browser opener — the auth URL is already printed, so a
 * failure to spawn is silently ignored (no new npm dependency). The URL comes
 * from the auth-server's `.well-known` metadata (attacker-influenceable), so it
 * is treated as untrusted: only http/https URLs are opened, and on Windows we
 * do NOT hand it to `cmd /c start` — cmd.exe re-parses its command line even
 * without `shell: true`, so a `&` in the URL breaks out (`…?x=1 & calc.exe`).
 * PowerShell `Start-Process` with a single-quoted argument has no such re-parse. */
function openInBrowser(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return; // unparseable — don't hand it to any launcher
  }
  if (protocol !== "http:" && protocol !== "https:") return;
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "powershell";
    // Single-quote the URL and double any embedded single-quote — PowerShell's
    // literal-string rule — so the whole URL is one inert argument to Start-Process.
    args = ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url.replace(/'/g, "''")}'`];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best-effort; the URL is already on screen.
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Strip control bytes so a hostile `?error=` value can't inject terminal
 * escapes when we print it, and cap its length. */
function sanitizeErrorParam(v: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control bytes to remove them.
  return v.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
}

async function runLoginFlow(
  server: string,
  url: string,
  headers: Record<string, string>,
  creds: { clientId?: string; clientSecret?: string },
  client: StoreClient,
  transportFactory: LoginTransportFactory,
): Promise<number> {
  const callbackPath = new URL(MCP_OAUTH_CALLBACK_URL).pathname;
  // Confidential clients pre-register a fixed redirect URI, so they MUST use the
  // fixed callback port. DCR / public clients register the redirect at auth time,
  // so bind an ephemeral port — no fixed-port pre-bind clash, concurrent logins ok.
  const confidential = creds.clientId !== undefined;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const htmlPage = (body: string): string => `<!doctype html><html><body><p>${body}</p></body></html>`;
  // Assigned after we know the port; the handler only runs on a browser request,
  // by which time it's set.
  let authProvider: StoredOAuthProvider;
  const httpServer = createServer((req, resp) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname !== callbackPath) {
      resp.writeHead(404).end();
      return;
    }
    const error = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");
    const state = reqUrl.searchParams.get("state");
    const fail = (msg: string): void => {
      resp.writeHead(400, { "content-type": "text/html" });
      resp.end(htmlPage("Authorization failed — return to your terminal for details."));
      rejectCode(new Error(msg));
    };
    // CSRF: the returned state must match the one the SDK sent (PKCE already
    // binds the code, but state blocks a stray/forged localhost callback).
    if (state !== authProvider.expectedAuthState()) return fail("authorization state mismatch");
    if (!code)
      return fail(
        error
          ? `authorization failed: ${sanitizeErrorParam(error)}`
          : "callback received without an authorization code",
      );
    resp.writeHead(200, { "content-type": "text/html" });
    resp.end(htmlPage("Authorization complete — you can close this tab and return to your terminal."));
    resolveCode(code);
  });

  let transport: LoginTransport | undefined;
  try {
    await new Promise<void>((res, rej) => {
      httpServer.once("error", rej);
      httpServer.listen(confidential ? Number(new URL(MCP_OAUTH_CALLBACK_URL).port) : 0, "127.0.0.1", () => res());
    });
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : Number(new URL(MCP_OAUTH_CALLBACK_URL).port);
    const redirectUrl = `http://127.0.0.1:${port}${callbackPath}`;

    const providerOpts: ConstructorParameters<typeof StoredOAuthProvider>[0] = {
      url,
      store: makeMcpOAuthStore(client.store),
      redirectUrl,
      onRedirect: (authUrl) => {
        console.log(chalk.bold("Open this URL to authorize:"));
        console.log(authUrl.toString());
        openInBrowser(authUrl.toString());
      },
    };
    if (creds.clientId !== undefined) {
      providerOpts.client =
        creds.clientSecret !== undefined
          ? { clientId: creds.clientId, clientSecret: creds.clientSecret }
          : { clientId: creds.clientId };
    }
    authProvider = new StoredOAuthProvider(providerOpts);
    // Persist a preset confidential client so the DAEMON — which builds its own
    // provider without these flags — can read client_id/secret to refresh tokens.
    // (With a preset, `clientInformation()` returns it in-memory and the SDK never
    // calls `saveClientInformation`, so it would otherwise never reach the store.)
    if (creds.clientId !== undefined) {
      const info: OAuthClientInformation = { client_id: creds.clientId };
      if (creds.clientSecret !== undefined) info.client_secret = creds.clientSecret;
      authProvider.saveClientInformation(info);
    }

    transport = transportFactory(url, headers, authProvider);

    try {
      // Bound the initial connect so an unreachable server / hung TLS can't block
      // the CLI forever (the browser-callback wait below is already bounded; this
      // is the other blocking leg). Mirrors the connector's connect timeout.
      await withTimeout(transport.connect(), 30_000, `timed out connecting to ${server}`);
      // Stored tokens were still valid — no interactive step required.
      console.log(chalk.green(`Logged in to ${server}.`));
      return 0;
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) {
        console.error(chalk.red(`mcp: login failed: ${(e as Error).message}`));
        return 1;
      }
    }

    const code = await withTimeout(
      codePromise,
      300_000,
      "timed out after 300s waiting for the browser authorization callback",
    );
    await transport.finishAuth(code);
    console.log(chalk.green(`Logged in to ${server}.`));
    return 0;
  } catch (e) {
    console.error(chalk.red(`mcp: login failed: ${(e as Error).message}`));
    return 1;
  } finally {
    await new Promise<void>((res) => httpServer.close(() => res()));
    await transport?.close().catch(() => {});
  }
}
