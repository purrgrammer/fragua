// Helpers for spilling large `routing.inputs` string values to the blob CAS
// and resolving them back on read.
//
// Spill policy (deterministic):
//   1. Any single `routing.inputs` string value longer than PER_VALUE_SPILL_BYTES
//      is always spilled, regardless of total routing size.
//   2. When the total JSON-serialised routing exceeds ROUTING_SPILL_MARGIN_BYTES,
//      the largest values (by byte length, then key as tiebreaker) are spilled
//      until the total drops below the margin.
//   Only string values under `routing.inputs` are eligible. Structural entries
//   (numeric values, objects, arrays, top-level non-`inputs` keys) are never
//   spilled.
//
// On read, `materializeRouting` replaces every `$fragua_blob` reference with
// the decoded utf-8 blob bytes. The helper is pure — it accepts a `getBlob`
// callback so it can be unit-tested without a real BlobFS.

import { sha256Hex } from "./sha256.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (exported for tests + callers that need the margins)
// ─────────────────────────────────────────────────────────────────────────────

/** Any single `routing.inputs` string value longer than this is always spilled. */
export const PER_VALUE_SPILL_BYTES = 1024;

/** When total `JSON.stringify(routing)` exceeds this, spill largest values first. */
export const ROUTING_SPILL_MARGIN_BYTES = 3072;

// ─────────────────────────────────────────────────────────────────────────────
// Sentinel type
// ─────────────────────────────────────────────────────────────────────────────

export const BLOB_REF_SENTINEL = "$fragua_blob" as const;

/** A reference to a CAS blob that replaces a spilled `routing.inputs` string. */
export interface BlobRef {
  readonly $fragua_blob: string;
  readonly bytes: number;
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Return true when `v` is a well-formed `BlobRef` (not a user string). */
export function isBlobRef(v: unknown): v is BlobRef {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o[BLOB_REF_SENTINEL] !== "string") return false;
  if (!SHA256_HEX_RE.test(o[BLOB_REF_SENTINEL] as string)) return false;
  if (typeof o["bytes"] !== "number") return false;
  if (!Number.isInteger(o["bytes"]) || (o["bytes"] as number) < 0) return false;
  return true;
}

/** Construct a canonical `BlobRef`. */
export function makeBlobRef(sha: string, bytes: number): BlobRef {
  return { [BLOB_REF_SENTINEL]: sha, bytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spill
// ─────────────────────────────────────────────────────────────────────────────

export interface SpillResult {
  /** A new routing object (shallowly cloned with `inputs` replaced). */
  routing: Record<string, unknown>;
  /** Ordered list of blobs that were written, for the caller to insert rows. */
  spilled: Array<{ key: string; sha: string; bytes: number }>;
}

/**
 * Spill oversized `routing.inputs` string values to the blob CAS.
 *
 * Determinism: candidates are sorted by byte-length desc, then key asc, so
 * the same input always produces the same spill order and the same sha set.
 *
 * @param routing       The initial routing object (never mutated).
 * @param putBlob       Called once per unique blob; must be idempotent.
 * @returns             A new routing (or the original when nothing spilled)
 *                      and the list of blobs written.
 */
export function spillRoutingInputs(
  routing: Record<string, unknown>,
  putBlob: (sha: string, bytes: Uint8Array) => void,
): SpillResult {
  const enc = new TextEncoder();
  const rawInputs = routing["inputs"];
  if (rawInputs === null || typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
    return { routing, spilled: [] };
  }

  const inputs = rawInputs as Record<string, unknown>;

  // Identify eligible string entries
  type Candidate = { key: string; value: string; encoded: Uint8Array };
  const candidates: Candidate[] = [];
  for (const [key, val] of Object.entries(inputs)) {
    if (typeof val === "string") {
      candidates.push({ key, value: val, encoded: enc.encode(val) });
    }
  }
  if (candidates.length === 0) return { routing, spilled: [] };

  // Sort: largest bytes first, then key asc for tiebreaks (determinism)
  candidates.sort((a, b) => b.encoded.length - a.encoded.length || a.key.localeCompare(b.key));

  // Build a working copy of inputs (shallow clone); we mutate refs below.
  const newInputs: Record<string, unknown> = { ...inputs };
  const spilled: SpillResult["spilled"] = [];

  // Track serialised routing size incrementally: start with the full routing
  // JSON length, then on each spill subtract the spilled value's JSON bytes
  // and add the blob-ref JSON bytes. This avoids re-serialising the whole
  // routing object on every iteration (O(n) total vs O(n²) before).
  // The blob-ref shape is { "$fragua_blob": "<64-char sha>", "bytes": <n> },
  // whose JSON length is constant at PER_VALUE_SPILL_BYTES or less in practice
  // but we compute it exactly once here to stay precise.
  const BLOB_REF_JSON_LEN = JSON.stringify(makeBlobRef("0".repeat(64), 0)).length;
  let currentJsonLen = JSON.stringify({ ...routing, inputs: newInputs }).length;

  for (const { key, value, encoded } of candidates) {
    const alreadySmall = encoded.length <= PER_VALUE_SPILL_BYTES;
    const underMargin = currentJsonLen < ROUTING_SPILL_MARGIN_BYTES;

    if (alreadySmall && underMargin) break; // remaining candidates are also small and we're under margin

    const sha = sha256Hex(encoded);
    putBlob(sha, encoded);
    newInputs[key] = makeBlobRef(sha, encoded.length);
    spilled.push({ key, sha, bytes: encoded.length });
    // Adjust size: remove the old JSON-encoded value, add the blob-ref JSON.
    // JSON.stringify(value) is the exact contribution of this string to the JSON.
    currentJsonLen -= JSON.stringify(value).length;
    currentJsonLen += BLOB_REF_JSON_LEN;
  }

  if (spilled.length === 0) return { routing, spilled: [] };

  return {
    routing: { ...routing, inputs: newInputs },
    spilled,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve (materialise)
// ─────────────────────────────────────────────────────────────────────────────

const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * Deep-walk `routing` and replace every `BlobRef` with the utf-8 decoded
 * string from `getBlob`. Pure — no store handle required.
 *
 * @param getBlob  Returns the raw bytes for a given sha, or throws if missing.
 */
export function materializeRouting(
  routing: Record<string, unknown>,
  getBlob: (sha: string) => Uint8Array,
): Record<string, unknown> {
  // Fast-path: avoid deep-cloning on every executor turn when there are no refs.
  if (collectRoutingBlobShas(routing).length === 0) return routing;
  return deepResolve(routing, getBlob) as Record<string, unknown>;
}

function deepResolve(v: unknown, getBlob: (sha: string) => Uint8Array): unknown {
  if (isBlobRef(v)) {
    const sha = v[BLOB_REF_SENTINEL];
    const bytes = getBlob(sha);
    return dec.decode(bytes);
  }
  if (Array.isArray(v)) {
    return v.map((item) => deepResolve(item, getBlob));
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepResolve(val, getBlob);
    }
    return out;
  }
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// GC root collection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk `routing` and return every `$fragua_blob` sha found anywhere in the
 * object graph. Used by `gcBlobs` to build the protected-shas set.
 */
export function collectRoutingBlobShas(routing: unknown): string[] {
  const shas: string[] = [];
  collectInto(routing, shas);
  return shas;
}

function collectInto(v: unknown, out: string[]): void {
  if (isBlobRef(v)) {
    out.push(v[BLOB_REF_SENTINEL]);
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) collectInto(item, out);
    return;
  }
  if (v !== null && typeof v === "object") {
    for (const val of Object.values(v as Record<string, unknown>)) collectInto(val, out);
  }
}
