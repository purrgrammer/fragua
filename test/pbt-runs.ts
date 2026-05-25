// Repo-wide run-count scaling for every property suite (store, core, agent,
// daemon). Each property passes its baseline iteration count through
// `pbtRuns(base)`; the `FRAGUA_PBT_RUNS` env var multiplies it (default 1×).
//
//   bun test ./packages                  # baseline — fast per-PR CI
//   FRAGUA_PBT_RUNS=20 bun test ./packages   # deep nightly stress pass
//
// A MULTIPLIER (not an absolute override) so the baselines stay meaningful:
// suites differ wildly in per-run cost — a pure tier-1 planner property runs
// thousands of cases in the time one driven `runOne` harness does dozens — so
// each carries its own baseline and scaling preserves that ratio rather than
// flattening everything to one number.
//
// Lives at the repo root, not inside a package, so `store` can import it
// without inverting the `store ← daemon` dependency direction.

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
