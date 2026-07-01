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
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  return withStoreClient(clientOpts, ({ store }) => {
    for (const name of names) {
      const server = load.servers[name];
      if (!server) continue;
      const target = server.transport === "http" ? server.url : server.command;
      const resolved = resolveMcpServer(server, process.env);
      const status = resolved.ok ? chalk.green("ready") : chalk.yellow(`missing env: ${resolved.missing.join(", ")}`);
      let oauth = "";
      if (server.transport === "http") {
        if (staticAuthHeader(server) !== undefined) {
          oauth = chalk.green("  ready");
        } else if (resolved.ok && resolved.server.transport === "http") {
          oauth =
            store.getMcpOAuth(resolved.server.url) !== undefined
              ? chalk.green("  logged in")
              : chalk.yellow("  login required");
        }
      }
      console.log(`  ${chalk.cyan(name)}  ${chalk.dim(`${server.transport}:${target}`)}  ${status}${oauth}`);
    }
    for (const [name, reason] of unsupported) {
      console.log(`  ${chalk.cyan(name)}  ${chalk.yellow(reason)}`);
    }
    return 0;
  });
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
  let set: McpToolset | undefined;
  try {
    set = await createMcpConnector().materialize(targets, { cwd });
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
}

/** Locate a server in mcp.json and validate it as an http OAuth target. `login`
 * additionally rejects a static-auth server (`requireOAuth`); `logout` accepts
 * one so its stored tokens can still be cleared. Returns the resolved url or a
 * non-zero exit after printing the error. */
function resolveOAuthTarget(
  server: string,
  cwd: string,
  requireOAuth: boolean,
): { ok: true; url: string } | { ok: false; code: number } {
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
  return { ok: true, url: resolved.server.url };
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

export function mcpLoginCommand(
  server: string,
  creds: { clientId?: string; clientSecret?: string } = {},
  opts: McpOptions = {},
): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const target = resolveOAuthTarget(server, cwd, true);
  if (!target.ok) return Promise.resolve(target.code);
  const clientOpts = opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {};
  return withStoreClient(clientOpts, (client) => runLoginFlow(server, target.url, creds, client));
}

/** Best-effort platform browser opener — the auth URL is already printed, so a
 * failure to spawn is silently ignored (no new npm dependency). */
function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
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

async function runLoginFlow(
  server: string,
  url: string,
  creds: { clientId?: string; clientSecret?: string },
  client: StoreClient,
): Promise<number> {
  const callback = new URL(MCP_OAUTH_CALLBACK_URL);
  const providerOpts: ConstructorParameters<typeof StoredOAuthProvider>[0] = {
    url,
    store: makeMcpOAuthStore(client.store),
    redirectUrl: MCP_OAUTH_CALLBACK_URL,
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
  const authProvider = new StoredOAuthProvider(providerOpts);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const httpServer = createServer((req, resp) => {
    const reqUrl = new URL(req.url ?? "/", `http://${callback.host}`);
    if (reqUrl.pathname !== callback.pathname) {
      resp.writeHead(404).end();
      return;
    }
    const error = reqUrl.searchParams.get("error");
    const code = reqUrl.searchParams.get("code");
    resp.writeHead(200, { "content-type": "text/html" });
    resp.end(
      "<!doctype html><html><body><p>Authorization complete — you can close this tab and return to your terminal.</p></body></html>",
    );
    if (error) rejectCode(new Error(`authorization failed: ${error}`));
    else if (code) resolveCode(code);
    else rejectCode(new Error("callback received without an authorization code"));
  });

  const mcpClient = new Client({ name: "fragua", version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), { authProvider });

  try {
    await new Promise<void>((res, rej) => {
      httpServer.once("error", rej);
      httpServer.listen(Number(callback.port), callback.hostname, () => res());
    });

    try {
      await mcpClient.connect(transport as Transport);
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
    httpServer.close();
    await transport.close().catch(() => {});
    await mcpClient.close().catch(() => {});
  }
}
