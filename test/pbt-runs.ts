// Repo-wide run-count scaling for every property suite (store, core, agent,
// daemon). Each property passes its baseline iteration count through
// `pbtRuns(base)`; the `FRAGUA_PBT_RUNS` env var multiplies it (default 1×).
//
//   bun run test:node                        # baseline — fast per-PR CI
//   FRAGUA_PBT_RUNS=20 bun run test:node      # deep nightly stress pass
//
// A MULTIPLIER (not an absolute override) so the baselines stay meaningful:
// suites differ wildly in per-run cost — a pure tier-1 planner property runs
// thousands of cases in the time one driven `runOne` harness does dozens — so
// each carries its own baseline and scaling preserves that ratio rather than
// flattening everything to one number.
//
// The fault-injection suites (OCC-conflict / orphan-quarantine / abort-ceiling)
// carry a SEPARATE knob, `FRAGUA_PBT_FAULT_RUNS`, applied via `pbtFaultRuns`.
// Their rare fault paths only surface at depth, so the PR gate runs them deeper
// (5×) than the full node suite (3×) to catch those regression classes before
// merge instead of waiting for nightly — without paying that depth across every
// property. When `FRAGUA_PBT_FAULT_RUNS` is unset the fault suites fall back to
// the global `FRAGUA_PBT_RUNS`, so nightly's 20× still deepens them.
//
// Lives at the repo root, not inside a package, so `store` can import it
// without inverting the `store ← daemon` dependency direction.

function resolveScale(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SCALE: number = resolveScale(process.env["FRAGUA_PBT_RUNS"], 1);
const FAULT_SCALE: number = resolveScale(process.env["FRAGUA_PBT_FAULT_RUNS"], SCALE);

/** Scale a property's baseline `numRuns` by `FRAGUA_PBT_RUNS` (≥1 result). */
export function pbtRuns(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}

/** Scale a fault-injection property's baseline by `FRAGUA_PBT_FAULT_RUNS`
 * (falling back to `FRAGUA_PBT_RUNS` when unset; ≥1 result). */
export function pbtFaultRuns(base: number): number {
  return Math.max(1, Math.round(base * FAULT_SCALE));
}
