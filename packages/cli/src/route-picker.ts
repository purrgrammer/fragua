// Interactive HITL route picker — the arrow-key select menu shown when an
// operator answers a `paused_human` gate (shared by `fragua run`'s follow loop
// and `fragua runs respond`). Mirrors the `prompts`-based select menus the
// providers commands use; choices show human-readable labels, not indices.

import prompts from "prompts";

/** Title-case a snake/kebab route name: `output_only` → "Output Only".
 *  Matches the web's `humanizeRouteName`. */
export function humanizeRoute(route: string): string {
  return route
    .split(/[_-]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
}

/** Render the routes as an arrow-key select and return the chosen route value,
 *  or `undefined` if the operator cancelled (Ctrl-C / Esc). `labels` are the
 *  workflow's `label=` overrides; a route absent from the map falls back to a
 *  humanized name. The selectable titles are human-readable; the returned value
 *  is the raw route the engine matches. */
export async function pickRoute(
  routes: string[],
  labels: Record<string, string>,
  message: string,
): Promise<string | undefined> {
  const { route } = await prompts({
    type: "select",
    name: "route",
    message,
    choices: routes.map((r) => ({ title: labels[r] ?? humanizeRoute(r), value: r })),
  });
  return typeof route === "string" ? route : undefined;
}
