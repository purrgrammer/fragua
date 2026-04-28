// Accelerator-key extraction for HITL choice labels.
//
// Lives in the browser-safe core surface (no @swarm/store import) so the
// web UI can call `stripAcceleratorPrefix` on labels it received over
// SSE. The wait.human handler re-exports both functions from
// `@swarm/core/handler` so server-side callers don't need a second
// import path.
//
// Patterns are tried in priority order:
//   [K] Label   — bracketed (most explicit, common in CLI menus)
//   K) Label    — paren after the letter
//   K - Label   — hyphenated (space-dash-space)

const ACCEL_BRACKET = /^\[([A-Za-z0-9])\]\s*/;
const ACCEL_PAREN = /^([A-Za-z0-9])\)\s*/;
const ACCEL_HYPHEN = /^([A-Za-z0-9]) - /;

/** Parse an accelerator key from a choice label, normalised to upper case.
 * Falls back to the first character when no annotation matches; falls
 * back to "?" for an empty label. */
export function parseAcceleratorKey(label: string): string {
  const m = ACCEL_BRACKET.exec(label) ?? ACCEL_PAREN.exec(label) ?? ACCEL_HYPHEN.exec(label);
  if (m?.[1]) return m[1].toUpperCase();
  return (label[0] ?? "?").toUpperCase();
}

/** Strip a leading accelerator-key annotation (`[A] `, `A) `, `A - `)
 * from a label. Idempotent on already-clean labels. */
export function stripAcceleratorPrefix(label: string): string {
  return label.replace(ACCEL_BRACKET, "").replace(ACCEL_PAREN, "").replace(ACCEL_HYPHEN, "");
}
