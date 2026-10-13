// Shared numeric query-param parsing for the store routes. A bare
// `Number(query(...) ?? fallback)` yields `NaN` on non-numeric input, which
// then flows into `Math.min` / arithmetic and produces a `NaN` bound. This
// guards with `Number.isFinite` and coerces bad input back to the default,
// so the read/control surface is deterministic on garbage input. Mirrors the
// `Number.isFinite` guard in `runs-routes.ts:parseLimit`. A value below the
// floor (default 0) is bad input too: SQLite treats a negative `LIMIT` as
// unbounded, and a negative time window puts the cutoff in the future.

export interface NumericQueryOpts {
  /** Value returned when the param is absent, not a finite number, or below `min`. */
  fallback: number;
  /** Floor, default `0`. A finite value below it returns `fallback` (it is not clamped up). */
  min?: number;
  /** Upper clamp applied to a finite value. */
  max?: number;
}

/** Parse a numeric query param. Returns `fallback` when the raw value is
 *  absent, non-finite, or below the floor (`min`, default `0`); otherwise
 *  clamps the value to `max` when supplied. */
export function numericQueryParam(raw: string | undefined, opts: NumericQueryOpts): number {
  if (raw === undefined) return opts.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < (opts.min ?? 0)) return opts.fallback;
  return opts.max !== undefined ? Math.min(n, opts.max) : n;
}
