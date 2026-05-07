// Shared palette for the time-series analytics charts (Spend / Tokens /
// Cache). The four token-flow series map to the neutral chart ramp
// (theme.css §sw-chart-1..4) in a dark→light progression that mirrors
// the canonical bottom→top stack order — Input · Cache write · Cache
// read · Output. Reading the same series across all three charts now
// shows the same gray, and a single bar reads as a clean lightness ramp
// instead of jumping between strong and soft tones.

export const ANALYTICS_COLORS = {
  input: "var(--sw-chart-1)",
  cacheWrite: "var(--sw-chart-2)",
  cacheRead: "var(--sw-chart-3)",
  output: "var(--sw-chart-4)",
} as const;
