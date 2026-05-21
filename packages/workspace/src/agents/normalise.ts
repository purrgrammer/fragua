// Tool-name normalisation for agent definitions and inline `agent`
// tool calls. Fragua's canonical tool-name shape is lowercase snake_case
// (`read`, `web_fetch`, `bash`). Cross-client agent files (especially
// Claude-style) often use PascalCase (`Read`, `WebFetch`) which would
// silently fail the intersection check against the parent's pool.
//
// Two rules, applied in order, per the proposal:
//   1. Insert `_` between any lowercase→uppercase boundary (`WebFetch`
//      → `Web_Fetch`).
//   2. Lowercase the whole string (`Web_Fetch` → `web_fetch`).

export interface NormaliseToolNameResult {
  /** Canonical lowercase snake_case form. */
  name: string;
  /** True when the input wasn't already in canonical form — caller
   *  decides whether to surface a warning. */
  changed: boolean;
}

export function normaliseToolName(input: string): NormaliseToolNameResult {
  const snaked = input.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  const name = snaked.toLowerCase();
  return { name, changed: name !== input };
}
