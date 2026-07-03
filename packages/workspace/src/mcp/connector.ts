// MCP connector — fragua is the MCP *client*. Given a set of server names
// declared on an llm step (`mcp-servers:`), it loads `<cwd>/.mcp.json`,
// spawns each requested stdio server, lists its tools, and materialises each as
// an ordinary fragua `Tool` named `mcp__<server>__<tool>`. The LLM then calls
// them exactly like `read` / `bash`; a call is routed back through the live MCP
// client's `callTool`.
//
// Lazy + per-step: `materialize` connects, the caller runs the step, then calls
// `dispose()` to tear every connection down. Connect is bounded by a timeout so
// a broken server can never hang the daemon; a missing credential or a failed
// connect skips that server (its tools don't appear) and is reported in
// `errors` rather than thrown.
//
// See docs/proposals/mcp-tools.md.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TSchema } from "@sinclair/typebox";
import type { AnyTool, ToolOutput } from "../types.ts";
import {
  hasStaticAuthHeader,
  loadMcpConfig,
  type ResolvedMcpServer,
  resolveMcpServer,
  resolveProjectEnv,
} from "./config.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
// `tools/list` is metadata enumeration, not a tool call — give it a moderate
// budget of its own, not the 120s per-call timeout (a stalled enumeration would
// otherwise block the whole step) nor the 15s connect timeout (too tight for a
// large catalogue on a cold server).
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const CLOSE_DEADLINE_MS = 5_000;
const MAX_TOOL_NAME_LEN = 128;
const MCP_OUTPUT_MAX_CHARS = 100_000;
const STDERR_TAIL_MAX = 2_000;

export interface McpMaterializeOptions {
  /** Project cwd — `<cwd>/.mcp.json` is the server registry. */
  cwd: string;
  /** Environment for `${VAR}` substitution. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Abort in-flight tool calls (wired from the run's signal). */
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** A requested server that produced no tools (`unavailable`), or one whose
 * tool was dropped by the first-wins name dedup (`collision` — the server is
 * still live and its other tools materialised). */
export interface McpServerError {
  server: string;
  message: string;
  kind: "unavailable" | "collision";
}

export interface McpToolset {
  /** Materialised tools across all servers that connected. */
  tools: AnyTool[];
  /** Requested servers that were skipped, with why. Never fatal. */
  errors: McpServerError[];
  /** Release every open connection. Idempotent. */
  dispose(): Promise<void>;
}

export interface McpConnector {
  materialize(serverNames: readonly string[], opts: McpMaterializeOptions): Promise<McpToolset>;
}

/** Injected dependencies for the connector. Kept store-free — the connector
 * sees only the SDK `OAuthClientProvider` type and this factory, never
 * @fragua/store. */
export interface McpConnectorDeps {
  /** Given a remote server URL, return an OAuth provider to drive interactive
   * auth + token persistence, or `undefined` to skip OAuth for it. Consulted
   * only for http servers with no static `Authorization` header. */
  oauthProviderFor?: (url: string) => OAuthClientProvider | undefined;
}

/** Decide whether a resolved server should authenticate through an injected
 * OAuth provider: only http, only when a factory is present, and only when the
 * server carries NO static `Authorization` header (case-insensitive). A static
 * header always wins — the OAuth path stays off. Extracted so the decision is
 * testable without a live server. */
export function needsOAuthProvider(
  server: ResolvedMcpServer,
  oauthProviderFor?: (url: string) => OAuthClientProvider | undefined,
): boolean {
  if (server.transport !== "http") return false;
  if (oauthProviderFor === undefined) return false;
  return hasStaticAuthHeader(server.headers) === undefined;
}

/** Namespace every materialised MCP tool name carries. Callers that need to
 * recognise one (the backend's allow-gate) MUST use `isMcpToolName`, not a
 * re-inlined literal, so the two can't drift. */
export const MCP_TOOL_NAMESPACE = "mcp__";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_NAMESPACE);
}

