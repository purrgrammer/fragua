// Thin `NumberFlow` wrapper for animated numeric counters.
//
// Most fragua numeric readouts tick via SSE (stats tiles, run detail
// header, per-step metrics). Snapping between values makes the UI feel
// static; number-flow's digit transition adds a light sense of motion
// without changing the underlying format.
//
// Contract (authoritative — callers rely on this, StatTile too):
//   - `value` must be a finite number to animate. Non-finite inputs
//     (`undefined`, `null`, `NaN`, `±Infinity`) render `fallback` (default
//     `"—"`) with no animation. Callers pass the raw value through as-is;
//     they must NOT pre-coerce to "—".
//   - `prefers-reduced-motion: reduce` → render a plain `<span>` with the
//     `Intl.NumberFormat(locale, format)`-formatted value. No animation,
//     no custom elements, SSR-safe.
//   - Otherwise → `<NumberFlow>` with subtle ≤250ms timings and no bounce.
//
// Composes with `lib/format.ts` — pass `usdFormatOptions(value)` /
// `tokensCompactFormatOptions(value)` / `tokensLongFormatOptions()` as
// `format` to mirror the existing formatter semantics instead of hand-
// crafting options inline.

import NumberFlow, { type Format as NumberFlowFormat } from "@number-flow/react";
import { useSyncExternalStore } from "react";
import { useLocale } from "@/lib/locale";

export interface AnimatedNumberProps {
  /** Raw numeric value; non-finite inputs (undefined/null/NaN/Infinity) render the fallback. */
  value: number | null | undefined;
  format?: Intl.NumberFormatOptions;
  locale?: string;
  prefix?: string;
  suffix?: string;
  className?: string;
  /** Fallback string when `value` is not a finite number. Default `"—"`. */
  fallback?: string;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(REDUCED_MOTION_QUERY);
  const listener = () => callback();
  // `addEventListener` is widely supported; older `addListener` kept as a
  // defensive fallback for ancient embedded browsers the dashboard may see.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }
  mql.addListener(listener);
  return () => mql.removeListener(listener);
}

function getMotionSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getServerMotionSnapshot(): boolean {
  // SSR: default to "no reduced motion preference known". The component
  // re-renders on the client once matchMedia resolves, so this just picks
  // the animated path for hydration stability.
  return false;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

const TIMING = { duration: 250, easing: "ease-out" } as const;

export function AnimatedNumber({
  value,
  format,
  locale,
  prefix,
  suffix,
  className,
  fallback = "—",
}: AnimatedNumberProps): JSX.Element {
  const prefersReducedMotion = useSyncExternalStore(subscribeMotion, getMotionSnapshot, getServerMotionSnapshot);
  const localeFromHook = useLocale();

  if (!isFiniteNumber(value)) {
    return <span className={className}>{fallback}</span>;
  }

  const resolvedLocale = locale ?? localeFromHook;

  if (prefersReducedMotion) {
    const formatted = new Intl.NumberFormat(resolvedLocale, format).format(value);
    return (
      <span className={className}>
        {prefix ?? ""}
        {formatted}
        {suffix ?? ""}
      </span>
    );
  }

  return (
    <NumberFlow
      value={value}
      // NumberFlow's `Format` is a narrower subset of `Intl.NumberFormatOptions`
      // (no `scientific` / `engineering` notation). Everything we feed in —
      // currency, percent, compact tokens — fits; the cast just bridges
      // Intl's wider union.
      format={format as NumberFlowFormat | undefined}
      locales={resolvedLocale}
      prefix={prefix}
      suffix={suffix}
      className={className}
      transformTiming={TIMING}
      spinTiming={TIMING}
      opacityTiming={TIMING}
    />
  );
}
