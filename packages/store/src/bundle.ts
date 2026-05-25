// Run bundle format — the portable `.fragua` artifact (docs/proposals/db-import.md).
//
// A bundle is a tar, MANIFEST-FIRST: `manifest.json` (so a reader can pull it
// with `tar xO -f x.fragua manifest.json` without unpacking blobs) then
// `blobs/<sha256>` for each referenced blob. The manifest carries only the
// PORTABLE subset of a run — never `provider_credentials`/`provider_config` or
// any machine-local table — so the artifact is secret-free by construction (no
// scrub step to get wrong). The exporter assembles this; import (merge) reads
// the same shape.

import type { ArtifactListRow, Message, RunState, StoredEvent } from "./types.ts";

/** Bump when the manifest shape changes incompatibly. */
export const BUNDLE_VERSION = 1;

export interface BundleManifest {
  bundleVersion: number;
  /** Version stamps for the import-time compatibility check (db-import §5). */
  fraguaVersion: string;
  contractVersion: number;
  schemaVersion: number;
  irVersion: number;
  /** The full run_state projection. No secrets; import rebinds `cwd` and
   * resets local operator state (`inboxStatus`, `acceptedSha`) per §4. */
  run: RunState;
  /** Content-addressed workflow (source + canonical IR); dedup by `sha`. */
  workflow: { sha: string; name: string; source: string; ir: string; irVersion: number };
  events: StoredEvent[];
  messages: Message[];
  artifacts: ArtifactListRow[];
  /** Manifest of every blob carried in `blobs/`; bytes must hash to `sha256`. */
  blobs: { sha256: string; size: number }[];
}

export interface TarEntry {
  /** POSIX path inside the archive (< 100 bytes; we only use short names). */
  name: string;
  data: Uint8Array;
}

/**
 * Minimal, DETERMINISTIC ustar writer: fixed mode/uid/gid/mtime, no per-file
 * metadata, entries emitted in caller order — so the same inputs always yield
 * byte-identical output (db-import §6 re-export determinism). No dependency,
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
