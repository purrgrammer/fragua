// Duration string parser — shared between config (.swarm/config.yaml
// `timeouts:`) and DOT node attrs (`timeout="…"`). Output is milliseconds
// so callers can plug straight into setTimeout / AbortSignal.timeout.
//
// Grammar: /^(\d+)(ms|s|m|h)?$/ — digits followed by an optional unit.
// Missing unit means milliseconds (so bare ints round-trip). Negative
// values, non-finite numbers, and anything that doesn't match the
// grammar throw with a caller-friendly message. Zero is accepted (the
// codergen-unbounded sentinel — see docs/proposals/codergen-unbounded-time.md);
// callers that need to reject it bake their own positivity check on the
// returned value.

export class InvalidDurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDurationError";
  }
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60 * 1_000,
  h: 60 * 60 * 1_000,
};

/** Parse a duration string or number into milliseconds.
 *
 *   parseDurationMs("500ms") // 500
 *   parseDurationMs("30s")   // 30_000
 *   parseDurationMs("5m")    // 300_000
 *   parseDurationMs("2h")    // 7_200_000
 *   parseDurationMs(1_000)   // 1_000
 *   parseDurationMs(0)       // 0 — unbounded sentinel
 *   parseDurationMs("0s")    // 0 — unbounded sentinel
 *
 * Throws `InvalidDurationError` on empty string, negative numbers,
 * NaN/Infinity, unknown units, or malformed grammar. */
export function parseDurationMs(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new InvalidDurationError(`duration must be finite, got ${String(input)}`);
    }
    if (!Number.isInteger(input)) {
      throw new InvalidDurationError(`duration must be an integer number of ms, got ${input}`);
    }
    if (input < 0) {
      throw new InvalidDurationError(`duration must be >= 0, got ${input}`);
    }
    return input;
  }

  if (typeof input !== "string") {
    throw new InvalidDurationError(`duration must be a string or number, got ${typeof input}`);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new InvalidDurationError(`duration is empty`);
  }

  const match = /^(\d+)(ms|s|m|h)?$/.exec(trimmed);
  if (match == null) {
    throw new InvalidDurationError(
      `invalid duration "${input}" — expected digits optionally followed by ms/s/m/h (e.g. "500ms", "30s", "5m", "2h")`,
    );
  }

  const digits = match[1]!;
  const unit = match[2] ?? "ms";
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n)) {
    throw new InvalidDurationError(`invalid duration "${input}" — number parse failed`);
  }
  const multiplier = UNITS[unit];
  if (multiplier == null) {
    // Unreachable given the regex, but narrow the type for callers.
    throw new InvalidDurationError(`invalid duration "${input}" — unknown unit "${unit}"`);
  }
  const ms = n * multiplier;
  if (!Number.isSafeInteger(ms)) {
    throw new InvalidDurationError(`duration "${input}" overflows safe integer`);
  }
  return ms;
}
