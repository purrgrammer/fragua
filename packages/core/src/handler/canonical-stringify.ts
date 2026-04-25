// Canonical JSON stringification for idempotency key inputs.
//
// `JSON.stringify` preserves insertion order, so two handlers that build
// semantically-identical args via different code paths produce different
// strings → different argsHash → different idempotencyKey → the provider
// deduplication envelope breaks and a replay double-executes. This
// function produces a byte-identical string for any two structurally
// equal values by:
//
//   1. Sorting object keys (post-normalisation; see below)
//   2. Normalising every string — keys AND values — to Unicode NFC. The
//      same word typed once on macOS (NFD by default) and once on Linux
//      (NFC by default) would otherwise hash differently. NFC matches the
//      Unicode default for textual content and what most JSON producers
//      emit, so callers don't have to think about it.
//   3. Rejecting non-serialisable / ambiguous inputs loudly: BigInt,
//      Symbol, undefined, function, cyclic references, non-finite numbers,
//      and the silently-broken built-ins (`Date`, `Buffer`, `TypedArray`)
//      that fall through `typeof === "object"` and would serialise as
//      `{}` without explicit handling.
//   4. Detecting duplicate keys after NFC normalisation. JS allows two
//      distinct property keys whose only difference is normalisation (the
//      raw character bytes differ); after we normalise both we'd emit a
//      string with two entries for the same key, which is ambiguous.
//      Throw rather than silently last-write-wins.
//
// The output is fed straight into a sha256 — it does not need to be valid
// JSON, only a deterministic byte sequence for any two structurally-equal
// inputs.

export class CanonicalStringifyError extends Error {
  constructor(message: string) {
    super(`canonicalStringify: ${message}`);
    this.name = "CanonicalStringifyError";
  }
}

export function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return stringify(value, seen);
}

function stringify(v: unknown, seen: WeakSet<object>): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "boolean") return (v as boolean) ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(v as number)) {
      throw new CanonicalStringifyError(`non-finite number ${String(v)}`);
    }
    return JSON.stringify(v);
  }
  if (t === "string") return JSON.stringify((v as string).normalize("NFC"));
  if (t === "undefined") throw new CanonicalStringifyError("undefined is not serialisable");
  if (t === "bigint") throw new CanonicalStringifyError("bigint is not serialisable");
  if (t === "symbol") throw new CanonicalStringifyError("symbol is not serialisable");
  if (t === "function") throw new CanonicalStringifyError("function is not serialisable");
  if (t !== "object") throw new CanonicalStringifyError(`unsupported type ${t}`);
  const obj = v as object;
  // Reject built-ins that fall through the generic "object" branch and
  // would otherwise serialise as `{}` (Date), the array form of their
  // bytes (TypedArray), or a `{type, data}` shape (Node Buffer). Forcing
  // the caller to convert to a plain JSON value makes the canonical form
  // unambiguous.
  if (obj instanceof Date) {
    throw new CanonicalStringifyError("Date is not serialisable — convert to ISO string or epoch ms");
  }
  if (ArrayBuffer.isView(obj)) {
    throw new CanonicalStringifyError(
      "typed arrays / DataView / Buffer are not serialisable — convert to a plain array or hex string",
    );
  }
  if (obj instanceof ArrayBuffer) {
    throw new CanonicalStringifyError("ArrayBuffer is not serialisable — convert to a plain array or hex string");
  }
  if (seen.has(obj)) throw new CanonicalStringifyError("cyclic value");
  seen.add(obj);
  try {
    if (Array.isArray(v)) {
      const parts = new Array<string>(v.length);
      for (let i = 0; i < v.length; i++) parts[i] = stringify(v[i], seen);
      return `[${parts.join(",")}]`;
    }
    const entries = v as Record<string, unknown>;
    // Normalise keys to NFC, detect collisions, then sort lexicographically.
    const normalised = new Map<string, unknown>();
    for (const k of Object.keys(entries)) {
      const nk = k.normalize("NFC");
      if (normalised.has(nk)) {
        throw new CanonicalStringifyError(
          `duplicate key after NFC normalisation: ${JSON.stringify(nk)} appears under two distinct raw forms`,
        );
      }
      normalised.set(nk, entries[k]);
    }
    const keys = [...normalised.keys()].sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stringify(normalised.get(k), seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
