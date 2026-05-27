// Registry assembly and JSON-string deep-scrub for exportRunBundle.
// Pure, deterministic — no I/O, no clock, no random.

import type { ProviderCredentialRow } from "../types.ts";
import { BASE_PATTERNS } from "./patterns.ts";
import { type CompiledRegistry, compileRegistry } from "./registry.ts";
import { type ScrubOptions, scrubText } from "./scrub.ts";

// ---------------------------------------------------------------------------
// Literal extraction from credential payloads
// ---------------------------------------------------------------------------

/**
 * Extract the actual secret string(s) from a parsed provider-credential
 * payload. Returns only strings; non-string values are silently skipped.
 * The value-length floor in `compileRegistry` covers short or empty values.
 *
 * Supported shapes:
 *   api_key: { type: "api_key", key: "<secret>" }
 *   oauth:   { type: "oauth", accessToken: "...", refreshToken: "..." }
 */
export function extractCredentialLiterals(row: ProviderCredentialRow): string[] {
  const p = row.payload;
  if (p == null || typeof p !== "object" || Array.isArray(p)) return [];
  const obj = p as Record<string, unknown>;

  const results: string[] = [];
  const pick = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0) results.push(v);
  };

  if (row.kind === "api_key") {
    pick(obj["key"]);
  } else if (row.kind === "oauth") {
    pick(obj["accessToken"]);
    pick(obj["refreshToken"]);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Registry assembly
// ---------------------------------------------------------------------------

/**
 * Build a compiled registry for `exportRunBundle`. Includes:
 *   - All provider-credential secret values as `provider_creds` literals.
 *   - The run's `cwd` path as a `cwd` literal (when present).
 *   - The full `BASE_PATTERNS` set.
 *
 * Build once per export, then pass to `scrubJsonStrings` for each message.
 */
export function buildExportRegistry(opts: {
  providerCredentials: ProviderCredentialRow[];
  cwd: string | null;
}): CompiledRegistry {
  const literals: Array<{ value: string; source: string }> = [];

  for (const row of opts.providerCredentials) {
    for (const value of extractCredentialLiterals(row)) {
      literals.push({ value, source: "provider_creds" });
    }
  }

  if (opts.cwd != null) {
    literals.push({ value: opts.cwd, source: "cwd" });
  }

  return compileRegistry({ literals, patterns: [...BASE_PATTERNS] });
}

// ---------------------------------------------------------------------------
// Deep JSON-string scrub
// ---------------------------------------------------------------------------

/**
 * Recursively walk `value` (arbitrary JSON) and replace every string leaf
 * with `scrubText(string, registry, opts)`. Non-string primitives pass
 * through unchanged. Key names are never scrubbed — only string values.
 *
 * Safe for message content because `deriveRunState` never reads messages;
 * redaction cannot affect import/replay.
 */
export function scrubJsonStrings<T>(value: T, registry: CompiledRegistry, opts?: ScrubOptions): T {
  if (typeof value === "string") {
    return scrubText(value, registry, opts) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubJsonStrings(v, registry, opts)) as unknown as T;
  }
  if (value != null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k] = scrubJsonStrings(src[k], registry, opts);
    }
    return out as unknown as T;
  }
  return value;
}
