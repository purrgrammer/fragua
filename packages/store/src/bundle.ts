// Bundle format — the portable `.fragua` artifact (docs/proposals/bundles.md).
//
// A bundle is its own ENTITY: one or more runs (as raw event logs), the
// workflows they reference, and the content-addressed blobs they produced.
// There is NO projection in a bundle — `run_state` is re-derived on import by
// replaying the event log. The tar is MANIFEST-FIRST (`manifest.json`, a pure
// index a reader can pull without unpacking), then per-run logs, workflows, and
// blobs. No `provider_credentials`/`provider_config` ever — secret-free by
// construction.
//
// Layout:
//   manifest.json                     — index + version stamps only
//   runs/<id>/events.jsonl            — the run's event log (genesis + facts)
//   runs/<id>/messages.jsonl          — the transcript (one message per line)
//   workflows/<sha>/source.yaml       — the workflow as authored
//   workflows/<sha>/ir.json           — its compiled IR
//   blobs/<sha256>                    — content-addressed bytes (artifacts)

/** Bump when the bundle layout changes. Experimental — bumps freely, no
 *  migration path while the format is unstable (bundles.md). */
export const BUNDLE_VERSION = 1;

export interface BundleManifest {
  bundleVersion: number;
  /** Version stamps for the import-time compatibility check (bundles.md §7). */
  fraguaVersion: string;
  contractVersion: number;
  schemaVersion: number;
  irVersion: number;
  /** Index of the runs carried; counts let `show` summarize cheaply. */
  runs: { runId: string; workflowSha: string; events: number; messages: number }[];
  /** Content-addressed workflows the runs reference; bytes live in `workflows/<sha>/`. */
  workflows: { sha: string; name: string; irVersion: number }[];
  /** Manifest of every blob carried in `blobs/`; bytes must hash to `sha256`. */
  blobs: { sha256: string; size: number }[];
}

/** Type-narrow a parsed manifest before any heavy work: confirm the required
 *  top-level fields are present and well-shaped, so a tampered/malformed bundle
 *  fails with a clear error instead of a deep `TypeError` partway through the
 *  blob-integrity loop or the import txn (bundles.md). */
export function assertBundleManifest(m: unknown): asserts m is BundleManifest {
  if (m == null || typeof m !== "object") throw new Error("bundle manifest is not an object");
  const o = m as Record<string, unknown>;
  if (typeof o["bundleVersion"] !== "number") throw new Error("bundle manifest: bundleVersion missing or not a number");
  for (const k of ["runs", "workflows", "blobs"] as const) {
    if (!Array.isArray(o[k])) throw new Error(`bundle manifest: ${k} missing or not an array`);
  }
}

// ─────────────── Layout paths ───────────────

export const MANIFEST_ENTRY = "manifest.json";
export const runEventsPath = (runId: string): string => `runs/${runId}/events.jsonl`;
export const runMessagesPath = (runId: string): string => `runs/${runId}/messages.jsonl`;
export const runArtifactsPath = (runId: string): string => `runs/${runId}/artifacts.jsonl`;
export const workflowSourcePath = (sha: string): string => `workflows/${sha}/source.yaml`;
export const workflowIrPath = (sha: string): string => `workflows/${sha}/ir.json`;
export const blobPath = (sha256: string): string => `blobs/${sha256}`;

export interface TarEntry {
  /** POSIX path inside the archive (< 100 bytes; we only use short names). */
  name: string;
  data: Uint8Array;
}

/**
 * Minimal, DETERMINISTIC ustar writer: fixed mode/uid/gid/mtime, no per-file
 * metadata, entries emitted in caller order — so the same inputs always yield
 * byte-identical output (bundles.md §7 re-export determinism). No dependency,
 * no compression (blobs are already content-packed; the consumer/transport
 * compresses if it wants).
 */
export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];

  for (const { name, data } of entries) {
    const h = new Uint8Array(512);
    const put = (s: string, off: number, len: number): void => {
      const b = enc.encode(s);
      if (b.length > len) throw new Error(`tar: field overflow at ${off} (${name})`);
      h.set(b, off);
    };
    put(name, 0, 100); // name
    put("0000644\0", 100, 8); // mode
    put("0000000\0", 108, 8); // uid
    put("0000000\0", 116, 8); // gid
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12); // size (octal)
    put("00000000000\0", 136, 12); // mtime = 0 (deterministic)
    for (let i = 148; i < 156; i++) h[i] = 0x20; // checksum field = spaces, pre-sum
    h[156] = 0x30; // typeflag '0' (regular file)
    put("ustar\0", 257, 6); // magic
    put("00", 263, 2); // version
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i] ?? 0;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8); // checksum: 6 octal + NUL + space

    blocks.push(h, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024)); // two zero blocks terminate the archive

  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

/**
 * Inverse of {@link writeTar}: walk the 512-byte ustar blocks and return each
 * entry as a name + a zero-copy `subarray` view of its data. Reads only the
 * two fields `writeTar` emits — name (0..100) and the octal size (124..136) —
 * and stops at the first zero block (the archive terminator). Lenient by
 * design: it parses our own writer's output, not arbitrary tar.
 */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512);
    if (h[0] === 0) break; // zero block → end of archive
    let n = 0;
    while (n < 100 && h[n] !== 0) n++;
    if (n === 100) throw new Error("readTar: entry name not null-terminated within 100 bytes (malformed header)");
    const name = dec.decode(h.subarray(0, n));
    const size = Number.parseInt(dec.decode(h.subarray(124, 136)).replace(/[\0 ]/g, ""), 8);
    if (!Number.isInteger(size) || size < 0) throw new Error("readTar: malformed size header");
    off += 512;
    out.push({ name, data: bytes.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512; // step past the data's padded block span
  }
  return out;
}

/**
 * Deterministic JSON: object keys sorted recursively, so two semantically-equal
 * values serialize to byte-identical strings regardless of key insertion order
 * (bundles.md §7 re-export determinism). Arrays keep their order — the exporter
 * orders its rows canonically (events by seq, messages by ordinal, blobs/
 * workflows by sha) so the whole bundle is store-independent.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k]);
    return out;
  }
  return v;
}

const TEXT = { enc: new TextEncoder(), dec: new TextDecoder() };

/** Encode rows as newline-delimited canonical JSON (a `.jsonl` tar entry). */
export function encodeJsonl(rows: readonly unknown[]): Uint8Array {
  return TEXT.enc.encode(rows.map((r) => canonicalJson(r)).join("\n") + (rows.length > 0 ? "\n" : ""));
}

/** Parse a `.jsonl` tar entry into rows; tolerates a trailing newline. */
export function decodeJsonl(data: Uint8Array): unknown[] {
  const text = TEXT.dec.decode(data).trim();
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}