/** Slugify a server / tool segment to the `[a-z0-9_]` alphabet. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/** A loopback hostname — traffic to it never leaves the machine, so plaintext
 * http to it doesn't expose credentials to an on-path observer. Covers the
 * 127.0.0.0/8 range, IPv6 `::1` (with or without URL brackets), and `localhost`.
 * Exported so the CLI login flow guards `http://` with the SAME rule the
 * connector uses. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h.startsWith("127.") || h.startsWith("::ffff:127.");
}

// The server slug is capped low enough that EVERY tool keeps a non-empty suffix:
// reserve MCP_MIN_TOOL_SLUG chars for the tool segment. Without this, a server
// slug that fills the 121-char budget leaves `toolCap = 0`, so every tool from
// that server collapses to the identical `mcp__<slug>__` and first-wins dedup
// silently drops all but one. Both `mcpToolName` and `mcpToolPrefix` use the same
// cap so a name always begins with its server's prefix.
const MCP_MIN_TOOL_SLUG = 16;
const MCP_SERVER_SLUG_MAX = MAX_TOOL_NAME_LEN - MCP_TOOL_NAMESPACE.length - 2 - MCP_MIN_TOOL_SLUG;

export function mcpToolName(server: string, tool: string): string {
  const serverSlug = slug(server).slice(0, MCP_SERVER_SLUG_MAX);
  const toolCap = MAX_TOOL_NAME_LEN - MCP_TOOL_NAMESPACE.length - serverSlug.length - 2;
  const toolSlug = slug(tool).slice(0, toolCap);
  return `${MCP_TOOL_NAMESPACE}${serverSlug}__${toolSlug}`;
}

/** The prefix every tool from `server` shares — the single source of the slug
 * rule for callers filtering tools by server (e.g. the CLI's `mcp check`). Uses
 * the same server-slug cap as `mcpToolName` so the trailing `__` separator always
 * survives and a tool name always starts with its server's prefix. */
export function mcpToolPrefix(server: string): string {
  const cap = MCP_SERVER_SLUG_MAX;
  return `${MCP_TOOL_NAMESPACE}${slug(server).slice(0, cap)}__`;
}

/** Fold an author-written MCP tool reference (an `allowed-tools` / `denied-tools`
 * entry) to the materialised name form. Materialised names are slug-lowercased,
 * so `mcp__My-Server__DeleteRepo` must normalise to `mcp__my_server__deleterepo`
 * to match — otherwise the allow/deny silently has no effect. Non-MCP names pass
 * through untouched (core tool names are compared verbatim). */
export function normalizeMcpToolRef(name: string): string {
  if (!isMcpToolName(name)) return name;
  // Split off the server segment and rebuild via `mcpToolName` so the SAME
  // server-slug cap applies — otherwise a >105-char server name normalises to an
  // uncapped slug that never matches the (capped) materialised tool name, and the
  // allow/deny silently misses the whole toolset.
  const rest = name.slice(MCP_TOOL_NAMESPACE.length);
  const sep = rest.indexOf("__");
  if (sep < 0) return slug(name);
  return mcpToolName(rest.slice(0, sep), rest.slice(sep + 2));
}

interface McpContentBlock {
  type: string;
  text?: string;
}

/** Render an MCP tool result's content array to plain text for the LLM. Text
 * blocks pass through; non-text blocks (image / audio / resource) collapse to a
 * short placeholder — rich-content forwarding is deferred (MVP). */
function renderContent(content: unknown): string {
  if (content == null) return "";
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content as McpContentBlock[]) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block && typeof block.type === "string") parts.push(`[${block.type} content omitted]`);
  }
  return parts.join("\n");
}

