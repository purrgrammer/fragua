// Run id generator. A ULID: 48-bit millisecond timestamp + 80 bits of
// randomness, Crockford base-32, lowercased. Lexically sortable by
// creation time and collision-safe across machines — the full 80 random
// bits are encoded without loss (no modulo-32 truncation), so two ids
// minted in the same millisecond on different machines won't collide
// when stores are merged.
//
// Lives in @fragua/store (not @fragua/server) so EVERY fact-writer mints
// the same id shape: the server route AND the daemon's schedule dispatcher
// both depend on the store. A run id is portable identity (db-import), so
// it must not vary by which path enqueued the run.

import { randomBytes } from "node:crypto";

const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's base-32

export function newRunId(): string {
  const ts = encodeTime(Date.now());
  const rand = encodeRandom();
  return `${ts}${rand}`.toLowerCase();
}

/** Encode a 48-bit millisecond timestamp as 10 base-32 chars (the ULID
 * time component). */
function encodeTime(ms: number): string {
  let v = BigInt(ms);
  const out: string[] = [];
  for (let i = 0; i < 10; i++) {
    out.unshift(ALPH[Number(v % 32n)]!);
    v /= 32n;
  }
  return out.join("");
}

/** Encode 80 random bits as 16 base-32 chars (the ULID entropy
 * component). The bitstream is consumed 5 bits at a time so every
 * random bit reaches the output — unlike a per-byte `% 32`, which
 * would discard 3 bits of each byte. */
function encodeRandom(): string {
  const bytes = randomBytes(10); // 80 bits
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  const out: string[] = [];
  for (let i = 0; i < 16; i++) {
    out.unshift(ALPH[Number(acc & 31n)]!);
    acc >>= 5n;
  }
  return out.join("");
}
