// Load and resolve `<cwd>/.mcp.json` — the project-root MCP server registry,
// the same file and `{ "mcpServers": {…} }` shape Claude Code and other tools
// read, so a repo already configured for MCP works with fragua unchanged. Each
// entry is stdio (`command`/`args`/`env`/`cwd`) or Streamable HTTP (`type:http`,
// `url`, `headers`); legacy `sse` is recognised-but-unsupported. `${VAR}` in any
// string value is substituted from the supplied environment; a referenced-but-
// unset var makes the server unusable (skipped with an error at connect time)
// rather than connecting half-configured.
//
// See docs/proposals/mcp-tools.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A stdio server entry as authored in mcp.json (pre-substitution). */
export interface McpStdioServerConfig {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A Streamable-HTTP server entry (pre-substitution). `headers` carries static
 * auth (`Authorization: Bearer ${TOKEN}`); OAuth is layered on later via an
 * authProvider, not the file. */
export interface McpHttpServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** A server entry with all `${VAR}` refs resolved, ready to connect. */
export type ResolvedMcpServer =
  | { transport: "stdio"; command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { transport: "http"; url: string; headers: Record<string, string> };

export interface McpConfigLoad {
  /** Absolute path we looked at. */
  path: string;
  /** True when the file exists and parsed into a valid `mcpServers` map. */
  ok: boolean;
  /** Stdio server name → raw config. Empty when the file is absent or malformed. */
  servers: Record<string, McpServerConfig>;
  /** Servers we recognised but can't run yet (name → reason), e.g. an `http`
   * / `sse` entry in a `.mcp.json` shared with other tools. Kept separate so a
   * mixed file's stdio servers still work and a request for a remote one gets a
   * clear "unsupported transport" message instead of "not defined". */
  unsupported: Record<string, string>;
  /** Populated when the file exists but could not be parsed / validated. */
  error?: string;
}

const MCP_CONFIG_RELPATH = ".mcp.json";

/** `${NAME}` references. Bare `$NAME` is intentionally NOT a reference — it
 * stays literal, matching the workflow substitution grammar's "a bare `$name`
 * is literal text" rule. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function mcpConfigPath(cwd: string): string {
  return join(cwd, MCP_CONFIG_RELPATH);
}

/** Parse `KEY=VALUE` lines from a dotenv-style file; `{}` if absent/unreadable.
 * Minimal by design (no dependency): `#` comments, optional `export `, and
 * surrounding matching quotes are handled; anything else is a literal value. */
function parseEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Project-scoped `${VAR}` sources for MCP config: `<cwd>/.env` then
 * `<cwd>/.env.local` (local overrides base). Callers merge `process.env` OVER
 * this so an explicitly-exported var always wins — and so this works for the
 * compiled binary + a long-lived daemon without relying on bun's implicit,
 * start-time dotenv load. */
export function loadProjectEnv(cwd: string): Record<string, string> {
  return { ...parseEnvFile(join(cwd, ".env")), ...parseEnvFile(join(cwd, ".env.local")) };
}

type ServerClass =
  | { kind: "server"; config: McpServerConfig }
  | { kind: "unsupported"; reason: string }
  | { kind: "malformed" };

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && Object.values(value).every((e) => typeof e === "string");
}

/** Classify a raw `mcpServers` entry. A `command` entry is a stdio server; a
 * `type: http` (or `url`) entry is a Streamable-HTTP server; a `type: sse` entry
 * is recognised-but-unsupported (deprecated transport, skipped not errored);
 * anything else is malformed. */
function classifyServer(value: unknown): ServerClass {
  if (typeof value !== "object" || value === null) return { kind: "malformed" };
  const v = value as Record<string, unknown>;
  const command = v["command"];
  if (typeof command === "string" && command !== "") {
    const args = v["args"];
    const cwd = v["cwd"];
    const env = v["env"];
    if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string")))
      return { kind: "malformed" };
    if (cwd !== undefined && typeof cwd !== "string") return { kind: "malformed" };
    if (env !== undefined && !isStringRecord(env)) return { kind: "malformed" };
    const config: McpStdioServerConfig = { transport: "stdio", command };
    if (Array.isArray(args)) config.args = args as string[];
    if (isStringRecord(env)) config.env = env;
    if (typeof cwd === "string") config.cwd = cwd;
    return { kind: "server", config };
  }
  const type = v["type"];
  const url = v["url"];
  if (type === "sse") return { kind: "unsupported", reason: "sse transport (deprecated; use streamable http)" };
  if (typeof url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    const headers = v["headers"];
    if (headers !== undefined && !isStringRecord(headers)) return { kind: "malformed" };
    const config: McpHttpServerConfig = { transport: "http", url };
    if (isStringRecord(headers)) config.headers = headers;
    return { kind: "server", config };
  }
  return { kind: "malformed" };
}

/** Read + parse mcp.json. Never throws — a malformed file surfaces as
 * `{ ok: false, error }` so the caller can skip the requested servers with a
 * clear message instead of crashing the daemon. */
export function loadMcpConfig(cwd: string): McpConfigLoad {
  const path = mcpConfigPath(cwd);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { path, ok: false, servers: {}, unsupported: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      path,
      ok: false,
      servers: {},
      unsupported: {},
      error: `.mcp.json is not valid JSON: ${(err as Error).message}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    return { path, ok: false, servers: {}, unsupported: {}, error: '.mcp.json must contain an "mcpServers" object' };
  }
  const map = (parsed as { mcpServers: unknown }).mcpServers;
  if (typeof map !== "object" || map === null) {
    return { path, ok: false, servers: {}, unsupported: {}, error: '"mcpServers" must be an object' };
  }
  const servers: Record<string, McpServerConfig> = {};
  const unsupported: Record<string, string> = {};
  for (const [name, entry] of Object.entries(map)) {
    const cls = classifyServer(entry);
    if (cls.kind === "server") servers[name] = cls.config;
    else if (cls.kind === "unsupported") unsupported[name] = cls.reason;
    // A single malformed entry must NOT disable every valid server in the file —
    // record it like an unsupported one and carry on, so the rest still load.
    else unsupported[name] = 'malformed (need a string "command" for stdio, or a "url" for http)';
  }
  return { path, ok: true, servers, unsupported };
}

interface SubstituteResult {
  value: string;
  missing: string[];
}

function substitute(input: string, env: Record<string, string | undefined>): SubstituteResult {
  const missing: string[] = [];
  const value = input.replace(ENV_REF, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return resolved;
  });
  return { value, missing };
}

export interface ResolveOk {
  ok: true;
  server: ResolvedMcpServer;
}
export interface ResolveErr {
  ok: false;
  /** Env var names referenced by the config but absent from `env`. */
  missing: string[];
}

/** Substitute every `${VAR}` in a server config from `env`. Any unresolved
 * reference (across command, args, env values, cwd) makes the whole server
 * unresolvable — the caller skips it. */
export function resolveMcpServer(
  config: McpServerConfig,
  env: Record<string, string | undefined>,
): ResolveOk | ResolveErr {
  const missing: string[] = [];
  const collect = (r: SubstituteResult): string => {
    for (const m of r.missing) if (!missing.includes(m)) missing.push(m);
    return r.value;
  };

  if (config.transport === "http") {
    const url = collect(substitute(config.url, env));
    const headers: Record<string, string> = {};
    // Strip CR/LF from resolved header values so a substituted env var can't
    // smuggle an extra header / split the request.
    for (const [k, v] of Object.entries(config.headers ?? {})) {
      headers[k] = collect(substitute(v, env)).replace(/[\r\n]/g, "");
    }
    if (missing.length > 0) return { ok: false, missing };
    return { ok: true, server: { transport: "http", url, headers } };
  }

  const command = collect(substitute(config.command, env));
  const args = (config.args ?? []).map((a) => collect(substitute(a, env)));
  const resolvedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env ?? {})) {
    resolvedEnv[k] = collect(substitute(v, env));
  }
  const cwd = config.cwd !== undefined ? collect(substitute(config.cwd, env)) : undefined;

  if (missing.length > 0) return { ok: false, missing };
  const server: ResolvedMcpServer =
    cwd !== undefined
      ? { transport: "stdio", command, args, env: resolvedEnv, cwd }
      : { transport: "stdio", command, args, env: resolvedEnv };
  return { ok: true, server };
}