function toFraguaTool(server: string, mcpTool: McpToolDescriptor, client: Client, callTimeoutMs: number): AnyTool {
  return {
    name: mcpToolName(server, mcpTool.name),
    description: mcpTool.description ?? `MCP tool "${mcpTool.name}" from server "${server}".`,
    // MCP hands us a raw JSON Schema; pi-ai's tool-argument validator has a
    // plain-JSON-Schema fallback (it only reaches for TypeBox compilation when
    // the schema carries the TypeBox Kind symbol), so no translation is needed.
    parameters: mcpParameters(mcpTool.inputSchema),
    // Side-effecting like `bash` — never re-run by the rehydrate sanitiser.
    idempotent: false,
    truncation: { max_chars: MCP_OUTPUT_MAX_CHARS, mode: "tail" },
    async execute(args, _env, opts): Promise<ToolOutput> {
      const requestOptions: { timeout: number; signal?: AbortSignal } = { timeout: callTimeoutMs };
      if (opts?.signal) requestOptions.signal = opts.signal;
      let result: unknown;
      try {
        result = await client.callTool(
          { name: mcpTool.name, arguments: (args ?? {}) as Record<string, unknown> },
          undefined,
          requestOptions,
        );
      } catch (err) {
        // A transport error / timeout / server crash becomes a tool-error result
        // the LLM can react to, not an uncaught throw that halts the whole run.
        return { text: `MCP tool "${mcpTool.name}" failed: ${(err as Error).message}`, is_error: true };
      }
      // MCP servers are operator opt-in (declared in .mcp.json), so their output
      // is trusted like any first-party tool — returned as-is (the `truncation`
      // policy above caps it downstream), no untrusted-content envelope.
      const out: ToolOutput = { text: renderContent((result as { content?: unknown }).content) };
      if ((result as { isError?: boolean }).isError === true) out.is_error = true;
      return out;
    },
  };
}

// A plain-object JSON Schema passes through; anything else (missing, a $ref, a
// non-object) falls back to an open object so a malformed schema can't wedge
// pi-ai's validator — no attempt to police a well-formed one.
function mcpParameters(inputSchema: unknown): TSchema {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema) && !("$ref" in inputSchema)) {
    return inputSchema as unknown as TSchema;
  }
  return { type: "object" } as unknown as TSchema;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface OpenConnection {
  client: Client;
  /** Kept so teardown can SIGKILL a hung stdio child (http transports have no pid). */
  transport: Transport;
}

type ServerResult =
  | { name: string; error: string; connection?: undefined; descriptors?: undefined }
  | { name: string; error?: undefined; connection: OpenConnection; descriptors: McpToolDescriptor[] };

