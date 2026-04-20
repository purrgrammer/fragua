// Single source of truth for locale resolution used by the web package's
// formatting layer (numbers, currencies, dates, times, relative strings).
//
// Currently: `navigator.language` → `"en-US"` fallback. If we later add a
// user-facing locale picker, only this module needs to change — all
// `Intl.*` call sites read through here, either via the `defaultLocale()`
// function (from plain utilities like `lib/format.ts` / `lib/time.ts`) or
// the `useLocale()` hook (from React components like `AnimatedNumber`).

/** Resolve the current locale. Safe to call outside React. */
export function defaultLocale(): string {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
    return navigator.language;
  }
  return "en-US";
}

/**
 * React-side locale accessor. Thin wrapper over `defaultLocale()` so that
 * future changes (e.g. a LocaleContext for user-preferred overrides) land in
 * one place without chasing every consumer. Consumers that want to pass an
 * explicit locale still can — this hook only decides the default.
 */
export function useLocale(): string {
  return defaultLocale();
}
