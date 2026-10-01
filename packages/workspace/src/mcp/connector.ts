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

import {
  type CallToolResult,
  McpClient,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import { adaptOAuthProvider, type McpOAuthProvider } from "@earendil-works/pi-mcp/oauth";
import { byName } from "@fragua/core";
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

// The safe base environment handed to every stdio MCP child. pi-mcp has no
// `getDefaultEnvironment()` equivalent, so we reproduce the MCP SDK's
// DEFAULT_INHERITED_ENV_VARS allowlist verbatim: a stdio server inherits only
// these keys from the daemon's environment (never provider API keys), then
// `server.env` is layered on top with `inheritEnv:false`.
const DEFAULT_INHERITED_ENV_VARS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/** The allowlisted base env for a stdio child: each DEFAULT_INHERITED_ENV_VARS
 * key that is set and not a bash function export (`() {`). Mirrors the SDK's
 * `getDefaultEnvironment()` so daemon secrets never reach a third-party binary. */
function defaultInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined || value.startsWith("()")) continue;
    env[key] = value;
  }
  return env;
}

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
 * sees only pi-mcp's `McpOAuthProvider` type and this factory, never
 * @fragua/store. */
export interface McpConnectorDeps {
  /** Given a remote server URL, return an OAuth provider to drive interactive
   * auth + token persistence, or `undefined` to skip OAuth for it. Consulted
   * only for http servers with no static `Authorization` header. */
  oauthProviderFor?: (url: string) => McpOAuthProvider | undefined;
}

/** Decide whether a resolved server should authenticate through an injected
 * OAuth provider: only http, only when a factory is present, and only when the
 * server carries NO static `Authorization` header (case-insensitive). A static
 * header always wins — the OAuth path stays off. Extracted so the decision is
 * testable without a live server. */