async function connectServer(
  name: string,
  server: ResolvedMcpServer,
  connectTimeoutMs: number,
  listTimeoutMs: number,
  defaultCwd: string,
  signal?: AbortSignal,
  oauthProviderFor?: (url: string) => OAuthClientProvider | undefined,
): Promise<{ connection: OpenConnection; tools: McpToolDescriptor[] }> {
  const client = new Client({ name: `fragua-${name}`, version: "0.1.0" }, { capabilities: {} });
  // Only stdio carries a child + stderr; http has neither.
  let stderrTail = "";
  // Hoisted out of the try so the catch's `closeWithDeadline` can reach the
  // transport (to SIGKILL a hung stdio child).
  let transport: Transport | undefined;
  // Close on ANY failure — a post-connect listTools throw would otherwise leak
  // an stdio child (or a dangling http session) for the daemon's lifetime.
  try {
    if (server.transport === "http") {
      const parsedUrl = new URL(server.url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`unsupported url scheme "${parsedUrl.protocol}" (http/https only)`);
      }
      // Any credential over plaintext http to a NON-loopback host leaks it to an
      // on-path observer: ANY request header (not just `Authorization` — a custom
      // `X-Api-Key` is just as sensitive), or the OAuth path where the SDK attaches
      // `Bearer <access_token>` to every request. Refuse it (a `.mcp.json` copied
      // with `http://` for a remote server is the footgun). Loopback (127.0.0.0/8,
      // ::1, localhost) is exempt — that traffic never leaves the machine, and
      // local dev/proxy servers use it.
      if (parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
        if (Object.keys(server.headers).length > 0 || needsOAuthProvider(server, oauthProviderFor)) {
          throw new Error("refusing to send credentials over plaintext http to a non-loopback host — use https");
        }
      }
      // No static `Authorization` header + an injected factory → authenticate
      // through the OAuth provider. A provider persists tokens across runs and
      // (on the daemon) throws on redirect so an un-authed server is skipped
      // via the connect-failure path rather than hanging.
      const provider = needsOAuthProvider(server, oauthProviderFor) ? oauthProviderFor?.(server.url) : undefined;
      transport = new StreamableHTTPClientTransport(parsedUrl, {
        ...(provider ? { authProvider: provider } : {}),
        requestInit: { headers: server.headers },
      }) as Transport;
    } else {
      const stdio = new StdioClientTransport({
        command: server.command,
        args: server.args,
        // SDK allowlist (HOME/PATH/USER/…) as the base, NOT the daemon's full env —
        // provider keys must not leak into a third-party binary. Only `server.env` added.
        env: { ...getDefaultEnvironment(), ...server.env },
        // Run in the project dir (where mcp.json lives) by default, not the daemon's
        // launch dir; an author can override per-server via `cwd` in mcp.json.
        cwd: server.cwd ?? defaultCwd,
        // Piped so a spawn/handshake failure carries the child's own diagnostics.
        stderr: "pipe",
      });
      // Listener stays attached for the connection's lifetime: it drains the pipe
      // continuously (a paused pipe would fill its OS buffer and stall the child).
      // Keep the rolling TAIL, not the head — the last lines before a crash are the
      // useful diagnostic; a verbose-then-crashing server would otherwise show only
      // its startup banner.
      stdio.stderr?.on("data", (chunk: unknown) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX);
      });
      transport = stdio;
    }
    await client.connect(transport, { timeout: connectTimeoutMs, ...(signal ? { signal } : {}) });
    const listed = (await client.listTools(undefined, {
      timeout: listTimeoutMs,
      ...(signal ? { signal } : {}),
    })) as { tools?: McpToolDescriptor[] };
    return { connection: { client, transport }, tools: listed.tools ?? [] };
  } catch (err) {
    await closeWithDeadline(client, transport);
    // Redact resolved `server.env` values from the stderr tail BEFORE it becomes
    // the diagnostic — a stdio server that echoes its environment on a failed
    // start would otherwise write a credential (a token supplied via env, whose
    // shape the export scrubber's patterns may not match) verbatim into the
    // `agent.warning` event and any export bundle. Redact at the source instead.
    const tail = redactSecrets(stderrTail.trim(), server).slice(-500);
    const e = err instanceof Error ? err : new Error(String(err));
    if (tail) e.message = `${e.message} (server stderr: ${tail})`;
    throw e;
  }
}

/** Replace any resolved secret value (stdio only) that appears in `text` with a
 * placeholder: every `server.env` value, plus the value half of a `key=value`
 * `server.arg` (`${VAR}` substitutes into args too, so `--token=ghp_…` carries a
 * live credential). Values shorter than 8 chars are left alone — too short to be a
 * meaningful secret and likely to over-match innocuous output. Only arg VALUES are
 * redacted, not whole args, so package names / flags stay legible in the tail. */
function redactSecrets(text: string, server: ResolvedMcpServer): string {
  if (server.transport !== "stdio" || text.length === 0) return text;
  const secrets: string[] = [...Object.values(server.env ?? {})];
  const args = server.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf("=");
    // `--token=SECRET` → the value half.
    if (eq >= 0) {
      secrets.push(arg.slice(eq + 1));
      continue;
    }
    // `--token SECRET` → a non-flag arg that FOLLOWS a flag is a candidate value.
    // (Over-redacting a boolean-flag operand only blanks a token in the stderr
    // diagnostic — harmless — whereas missing it leaks a live credential.)
    const prev = args[i - 1];
    if (i > 0 && prev !== undefined && prev.startsWith("-") && !arg.startsWith("-")) secrets.push(arg);
  }
  let out = text;
  for (const v of secrets) {
    if (typeof v === "string" && v.length >= 8) out = out.split(v).join("«redacted»");
  }
  return out;
}

