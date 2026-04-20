// Locale-aware number + currency formatters. Sibling of `time.ts`; lives
// here so components never hand-roll `Intl.NumberFormat` calls inline
// (the same discipline we enforce for dates).
//
// Scope today: run-metrics rendering — USD costs and token counts
// in the list + detail header. We keep the API tiny and add helpers as
// new call sites appear rather than pre-building a library.

import { defaultLocale } from "./locale.ts";
import { type TimeInput, toDate } from "./time.ts";

export interface NumberFormatOptions {
  locale?: string;
  /** Fallback string when the input is null / NaN / non-finite. */
  fallback?: string;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * `Intl.NumberFormatOptions` for USD cost at the given magnitude. Extracted
 * so animated counters (`AnimatedNumber`) can feed the same option set into
 * `NumberFlow` without double-formatting. See `formatUsd` for the rationale
 * behind the fraction-digit ladder.
 */
export function usdFormatOptions(value: number): Intl.NumberFormatOptions {
  const fractionDigits = value === 0 ? 2 : value < 0.01 ? 4 : value < 1 ? 3 : 2;
  return {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };
}

/** `Intl.NumberFormatOptions` mirroring `formatTokensCompact` for the given magnitude. */
export function tokensCompactFormatOptions(value: number): Intl.NumberFormatOptions {
  if (value < 1000) return { maximumFractionDigits: 0 };
  return { notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 };
}

/** `Intl.NumberFormatOptions` mirroring `formatTokensLong`. */
export function tokensLongFormatOptions(): Intl.NumberFormatOptions {
  return { maximumFractionDigits: 0 };
}

/**
 * USD cost. Fixed to USD currency — the whole product assumes LLM spend
 * is priced in USD, so we don't thread a currency option through every
 * call site. Fraction digits are picked to keep sub-cent costs legible
 * without making dollar-scale costs noisy:
 *   - < $0.01  → 4 fraction digits ("$0.0007")
 *   - < $1     → 3 fraction digits ("$0.123")
 *   - ≥ $1     → 2 fraction digits ("$1.23", "$12.34")
 */
export function formatUsd(value: number | null | undefined, opts: NumberFormatOptions = {}): string {
  if (!isFiniteNumber(value) || value < 0) return opts.fallback ?? "—";
  const locale = opts.locale ?? defaultLocale();
  return new Intl.NumberFormat(locale, usdFormatOptions(value)).format(value);
}

/**
 * Token counts for tight UI surfaces (table cells, badges). Renders with
 * the "compact" Intl preset so 4,230 becomes "4.2K" (or the locale's
 * equivalent). Falls back to the long form under 1000.
 */
export function formatTokensCompact(value: number | null | undefined, opts: NumberFormatOptions = {}): string {
  if (!isFiniteNumber(value) || value < 0) return opts.fallback ?? "—";
  const locale = opts.locale ?? defaultLocale();
  return new Intl.NumberFormat(locale, tokensCompactFormatOptions(value)).format(value);
}

/** Long form token count, for tooltips where precision matters. */
export function formatTokensLong(value: number | null | undefined, opts: NumberFormatOptions = {}): string {
  if (!isFiniteNumber(value) || value < 0) return opts.fallback ?? "—";
  const locale = opts.locale ?? defaultLocale();
  return new Intl.NumberFormat(locale, tokensLongFormatOptions()).format(value);
}

/**
 * User-facing label for a run status. Mapping lives here (not in
 * components) so the raw wire value (`"fail"`) stays intact on the data
 * layer while the copy reads naturally. `data-testid` / `data-status`
 * attributes continue to use the raw value; only visible text goes
 * through this helper.
 */
export function statusLabel(status: string): string {
  switch (status) {
    case "fail":
      return "failure";
    default:
      return status;
  }
}

// Re-export the TimeInput type via a narrow helper so callers with
// mixed "when was this" concerns only need one import site. Kept here to
// avoid a circular concern with time.ts (which is the canonical home).
export type { TimeInput };
export { toDate };
