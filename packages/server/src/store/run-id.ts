// Run id generator. ULID-like monotonic ordering via base-32 timestamp +
// random suffix. Not cryptographically unique, just unique-enough for a
// single-machine deployment and lexically sortable by creation time.

import { randomBytes } from "node:crypto";

const ALPH = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford's base-32

export function newRunId(): string {
  const ms = BigInt(Date.now());
  const tsBits = encodeBase32(ms, 10);
  const rand = randomBytes(8);
  let suffix = "";
  for (let i = 0; i < rand.length; i++) {
    suffix += ALPH[rand[i]! % 32];
  }
  return `${tsBits}${suffix}`.toLowerCase();
}

function encodeBase32(value: bigint, len: number): string {
  let v = value;
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    out.unshift(ALPH[Number(v % 32n)]!);
    v /= 32n;
  }
  return out.join("");
}
