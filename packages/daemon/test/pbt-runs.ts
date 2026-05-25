// Per-property run-count scaling for the executor PBT suite. Every property
// passes its baseline iteration count through `pbtRuns(base)`; the
// `FRAGUA_PBT_RUNS` env var multiplies it (default 1×).
//
//   bun test packages/daemon            # baseline — fast CI
//   FRAGUA_PBT_RUNS=20 bun test ...     # 20× a deep adversarial stress pass
//
// A MULTIPLIER (not an absolute override) so the baselines stay meaningful:
// the driven/fault harnesses are far heavier per run than the pure tier-1
// properties, so they carry smaller baselines — scaling preserves that ratio
// rather than flattening everything to one number.

const SCALE: number = (() => {
  const raw = process.env["FRAGUA_PBT_RUNS"];
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/** Scale a property's baseline `numRuns` by `FRAGUA_PBT_RUNS` (≥1 result). */
export function pbtRuns(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}
