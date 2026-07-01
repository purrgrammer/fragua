// MCP connector — fragua is the MCP *client*. Given a set of server names
// declared on an llm step (`mcp-servers:`), it loads `<cwd>/.fragua/mcp.json`,
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TSchema } from "@sinclair/typebox";
import type { AnyTool, ToolOutput } from "../types.ts";
import { loadMcpConfig, resolveMcpServer } from "./config.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_NAME_LEN = 128;

export interface McpMaterializeOptions {
  /** Project cwd — `<cwd>/.fragua/mcp.json` is the server registry. */
  cwd: string;
  /** Environment for `${VAR}` substitution. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Abort in-flight tool calls (wired from the run's signal). */
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/** A server that was requested but produced no tools. */
export interface McpServerError {
  server: string;
  message: string;
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

/** Slugify a server / tool segment to the `[a-z0-9_]` alphabet. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${slug(server)}__${slug(tool)}`;
  if (name.length <= MAX_TOOL_NAME_LEN) return name;
  return name.slice(0, MAX_TOOL_NAME_LEN);
}

interface McpContentBlock {
  type: string;
  text?: string;
}

/** Render an MCP tool result's content array to plain text for the LLM. Text
 * blocks pass through; non-text blocks (image / audio / resource) collapse to a
 * short placeholder — rich-content forwarding is deferred (MVP). */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? null);
  const parts: string[] = [];
  for (const block of content as McpContentBlock[]) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block && typeof block.type === "string") parts.push(`[${block.type} content omitted]`);
  }
  return parts.join("\n");
}

function toFraguaTool(server: string, mcpTool: McpToolDescriptor, client: Client, callTimeoutMs: number): AnyTool {
  const inputSchema = mcpTool.inputSchema ?? { type: "object" };
  return {
    name: mcpToolName(server, mcpTool.name),
    description: mcpTool.description ?? `MCP tool "${mcpTool.name}" from server "${server}".`,
    // MCP hands us a raw JSON Schema; pi-ai's tool-argument validator has a
    // plain-JSON-Schema fallback (it only reaches for TypeBox compilation when
    // the schema carries the TypeBox Kind symbol), so no translation is needed.
    parameters: inputSchema as unknown as TSchema,
    // Side-effecting like `bash` — never re-run by the rehydrate sanitiser.
    idempotent: false,
    truncation: { max_chars: 100_000, mode: "tail" },
    async execute(args, _env, opts): Promise<ToolOutput> {
      const requestOptions: { timeout: number; signal?: AbortSignal } = { timeout: callTimeoutMs };
      if (opts?.signal) requestOptions.signal = opts.signal;
      const result = await client.callTool(
        { name: mcpTool.name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        requestOptions,
      );
      const text = renderContent((result as { content?: unknown }).content);
      const isError = (result as { isError?: boolean }).isError === true;
      const out: ToolOutput = { text };
      if (isError) out.is_error = true;
      return out;
    },
  };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface OpenConnection {
  client: Client;
  transport: StdioClientTransport;
}

async function connectServer(
  name: string,
  server: { command: string; args: string[]; env: Record<string, string>; cwd?: string },
  connectTimeoutMs: number,
  listTimeoutMs: number,
): Promise<{ connection: OpenConnection; tools: McpToolDescriptor[] }> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    // Start from the SDK's hardened default allowlist (HOME / PATH / USER / …)
    // so the child gets a working PATH WITHOUT inheriting the daemon's whole
    // environment — provider API keys and other secrets must not leak into a
    // third-party server binary. Only the server's own resolved `env:` is added.
    env: { ...getDefaultEnvironment(), ...server.env },
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    stderr: "ignore",
  });
  const client = new Client({ name: `fragua-${name}`, version: "0.1.0" }, { capabilities: {} });
  // `connect` self-closes the transport if `initialize` fails, so a connect
  // error leaves nothing spawned. `listTools` runs AFTER connect succeeds, so a
  // failure there must close the client ourselves — otherwise the already-
  // spawned child process leaks for the daemon's lifetime.
  await client.connect(transport, { timeout: connectTimeoutMs });
  try {
    const listed = (await client.listTools(undefined, { timeout: listTimeoutMs })) as { tools?: McpToolDescriptor[] };
    return { connection: { client, transport }, tools: listed.tools ?? [] };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

export function createMcpConnector(): McpConnector {
  return {
    async materialize(serverNames, opts): Promise<McpToolset> {
      const env = opts.env ?? process.env;
      const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const requested = [...new Set(serverNames)];
      const tools: AnyTool[] = [];
      const errors: McpServerError[] = [];
      const open: OpenConnection[] = [];

      const config = loadMcpConfig(opts.cwd);
      if (!config.ok) {
        const message = config.error ?? `no mcp.json found at ${config.path}`;
        for (const name of requested) errors.push({ server: name, message });
        return { tools, errors, dispose: async () => {} };
      }

      for (const name of requested) {
        const raw = config.servers[name];
        if (raw === undefined) {
          errors.push({ server: name, message: `not defined in ${config.path}` });
          continue;
        }
        const resolved = resolveMcpServer(raw, env);
        if (!resolved.ok) {
          errors.push({ server: name, message: `missing environment variable(s): ${resolved.missing.join(", ")}` });
          continue;
        }
        try {
          const { connection, tools: descriptors } = await connectServer(
            name,
            resolved.server,
            connectTimeoutMs,
            connectTimeoutMs,
          );
          open.push(connection);
          for (const d of descriptors) tools.push(toFraguaTool(name, d, connection.client, callTimeoutMs));
        } catch (err) {
          errors.push({ server: name, message: `failed to connect: ${(err as Error).message}` });
        }
      }

      return {
        tools,
        errors,
        dispose: async () => {
          await Promise.allSettled(open.map((c) => c.client.close()));
        },
      };
    },
  };
}
