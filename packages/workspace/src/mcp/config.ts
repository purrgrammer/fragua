// Load and resolve `<cwd>/.fragua/mcp.json` — the project-level MCP server
// registry. Standard MCP client shape: `{ "mcpServers": { name: {command,
// args?, env?, cwd?} } }`. `${VAR}` in command / args / env values is
// substituted from the supplied environment; a referenced-but-unset var makes
// the server unusable (skipped with an error at connect time) rather than
// spawning a half-configured process.
//
// See docs/proposals/mcp-tools.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A server entry as authored in mcp.json (pre-substitution). */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A server entry with all `${VAR}` refs resolved, ready to spawn. */
export interface ResolvedMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface McpConfigLoad {
  /** Absolute path we looked at. */
  path: string;
  /** True when the file exists and parsed into a valid `mcpServers` map. */
  ok: boolean;
  /** Server name → raw config. Empty when the file is absent or malformed. */
  servers: Record<string, McpServerConfig>;
  /** Populated when the file exists but could not be parsed / validated. */
  error?: string;
}

const MCP_CONFIG_RELPATH = join(".fragua", "mcp.json");

/** `${NAME}` references. Bare `$NAME` is intentionally NOT a reference — it
 * stays literal, matching the workflow substitution grammar's "a bare `$name`
 * is literal text" rule. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function mcpConfigPath(cwd: string): string {
  return join(cwd, MCP_CONFIG_RELPATH);
}

function isServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const command = v["command"];
  const args = v["args"];
  const cwd = v["cwd"];
  const env = v["env"];
  if (typeof command !== "string" || command === "") return false;
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string"))) return false;
  if (cwd !== undefined && typeof cwd !== "string") return false;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null) return false;
    if (!Object.values(env as Record<string, unknown>).every((e) => typeof e === "string")) return false;
  }
  return true;
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
    return { path, ok: false, servers: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { path, ok: false, servers: {}, error: `mcp.json is not valid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || !("mcpServers" in parsed)) {
    return { path, ok: false, servers: {}, error: 'mcp.json must contain an "mcpServers" object' };
  }
  const map = (parsed as { mcpServers: unknown }).mcpServers;
  if (typeof map !== "object" || map === null) {
    return { path, ok: false, servers: {}, error: '"mcpServers" must be an object' };
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isServerConfig(entry)) {
      return { path, ok: false, servers: {}, error: `mcp server "${name}" is malformed (need a string "command")` };
    }
    servers[name] = entry;
  }
  return { path, ok: true, servers };
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

  const command = collect(substitute(config.command, env));
  const args = (config.args ?? []).map((a) => collect(substitute(a, env)));
  const resolvedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.env ?? {})) {
    resolvedEnv[k] = collect(substitute(v, env));
  }
  const cwd = config.cwd !== undefined ? collect(substitute(config.cwd, env)) : undefined;

  if (missing.length > 0) return { ok: false, missing };
  const server: ResolvedMcpServer = { command, args, env: resolvedEnv };
  if (cwd !== undefined) server.cwd = cwd;
  return { ok: true, server };
}
