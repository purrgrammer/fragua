// Centralised neutral palette for non-status analytics charts (Spend,
// Tokens, Cache, Models, Workflows). Run/Outcomes keep their semantic
// status colors; everything else pulls from here so the chart-y bits
// can be re-tuned in one place.
//
// We use Tailwind's `slate` ramp (cool gray) rather than `gray` so the
// charts read as a deliberate design choice instead of "missing color."

/** Two-tone stacked bars (input/output, reads/writes). */
export const NEUTRAL_PAIR = {
  primary: "var(--color-slate-500)",
  secondary: "var(--color-slate-300)",
} as const;

/** Cycling palette for multi-slice donut/bar charts (Models). Slices
 *  ordered by magnitude DESC, so the darkest tone naturally lands on
 *  the biggest contributor. Cycles for >4 slices. */
export const NEUTRAL_PALETTE: readonly string[] = [
  "var(--color-slate-700)",
  "var(--color-slate-500)",
  "var(--color-slate-300)",
  "var(--color-slate-200)",
];

/** Single-tone bar charts (Top workflows). */
export const NEUTRAL_SOLO = "var(--color-slate-500)";
