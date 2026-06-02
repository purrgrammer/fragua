// Registry assembly and JSON-string deep-scrub for exportRunBundle.
// Pure, deterministic — no I/O, no clock, no random.

import { isBlobRef } from "../routing-blobs.ts";
import type { ProviderCredentialRow } from "../types.ts";
import { BASE_PATTERNS } from "./patterns.ts";
import { type CompiledPattern, type CompiledRegistry, compileRegistry, MIN_LITERAL_LEN } from "./registry.ts";
import { type ScrubOptions, scrubText } from "./scrub.ts";

// Memoised as pattern SOURCES (source string + flags string) so compileRegistry
// can allocate FRESH RegExp instances per call — each registry then owns its own
// RegExp objects with independent lastIndex state. (~8 entries, cheap.)
const BASE_PATTERN_SOURCES: ReadonlyArray<{ source: string; reSource: string; flags: string }> = BASE_PATTERNS.map(
  (p) => ({
    source: p.source,
    reSource: p.re.source,
    flags: p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`,
  }),
);

/** Returns a fresh CompiledPattern[] from the memoised base-pattern sources.
 * Each call allocates new RegExp instances so registries have independent
 * lastIndex state — safe for concurrent/async exports. */
function freshBasePatterns(): CompiledPattern[] {
  return BASE_PATTERN_SOURCES.map((p) => ({ source: p.source, re: new RegExp(p.reSource, p.flags) }));
}

// ---------------------------------------------------------------------------
// Literal extraction from credential payloads
// ---------------------------------------------------------------------------

/**
 * Structural payload keys that are never secret values. Excluded from the
 * generic fallback in `extractCredentialLiterals` to prevent redacting
 * short metadata values like provider="anthropic" that would clear the
 * MIN_LITERAL_LEN floor and corrupt downstream text.
 */
const CREDENTIAL_STRUCTURAL_KEYS = new Set(["type", "kind", "provider", "name", "id", "createdAt", "updatedAt"]);

/**
 * Extract the actual secret string(s) from a parsed provider-credential
 * payload. Returns only strings; non-string values are silently skipped.
 * The value-length floor in `compileRegistry` covers short or empty values.
 *
 * Extraction strategy (applied in order, results deduplicated by insertion):
 *   1. Explicit named picks for known shapes (api_key: key; oauth: accessToken,
 *      refreshToken) — these run first so known fields are always covered.
 *   2. Generic fallback: every string-valued field NOT in
 *      CREDENTIAL_STRUCTURAL_KEYS — catches future credential shapes
 *      (idToken, clientSecret, apiSecret, wrapped JWTs) that would otherwise
 *      silently leak.
 */
export function extractCredentialLiterals(row: ProviderCredentialRow): string[] {
  const p = row.payload;
  if (p == null || typeof p !== "object" || Array.isArray(p)) return [];
  const obj = p as Record<string, unknown>;

  const seen = new Set<string>();
  const results: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
      seen.add(v);
      results.push(v);
    }
  };

  // Step 1: explicit named picks for known credential shapes.
  if (row.kind === "api_key") {
    push(obj["key"]);
  } else if (row.kind === "oauth") {
    push(obj["accessToken"]);
    push(obj["refreshToken"]);
  }

  // Step 2: generic fallback — every string field not in the structural denylist.
  for (const [k, v] of Object.entries(obj)) {
    if (!CREDENTIAL_STRUCTURAL_KEYS.has(k)) {
      push(v);
    }
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
 * Returns `{ registry, literalValues }` where `literalValues` is the set of
 * verbatim secret strings (filtered by the same length/whitespace floor as
 * `compileRegistry`) exposed for callers that need to scan UN-SCRUBBED
 * surfaces (e.g. binary artifact blobs) for a residual leak.
 *
 * Build once per export, then pass `registry` to `scrubJsonStrings` for each
 * message.
 */
export function buildExportRegistry(opts: {
  providerCredentials: ProviderCredentialRow[];
  cwd: string | null;
  /** Extra literal needles merged in before compilation (e.g. CI env secrets). */
  extraLiterals?: Array<{ value: string; source: string }>;
}): { registry: CompiledRegistry; literalValues: string[] } {
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

  // Derive the verbatim literal values using the same floor as compileRegistry
  // (MIN_LITERAL_LEN + no-whitespace) so callers scanning raw bytes don't need
  // to re-implement the filter.
  const literalValues = literals.map((l) => l.value).filter((v) => v.length >= MIN_LITERAL_LEN && !/\s/.test(v));

  const registry = compileRegistry({ literals, patterns: freshBasePatterns() });
  return { registry, literalValues };
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

  // Rule 1c: scrub title for run.title_generated (LLM-generated free text).
  if (type === "run.title_generated") {
    const val = src["title"];
    if (typeof val === "string") {
      const scrubbed = scrubText(val, registry, opts);
      if (scrubbed !== val) {
        if (out == null) out = { ...src };
        out["title"] = scrubbed;
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
