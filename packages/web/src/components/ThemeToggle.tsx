// Quick light/dark flip for the topbar. The full preference (with
// "system") still lives on Settings; this is an at-a-glance flipper so
// operators can spot-check both themes without leaving the route.
//
// Persists through `useTheme` — the hook owns localStorage + the
// `<html class="dark">` toggle. We just translate a button click into
// the opposite resolved theme.

import { Moon, Sun } from "lucide-react";
import { useTheme } from "../lib/theme.ts";

export function ThemeToggle(): JSX.Element {
  const { resolved, setTheme } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  const Icon = resolved === "dark" ? Sun : Moon;
  const label = resolved === "dark" ? "Switch to light theme" : "Switch to dark theme";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
      data-testid="theme-toggle"
      className="inline-flex size-7 items-center justify-center rounded-sw-default text-sw-muted hover:text-sw-text transition-colors duration-[var(--sw-duration-hover)]"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
