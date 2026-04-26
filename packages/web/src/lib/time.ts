// Locale-aware time formatting helpers. No new deps: native
// `Intl.DateTimeFormat` + `Intl.RelativeTimeFormat` cover every case we
// need (short date+time in table cells; "3 min ago" for recency hints).
//
// Contract:
//   - All helpers accept either an ISO-8601 string, epoch ms, or Date. A
//     malformed / empty input returns `fallback` (defaults to "—") rather
//     than throwing — table cells should never crash a whole route.
//   - `now` is injectable in every helper so tests can freeze time. Prod
//     callers omit it and we use `Date.now()`.
//   - `locale` defaults to `navigator.language` (falling back to "en-US")
//     but can be overridden per-call.
//
// Why not date-fns / dayjs: the bundle weight is hard to justify for a
// single-user dev tool that only needs relative formatting + a couple of
// Intl presets. Intl is ~zero-cost since browsers already ship it.

export type TimeInput = string | number | Date | null | undefined;

/** Resolve a default locale once per module load. */
function defaultLocale(): string {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    return navigator.language;
  }
  return "en-US";
}

/** Coerce any `TimeInput` to a `Date`. Returns `null` if invalid. */
export function toDate(input: TimeInput): Date | null {
  if (input === null || input === undefined || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface FormatOptions {
  locale?: string;
  /** Fallback string returned when `input` is missing/invalid. */
  fallback?: string;
}

/**
 * Short date + short time, e.g. "Jan 4, 2024, 3:42 PM" in en-US. Used in
 * table cells where horizontal space is at a premium but users still want
 * both date and time at a glance.
 */
export function formatDateTime(input: TimeInput, opts: FormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return opts.fallback ?? "—";
  const locale = opts.locale ?? defaultLocale();
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Date only, "Jan 4, 2024". */
export function formatDate(input: TimeInput, opts: FormatOptions = {}): string {
  const d = toDate(input);
  if (!d) return opts.fallback ?? "—";
  const locale = opts.locale ?? defaultLocale();
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
}

export interface FormatRelativeOptions extends FormatOptions {
  /** Current time. Defaults to `Date.now()`. Injected in tests. */
  now?: TimeInput;
}

/**
 * Human relative time, e.g. "3 min ago", "in 2 days", "just now". Uses
 * `Intl.RelativeTimeFormat` with the largest sensible unit — we don't
 * combine ("1h 3m ago") because that's awkward in a table cell.
 */
export function formatRelative(input: TimeInput, opts: FormatRelativeOptions = {}): string {
  const d = toDate(input);
  if (!d) return opts.fallback ?? "—";
  const nowDate = toDate(opts.now) ?? new Date();
  const diffMs = d.getTime() - nowDate.getTime();
  const absMs = Math.abs(diffMs);

  // Under 45s → "just now" in either direction. Matches most UIs.
  if (absMs < 45_000) return "just now";

  const locale = opts.locale ?? defaultLocale();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const { value, unit } = pickUnit(diffMs);
  return rtf.format(value, unit);
}

/** Choose the largest unit whose absolute magnitude is ≥ 1. */
function pickUnit(diffMs: number): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const s = diffMs / 1000;
  const abs = Math.abs(s);
  // Break-points mirror common UIs (GitHub, Linear). Slight rounding slop
  // in favour of the "friendly" direction: 89s rounds to "1 min", not "2".
  if (abs < 60) return { value: Math.round(s), unit: "second" };
  if (abs < 60 * 60) return { value: Math.round(s / 60), unit: "minute" };
  if (abs < 60 * 60 * 24) return { value: Math.round(s / 3600), unit: "hour" };
  if (abs < 60 * 60 * 24 * 7) return { value: Math.round(s / 86400), unit: "day" };
  if (abs < 60 * 60 * 24 * 30) return { value: Math.round(s / (86400 * 7)), unit: "week" };
  if (abs < 60 * 60 * 24 * 365) return { value: Math.round(s / (86400 * 30)), unit: "month" };
  return { value: Math.round(s / (86400 * 365)), unit: "year" };
}

/**
 * Full ISO string for the `title=` tooltip. Returns empty string on
 * invalid input so callers can spread it into JSX without a conditional.
 */
export function toIsoTitle(input: TimeInput): string {
  const d = toDate(input);
  return d ? d.toISOString() : "";
}

/**
 * Format a millisecond duration as "1m 23s" / "45s" / "2h 5m". Used for
 * run run durations. Negative / invalid → fallback.
 */
export function formatDuration(ms: number | null | undefined, opts: FormatOptions = {}): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return opts.fallback ?? "—";
  }
  // Sub-second values get rendered with the ms suffix instead of
  // rounding down to "0s" — keeps fast/instant steps legible (e.g. a
  // synthetic finalisation step whose events are flushed in 8ms shows
  // as "8ms" rather than disappearing into a misleading zero).
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
