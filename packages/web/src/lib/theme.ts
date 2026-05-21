// Lightweight theme controller for the web UI.
//
// Tailwind is already configured with `darkMode: ["class"]` and
// `globals.css` ships both `:root` and `.dark` token sets, so toggling
// the entire UI is just a matter of flipping `<html class="dark">`.
// This module owns three concerns and nothing else:
//
//   1. Persist the user's choice in `localStorage` under
//      `fragua.web.theme` so reloads restore it.  The default theme
//      when no preference has been stored is "light".
//   2. Resolve "system" against `prefers-color-scheme` and keep that
//      resolution in sync with OS-level changes while "system" is
//      active.
//   3. Expose `applyTheme` for the bootstrap path in `main.tsx`
//      (runs before React mounts, avoids a flash of the wrong theme)
//      and `useTheme` for React consumers like the Settings page.
//
// Kept framework-free on the write side: `applyTheme` is a plain
// function so the pre-render bootstrap can call it without pulling in
// React.

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "fragua.web.theme";
const VALID: readonly Theme[] = ["light", "dark", "system"];

/** Read the persisted preference, defaulting to "light". */
export function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "light";
  const raw = localStorage.getItem(STORAGE_KEY);
  return (VALID as readonly string[]).includes(raw ?? "") ? (raw as Theme) : "light";
}

/** Resolve "system" via `prefers-color-scheme`; pass-through otherwise. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Flip `<html class="dark">` to match the requested theme. Safe to call
 * before React mounts — used by `main.tsx` to avoid a FOUC on reload.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

/**
 * React hook: returns the current preference plus a setter that both
 * persists and applies. While "system" is active, we subscribe to the
 * OS media query so the UI follows dark-mode changes live.
 */
export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void; resolved: "light" | "dark" } {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());
  const [resolved, setResolved] = useState<"light" | "dark">(() => resolveTheme(theme));

  const setTheme = useCallback((next: Theme) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    setThemeState(next);
    setResolved(resolveTheme(next));
  }, []);

  // Follow OS changes while "system" is selected. Unsubscribe whenever
  // the user picks an explicit mode so we don't stomp their choice.
  useEffect(() => {
    if (theme !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      applyTheme("system");
      setResolved(resolveTheme("system"));
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme, resolved };
}
