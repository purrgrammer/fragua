// The PR gate runs the fault-injection suites (executor-faults +
// abort-planner) at FRAGUA_PBT_FAULT_RUNS× — independent of, and deeper than,
// the global FRAGUA_PBT_RUNS that scales the full node suite. That extra depth
// is what surfaces OCC-conflict / orphan-quarantine / abort-ceiling regressions
// before merge instead of only at nightly. A passing baseline (1×) can't tell
// us the wiring actually multiplies, so assert the resolved case count across
// the env combinations the CI ladder uses.
//
// SCALE is read at module load, so each combination runs in a fresh subprocess.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "..", "..", "..", "test", "pbt-runs.ts");

/** Run pbtRuns(base) and pbtFaultRuns(base) in a clean subprocess under `env`. */
function resolve(base: number, env: Record<string, string | undefined>): { runs: number; fault: number } {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  delete childEnv["FRAGUA_PBT_RUNS"];
  delete childEnv["FRAGUA_PBT_FAULT_RUNS"];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;

  const res = spawnSync(
    "bun",
    [
      "-e",
      `import {pbtRuns,pbtFaultRuns} from ${JSON.stringify(MODULE)};` +
        `process.stdout.write(JSON.stringify({runs:pbtRuns(${base}),fault:pbtFaultRuns(${base})}))`,
    ],
    { env: childEnv, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`subprocess failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim());
}

describe("PBT depth ladder — fault suites carry a dedicated multiplier", () => {
  test("baseline (no env): both multipliers are 1×", () => {
    expect(resolve(100, {})).toEqual({ runs: 100, fault: 100 });
  });

  test("PR gate (RUNS=3, FAULT_RUNS=5): full suite 3×, fault suites 5×", () => {
    expect(resolve(100, { FRAGUA_PBT_RUNS: "3", FRAGUA_PBT_FAULT_RUNS: "5" })).toEqual({ runs: 300, fault: 500 });
  });

  test("FAULT_RUNS unset falls back to global RUNS (nightly 20× still deepens fault suites)", () => {
    expect(resolve(100, { FRAGUA_PBT_RUNS: "20" })).toEqual({ runs: 2000, fault: 2000 });
  });

  test("invalid FAULT_RUNS falls back to global RUNS", () => {
    expect(resolve(100, { FRAGUA_PBT_RUNS: "3", FRAGUA_PBT_FAULT_RUNS: "nope" })).toEqual({ runs: 300, fault: 300 });
  });
});
