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
 * `Intl.NumberFormatOptions` for a 0–1 ratio rendered as a percentage with
 * up to one decimal of precision (e.g. `0.829` → `"82.9%"`, `1.0` → `"100%"`).
 * Used by tiles that feed `AnimatedNumber` directly so the percentage
 * animates and baselines with the other NumberFlow-driven tiles in the same
 * row. `minimumFractionDigits: 0` so whole percentages render without a
 * dangling `.0` ("100%" not "100.0%").
 */
export function percentFormatOptions(): Intl.NumberFormatOptions {
  return { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 1 };
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
 * Cache hit rate, expressed as the share of total prompt-token-equivalents
 * that came from a cache read:
 *
 *   cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
 *
 * Including `cacheWriteTokens` in the denominator counts the prompt-token
 * cost of *writing* to the cache, not just the prompt-token cost of fresh
 * input. A run that paid cache-write rates on a 100k-token system prompt
 * once and then read it back twice is ~67% effective cache utilisation,
 * not 100% — the previous formula (`cacheRead / (input + cacheRead)`)
 * could push to 99.99%+ for any run after the first turn since fresh
 * input collapses to single-digit tokens once the cache is warm. That
 * displays as a misleading "100%" tile.
 *
 * Returns `'—'` when:
 *   - any argument is `null` / `undefined` / `NaN` / non-finite, or
 *   - the denominator is zero.
 *
 * Otherwise returns a percentage string with up to one decimal of
 * precision (e.g. `'42%'`, `'42.5%'`, `'100%'`).
 */
export function formatCacheHitRate(
  cacheReadTokens: number | null | undefined,
  inputTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined = 0,
): string {
  if (!isFiniteNumber(cacheReadTokens) || !isFiniteNumber(inputTokens)) return "—";
  if (!isFiniteNumber(cacheWriteTokens)) return "—";
  const denom = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (denom === 0) return "—";
  const rate = cacheReadTokens / denom;
  if (!Number.isFinite(rate)) return "—";
  return new Intl.NumberFormat(defaultLocale(), percentFormatOptions()).format(rate);
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
