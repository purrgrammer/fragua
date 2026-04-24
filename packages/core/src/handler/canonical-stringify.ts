// Canonical JSON stringification for idempotency key inputs.
//
// `JSON.stringify` preserves insertion order, so two handlers that build
// semantically-identical args via different code paths produce different
// strings → different argsHash → different idempotencyKey → the provider
// deduplication envelope breaks and a replay double-executes. This
// function produces a byte-identical string for any two structurally
// equal values by sorting object keys and rejecting non-serialisable
// inputs loudly.

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
  if (t === "string") return JSON.stringify(v);
  if (t === "undefined") throw new CanonicalStringifyError("undefined is not serialisable");
  if (t === "bigint") throw new CanonicalStringifyError("bigint is not serialisable");
  if (t === "symbol") throw new CanonicalStringifyError("symbol is not serialisable");
  if (t === "function") throw new CanonicalStringifyError("function is not serialisable");
  if (t !== "object") throw new CanonicalStringifyError(`unsupported type ${t}`);
  const obj = v as object;
  if (seen.has(obj)) throw new CanonicalStringifyError("cyclic value");
  seen.add(obj);
  try {
    if (Array.isArray(v)) {
      const parts = new Array<string>(v.length);
      for (let i = 0; i < v.length; i++) parts[i] = stringify(v[i], seen);
      return `[${parts.join(",")}]`;
    }
    const entries = v as Record<string, unknown>;
    const keys = Object.keys(entries).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stringify(entries[k], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
