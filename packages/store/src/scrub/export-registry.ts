// Registry assembly and JSON-string deep-scrub for exportRunBundle.
// Pure, deterministic — no I/O, no clock, no random.

import { isBlobRef } from "../routing-blobs.ts";
import type { ProviderCredentialRow } from "../types.ts";
import { BASE_PATTERNS } from "./patterns.ts";
import { type CompiledPattern, type CompiledRegistry, compilePatterns, compileRegistry } from "./registry.ts";
import { type ScrubOptions, scrubText } from "./scrub.ts";

// Memoised: compileRegistry adds the /g flag and allocates new RegExp objects.
// Building these once per module load avoids redundant allocations on every export.
const COMPILED_BASE_PATTERNS: CompiledPattern[] = compilePatterns(BASE_PATTERNS);

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
  /** Extra literal needles merged in before compilation (e.g. CI env secrets). */
  extraLiterals?: Array<{ value: string; source: string }>;
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

  if (opts.extraLiterals != null) {
    for (const lit of opts.extraLiterals) {
      literals.push(lit);
    }
  }

  return compileRegistry({ literals, patterns: COMPILED_BASE_PATTERNS });
}

// ---------------------------------------------------------------------------
// Artifact mime-type classification
// ---------------------------------------------------------------------------

const TEXT_APPLICATION_MIMES = new Set([
  "application/json",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
]);

/**
 * Returns true when the artifact's mime type is text-ish and its bytes can
 * be decoded as UTF-8, scrubbed, and re-CASed consistently.
 *
 * Text-ish = `text/*` or the application sub-types above.
 * Everything else (binary, unknown, null) is skipped — a known residual;
 * see docs/proposals/secret-scrubbing.md §13.
 */
export function isTextMime(mime: string | null): boolean {
  if (mime == null) return false;
  if (mime.startsWith("text/")) return true;
  const base = mime.split(";")[0]!.trim();
  return TEXT_APPLICATION_MIMES.has(base);
}

// ---------------------------------------------------------------------------
// Event payload free-text scrub
// ---------------------------------------------------------------------------

/** Top-level string keys in event payloads that carry free text and should
 * be scrubbed. Structural keys (type, nodeId, runId, workflowSha, seq, …)
 * are deliberately NOT listed — they drive deriveRunState replay and must
 * never be altered. */
const FREE_TEXT_KEYS = new Set(["text", "note", "preview", "errorMessage", "detail", "summary"]);

/**
 * Scrub an event payload without touching structural fields.
 *
 * Rules (applied in order, only to matching events):
 *  1. For each key in FREE_TEXT_KEYS present at the top level with a string
 *     value, replace the value with `scrubText(...)`.
 *  2. When `type === "intent.run_enqueued"`, deep-scrub string VALUES in
 *     `payload.routing` via `scrubJsonStrings` — catches cwd, input, inputs
 *     while leaving structural numbers/objects and all keys untouched.
 *  3. Everything else passes through unchanged.
 *
 * Returns a shallow-cloned object when modified; returns the original when
 * there is nothing to scrub (no allocation on the hot path for unaffected
 * events).
 */
export function scrubEventPayload(
  type: string,
  payload: unknown,
  registry: CompiledRegistry,
  opts?: ScrubOptions,
): unknown {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const src = payload as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;

  // Rule 1: scrub free-text top-level string keys.
  for (const key of FREE_TEXT_KEYS) {
    const val = src[key];
    if (typeof val === "string") {
      const scrubbed = scrubText(val, registry, opts);
      if (scrubbed !== val) {
        if (out == null) out = { ...src };
        out[key] = scrubbed;
      }
    }
  }

  // Rule 1b: scrub reason only for intent.cancel_requested (free-text operator message).
  if (type === "intent.cancel_requested") {
    const val = src["reason"];
    if (typeof val === "string") {
      const scrubbed = scrubText(val, registry, opts);
      if (scrubbed !== val) {
        if (out == null) out = { ...src };
        out["reason"] = scrubbed;
      }
    }
  }

  // Rule 2: deep-scrub routing string values for the genesis event.
  if (type === "intent.run_enqueued") {
    const routing = src["routing"];
    if (routing != null && typeof routing === "object" && !Array.isArray(routing)) {
      const scrubbedRouting = scrubJsonStrings(routing, registry, opts);
      if (scrubbedRouting !== routing) {
        if (out == null) out = { ...src };
        out["routing"] = scrubbedRouting;
      }
    }
  }

  return out ?? payload;
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
    // Short-circuit BlobRef objects — never scrub the sha sentinel or bytes field.
    // A future sha-shaped literal needle would otherwise corrupt the routing ref,
    // causing rewriteRoutingRefs to point at an absent tar blob.
    if (isBlobRef(value)) return value;
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k] = scrubJsonStrings(src[k], registry, opts);
    }
    return out as unknown as T;
  }
  return value;
}