export function needsOAuthProvider(
  server: ResolvedMcpServer,
  oauthProviderFor?: (url: string) => McpOAuthProvider | undefined,
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

/** Flatten a tool result to text via pi-mcp's `toLlmContent` (text and embedded
 * text resources pass through; images, audio, resource links and binary blobs
 * become placeholders), then collapse the image placeholders to plain text for
 * fragua's text-only `ToolOutput`. */
function renderContent(result: CallToolResult): string {
  return toLlmContent(result)
    .map((block) => (block.type === "text" ? block.text : "[image content omitted]"))
    .join("\n");
}

function toFraguaTool(server: string, mcpTool: McpToolDescriptor, client: McpClient, callTimeoutMs: number): AnyTool {
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
      const requestOptions: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: callTimeoutMs };
      if (opts?.signal) requestOptions.signal = opts.signal;
      let result: CallToolResult;
      try {
        result = await client.callTool(mcpTool.name, (args ?? {}) as Record<string, unknown>, requestOptions);
      } catch (err) {
        // A transport error / timeout / server crash becomes a tool-error result
        // the LLM can react to, not an uncaught throw that halts the whole run.
        return { text: `MCP tool "${mcpTool.name}" failed: ${(err as Error).message}`, is_error: true };
      }
      // MCP servers are operator opt-in (declared in .mcp.json), so their output
      // is trusted like any first-party tool — returned as-is (the `truncation`
      // policy above caps it downstream), no untrusted-content envelope.
      const out: ToolOutput = { text: renderContent(result) };
      if (result.isError === true) out.is_error = true;
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

type McpToolDescriptor = Tool;

interface OpenConnection {
  client: McpClient;
  /** Kept for diagnostics / the stdio `pid`; teardown runs through `client.close()`,
   * which tears the transport down (StdioTransport SIGKILLs a hung child itself). */
  transport: McpTransport;
}

type ServerResult =
  | { name: string; error: string; connection?: undefined; descriptors?: undefined }
  | { name: string; error?: undefined; connection: OpenConnection; descriptors: McpToolDescriptor[] };

// `McpClient.connect` takes no timeout/signal, so bound it ourselves: race the
// connect against the connect-timeout and the run's abort signal. On loss the
// caller's catch closes the half-open client (StdioTransport reaps any child).
async function connectWithDeadline(
  client: McpClient,
  transport: McpTransport,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const races: Promise<unknown>[] = [
    client.connect(transport),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connect timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ];
  const abortError = (): Error => new Error("aborted");
  let onAbort: (() => void) | undefined;
  if (signal) {
    races.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) return reject(abortError());
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    );
  }
  try {
    await Promise.race(races);
  } finally {
    if (timer) clearTimeout(timer);
    // The run's signal outlives this connect; drop the listener so repeated
    // connects don't accumulate one closure each on it.
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function connectServer(
  name: string,
  server: ResolvedMcpServer,
  connectTimeoutMs: number,
  listTimeoutMs: number,
  defaultCwd: string,
  signal?: AbortSignal,
  oauthProviderFor?: (url: string) => McpOAuthProvider | undefined,
): Promise<{ connection: OpenConnection; tools: McpToolDescriptor[] }> {
  const client = new McpClient({ name: `fragua-${name}`, version: "0.1.0", capabilities: {} });
  // Only stdio carries a child + stderr; http has neither.
  let stderrTail = "";
  // Hoisted out of the try so the catch's `closeWithDeadline` can reach the client.
  let transport: McpTransport | undefined;
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
      transport = new StreamableHttpTransport({
        url: parsedUrl,
        headers: server.headers,
        ...(provider ? { authProvider: adaptOAuthProvider(provider) } : {}),
      });
    } else {
      transport = new StdioTransport({
        command: server.command,
        args: server.args,
        // Allowlist (HOME/PATH/USER/…) as the base, NOT the daemon's full env —
        // provider keys must not leak into a third-party binary. Only `server.env`
        // is added on top; `inheritEnv:false` keeps pi-mcp from adding anything else.
        env: { ...defaultInheritedEnv(), ...server.env },
        inheritEnv: false,
        // Run in the project dir (where mcp.json lives) by default, not the daemon's
        // launch dir; an author can override per-server via `cwd` in mcp.json.
        cwd: server.cwd ?? defaultCwd,
        // Piped so a spawn/handshake failure carries the child's own diagnostics.
        // Keep the rolling TAIL, not the head — the last lines before a crash are the
        // useful diagnostic; a verbose-then-crashing server would otherwise show only
        // its startup banner.
        stderr: "pipe",
        onStderr: (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX);
        },
      });
    }
    await connectWithDeadline(client, transport, connectTimeoutMs, signal);
    const listed = await client.listTools({ timeoutMs: listTimeoutMs, ...(signal ? { signal } : {}) });
    return { connection: { client, transport }, tools: listed };
  } catch (err) {
    await closeWithDeadline(client);
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

// Deadline-bounded so a dead child's never-draining `close()` can't wedge
// teardown. `McpClient.close()` tears the transport down, and `StdioTransport`
// escalates SIGTERM→SIGKILL on a child that ignores stdin-close (its own
// `closeTimeoutMs`), so no manual `process.kill` is needed here — the deadline
// only guards against `close()` itself never resolving.
async function closeWithDeadline(client: McpClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLOSE_DEADLINE_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    // Clear the loser: when `close()` wins the race the deadline timer would
    // otherwise stay live (unref'd, but one per connection per step — noise in
    // leak-hunts). `dispose()` fans this out over every open connection.
    if (timer) clearTimeout(timer);
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
      // Maps the slugged name to the server + RAW descriptor name that claimed
      // it. A bare `Set` can only say "taken" — and both sides of a collision
      // share the slug, so the error would name the loser twice and leave
      // "which descriptor am I actually calling?" unanswerable from the log.
      // Scoped across ALL servers, not per server: two server names that slug
      // alike (`my-server` / `my_server`) collide in the same namespace.
      const claimedBy = new Map<string, { server: string; tool: string }>();
      for (const r of connected) {
        if (r.error !== undefined) {
          errors.push({ server: r.name, message: r.error, kind: "unavailable" });
          continue;
        }
        open.push(r.connection);
        // Sort before materialising, so the first-wins dedup below is
        // deterministic: `tools/list` order is the server's choice and can
        // change under us (a version bump inserting a tool mid-list is
        // enough), and without a sort here *which* of two colliding names
        // survives would depend on the server's response order. Cache-prefix
        // stability is already guaranteed downstream by the backend's final
        // `tools.sort(byName)`; this sort is what makes the surviving SET
        // stable, not just its order.
        //
        // Sort key is the SLUGGED name — the same space the dedup below keys
        // on — with the raw name as tiebreaker. Slugging alone is not enough:
        // colliding descriptors slug to equal keys, so a slug-only comparator
        // returns 0 for exactly the pairs that matter and a stable sort then
        // falls back to the server's response order, reintroducing the
        // non-determinism this sort exists to remove. The raw-name tiebreak
        // is what actually pins the winner.
        const descriptors = [...r.descriptors].sort((a, b) => {
          const sa = mcpToolName(r.name, a.name);
          const sb = mcpToolName(r.name, b.name);
          if (sa !== sb) return sa < sb ? -1 : 1;
          return byName(a, b);
        });
        for (const d of descriptors) {
          const tool = toFraguaTool(r.name, d, r.connection.client, callTimeoutMs);
          const winner = claimedBy.get(tool.name);
          if (winner !== undefined) {
            errors.push({
              server: r.name,
              message: `tool "${d.name}" slugs to "${tool.name}", already claimed by "${winner.tool}" from server "${winner.server}"; skipped`,
              kind: "collision",
            });
            continue;
          }
          claimedBy.set(tool.name, { server: r.name, tool: d.name });
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
          await Promise.allSettled(open.map((c) => closeWithDeadline(c.client)));
        },
      };
    },
  };
}
