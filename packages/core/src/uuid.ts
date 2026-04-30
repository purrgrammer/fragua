// RFC 9562 §5.7 UUIDv7 — 48-bit Unix-millisecond timestamp prefix +
// 74 random bits. Lexically sortable by creation time, so
// `ORDER BY id` on a project_id column gives newest-first for free.

/** Mint a fresh UUIDv7 string. Calls `crypto.getRandomValues` once. */
export function uuidv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp. JS bit-shifts are 32-bit so the upper
  // bits go through Math.floor instead of `>>>`.
  bytes[0] = Math.floor(ts / 0x10000000000) & 0xff;
  bytes[1] = Math.floor(ts / 0x100000000) & 0xff;
  bytes[2] = Math.floor(ts / 0x1000000) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version = 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True iff `s` is a syntactically-valid lower-case UUIDv7. */
export function isUuidv7(s: string): boolean {
  return UUIDV7_RE.test(s);
}
