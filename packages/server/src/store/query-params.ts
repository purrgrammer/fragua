// Shared numeric query-param parsing for the store routes. A bare
// `Number(query(...) ?? fallback)` yields `NaN` on non-numeric input, which
// then flows into `Math.min` / arithmetic and produces a `NaN` bound. This
// guards with `Number.isFinite` and coerces bad input back to the default,
// so the read/control surface is deterministic on garbage input. Mirrors the
// `Number.isFinite` guard in `runs-routes.ts:parseLimit`.

export interface NumericQueryOpts {
  /** Value returned when the param is absent or not a finite number. */
  fallback: number;
  /** Lower clamp applied to a finite value. */
  min?: number;
  /** Upper clamp applied to a finite value. */
  max?: number;
}

/** Parse a numeric query param. Returns `fallback` when the raw value is
 *  absent or non-finite; otherwise clamps the finite value to `[min, max]`
 *  when those bounds are supplied. */
export function numericQueryParam(raw: string | undefined, opts: NumericQueryOpts): number {
  if (raw === undefined) return opts.fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return opts.fallback;
  let v = n;
  if (opts.min !== undefined) v = Math.max(v, opts.min);
  if (opts.max !== undefined) v = Math.min(v, opts.max);
  return v;
}
