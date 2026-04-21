// Resolve configuration values that may be shell commands, environment
// variables, or literals. Feeds AuthStorage + ModelRegistry so a secret
// never has to live literally in auth.json / models.json — the user
// points at their preferred secret manager instead.
//
// Adapted from pi-coding-agent (https://github.com/badlogic/pi-mono,
// packages/coding-agent/src/core/resolve-config-value.ts and
// packages/coding-agent/src/utils/shell.ts) — MIT. Upstream in
// @mariozechner/pi-mono. Revisit if the pi project splits this out.
//
// Swarm-specific deltas:
// - Inlined a minimal getShellConfig (unix /bin/bash; windows bash+sh
//   fallback) to avoid porting the full utils/shell.ts.
// - `invalidateCommandCache(cmd)` exposes cache eviction so a daemon
//   can drop a stale `!op read …` result after a 401/403 auth failure
//   and retry once (see credentials/auth-storage.ts).

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

interface ShellConfig {
  shell: string;
  args: string[];
}

function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (existsSync(customShellPath)) return { shell: customShellPath, args: ["-c"] };
    throw new Error(`Custom shell path not found: ${customShellPath}`);
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    ];
    for (const p of candidates) {
      if (existsSync(p)) return { shell: p, args: ["-c"] };
    }
    return { shell: "bash.exe", args: ["-c"] };
  }
  if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
  return { shell: "sh", args: ["-c"] };
}

// Process-lifetime cache for shell command results. Invalidated on
// auth failure via invalidateCommandCache() — no TTL, because picking
// one is worse than not having one (different commands need different
// strategies). Matches upstream behaviour.
const commandResultCache = new Map<string, string | undefined>();

/**
 * Resolve a config value to an actual value.
 * - `!cmd` → execute via shell, cache stdout for process lifetime.
 * - `NAME` (matches a defined env var) → that env var's value.
 * - anything else → literal.
 */
export function resolveConfigValue(config: string): string | undefined {
  if (config.startsWith("!")) return executeCommand(config);
  const envValue = process.env[config];
  return envValue || config;
}

/** Same rules as resolveConfigValue but bypasses the command cache.
 * Use when freshness matters more than the ~20-200ms subprocess cost. */
export function resolveConfigValueUncached(config: string): string | undefined {
  if (config.startsWith("!")) return executeCommandUncached(config);
  const envValue = process.env[config];
  return envValue || config;
}

/** Resolve or throw with a descriptive error. Always uncached — callers
 * that want caching go through resolveConfigValue. */
export function resolveConfigValueOrThrow(config: string, description: string): string {
  const resolvedValue = resolveConfigValueUncached(config);
  if (resolvedValue !== undefined) return resolvedValue;
  if (config.startsWith("!")) {
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }
  throw new Error(`Failed to resolve ${description}`);
}

/** Walk a headers map through resolveConfigValue. */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const resolvedValue = resolveConfigValue(value);
    if (resolvedValue) resolved[key] = resolvedValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Walk a headers map through resolveConfigValueOrThrow. */
export function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Drop the whole `!cmd` result cache. Mostly for tests. */
export function clearConfigValueCache(): void {
  commandResultCache.clear();
}

/** Drop a single `!cmd` entry. Daemons call this on 401/403 to
 * force the next read to re-execute — e.g. 1Password session expired,
 * AWS STS token rotated. Accepts the original config form ("!cmd")
 * so callers don't have to know about the slice-off-the-bang. */
export function invalidateCommandCache(configOrCommand: string): void {
  const key = configOrCommand.startsWith("!") ? configOrCommand : `!${configOrCommand}`;
  commandResultCache.delete(key);
}

function executeCommand(commandConfig: string): string | undefined {
  if (commandResultCache.has(commandConfig)) return commandResultCache.get(commandConfig);
  const result = executeCommandUncached(commandConfig);
  commandResultCache.set(commandConfig, result);
  return result;
}

function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  if (process.platform !== "win32") return executeWithDefaultShell(command);
  const configuredResult = executeWithConfiguredShell(command);
  return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
}

function executeWithDefaultShell(command: string): string | undefined {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
  try {
    const { shell, args } = getShellConfig();
    const result = spawnSync(shell, [...args, command], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { executed: false, value: undefined };
      return { executed: true, value: undefined };
    }
    if (result.status !== 0) return { executed: true, value: undefined };
    const value = (result.stdout ?? "").trim();
    return { executed: true, value: value || undefined };
  } catch {
    return { executed: false, value: undefined };
  }
}