// Deadline-bounded so a dead child's never-draining `close()` can't wedge teardown.
async function closeWithDeadline(client: Client, transport?: Transport): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, CLOSE_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    // Clear the loser: when `close()` wins the race the deadline timer would
    // otherwise stay live (unref'd, but one per connection per step — noise in
    // leak-hunts). `dispose()` fans this out over every open connection.
    if (timer) clearTimeout(timer);
  }
  // `close()` is still hung on a child that ignored SIGTERM — SIGKILL it so we
  // don't orphan the process + its pipes + the stderr listener for the daemon's
  // lifetime. Only stdio transports have a pid; http returns undefined (no-op).
  if (timedOut) {
    const pid = (transport as { pid?: number | null } | undefined)?.pid;
    if (typeof pid === "number") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited — nothing to kill.
      }
    }
  }
}

export function createMcpConnector(deps?: McpConnectorDeps): McpConnector {
  return {
    async materialize(serverNames, opts): Promise<McpToolset> {
      // Resolve `${VAR}` against the project's .env/.env.local overlaid by
      // process.env (exported vars win) — so a token in .env.local reaches a
      // workflow run's MCP config without exporting it or restarting the daemon.
      const env = opts.env ?? resolveProjectEnv(opts.cwd);
      const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const requested = [...new Set(serverNames)];
      const tools: AnyTool[] = [];
      const errors: McpServerError[] = [];
      const open: OpenConnection[] = [];

      const config = loadMcpConfig(opts.cwd);
      if (!config.ok) {
        const message = config.error ?? `no mcp.json found at ${config.path}`;
        for (const name of requested) errors.push({ server: name, message, kind: "unavailable" });
        return { tools, errors, dispose: async () => {} };
      }

      // Connect every server concurrently — a slow/unreachable one no longer
      // serialises the others on the hot per-step path. `Promise.all` preserves
      // request order, so the fold below stays deterministic.
      const connected = await Promise.all(
        requested.map(async (name): Promise<ServerResult> => {
          if (opts.signal?.aborted) return { name, error: "run aborted before connect" };
          const raw = config.servers[name];
          if (raw === undefined) {
            const unsupported = config.unsupported[name];
            if (unsupported !== undefined) return { name, error: `unsupported transport: ${unsupported}` };
            return { name, error: `not defined in ${config.path}` };
          }
          const resolved = resolveMcpServer(raw, env);
          if (!resolved.ok) return { name, error: `missing environment variable(s): ${resolved.missing.join(", ")}` };
          try {
            const { connection, tools: descriptors } = await connectServer(
              name,
              resolved.server,
              connectTimeoutMs,
              DEFAULT_LIST_TIMEOUT_MS,
              opts.cwd,
              opts.signal,
              deps?.oauthProviderFor,
            );
            return { name, connection, descriptors };
          } catch (err) {
            return { name, error: `failed to connect: ${(err as Error).message}` };
          }
        }),
      );

      // First-wins dedup: two tools slugging to one name would route ambiguously.
      const seenNames = new Set<string>();
      for (const r of connected) {
        if (r.error !== undefined) {
          errors.push({ server: r.name, message: r.error, kind: "unavailable" });
          continue;
        }
        open.push(r.connection);
        for (const d of r.descriptors) {
          const tool = toFraguaTool(r.name, d, r.connection.client, callTimeoutMs);
          if (seenNames.has(tool.name)) {
            errors.push({
              server: r.name,
              message: `tool "${tool.name}" collides with an earlier tool of the same name; skipped`,
              kind: "collision",
            });
            continue;
          }
          seenNames.add(tool.name);
          tools.push(tool);
        }
      }

      let disposed = false;
      return {
        tools,
        errors,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await Promise.allSettled(open.map((c) => closeWithDeadline(c.client, c.transport)));
        },
      };
    },
  };
}
