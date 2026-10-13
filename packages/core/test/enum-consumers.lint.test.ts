// Enum-literal consumer lint (ground rule 1) — core's runtime HaltReason and
// OutcomeStatus sets.
//
// `OutcomeSchema.halt_reason` (src/types/outcome.ts) hand-lists the
// HaltReason literals as TypeBox `Type.Literal(...)` members so checkpoint
// validation works at runtime. TypeScript checks each literal is assignable
// to `HaltReason` only through the Static<> derivation downstream — a
// REMOVED union literal left behind here, or a NEW one missing, would
// otherwise drift silently. Assert the schema's `anyOf` consts are exactly
// the HALT_REASONS tuple from @fragua/types.
//
// (The HandlerResult halt union in src/handler/types.ts is deliberately a
// DIFFERENT handler-contract set — `goal_gate_unsatisfied` etc. get
// translated by result-to-facts — and is not a HaltReason consumer.)
//
// OutcomeStatus: `OUTCOME_STATUSES` (src/types/outcome.ts) is the one tuple.
// The handler outcome schema, the goal-gate routing union, and the value
// guard derive from it; the `@fragua/types` node_completed payload cannot
// import core, so it is pinned here by source scan, and any re-hand-listed
// copy elsewhere in the TS packages fails the scan.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HALT_REASONS } from "@fragua/types";
import { OUTCOME_STATUS as PUBLIC_OUTCOME_STATUS } from "../src/index.ts";
import { RoutingStruct } from "../src/routing.ts";
import { isOutcomeStatus, OUTCOME_STATUSES, OutcomeSchema } from "../src/types/outcome.ts";

const PACKAGES = join(import.meta.dir, "..", "..");

function unionConsts(schema: { anyOf?: unknown }): string[] {
  const members = (schema.anyOf ?? []) as Array<{ const?: unknown }>;
  return members.map((m) => m.const).filter((c): c is string => typeof c === "string");
}

function tsSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsSources(p));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const HAND_LISTED_OUTCOME = [
  /"success"\s*\|\s*"fail"\s*\|\s*"retry"/,
  /Type\.Literal\("success"\)\s*,\s*Type\.Literal\("fail"\)\s*,\s*Type\.Literal\("retry"\)/,
  /\[\s*"success"\s*,\s*"fail"\s*,\s*"retry"\s*\]/,
];

describe("enum-literal consumers (core)", () => {
  test("OutcomeSchema halt_reason union matches HALT_REASONS", () => {
    const listed = unionConsts(OutcomeSchema.properties.halt_reason);
    expect(
      new Set(listed),
      "core/src/types/outcome.ts OutcomeSchema.halt_reason drifted from HALT_REASONS (@fragua/types)",
    ).toEqual(new Set(HALT_REASONS));
  });

  test("OutcomeSchema status union matches OUTCOME_STATUSES", () => {
    expect(unionConsts(OutcomeSchema.properties.status)).toEqual([...OUTCOME_STATUSES]);
  });

  test("routing OUTCOME_STATUS union matches OUTCOME_STATUSES", () => {
    expect(unionConsts(PUBLIC_OUTCOME_STATUS)).toEqual([...OUTCOME_STATUSES]);
    expect(
      unionConsts(RoutingStruct.properties.goalGate.properties.outcomes.patternProperties["^(.*)$"] ?? {}),
    ).toEqual([...OUTCOME_STATUSES]);
  });

  test("isOutcomeStatus accepts exactly OUTCOME_STATUSES", () => {
    for (const s of OUTCOME_STATUSES) expect(isOutcomeStatus(s)).toBe(true);
    for (const v of ["retrying", "", null, 1, undefined, "SUCCESS"]) expect(isOutcomeStatus(v)).toBe(false);
  });

  test("no hand-listed outcome-status literal set outside outcome.ts", () => {
    const owner = join(PACKAGES, "core", "src", "types", "outcome.ts");
    const offenders: string[] = [];
    for (const pkg of ["core", "daemon", "agent"]) {
      for (const file of tsSources(join(PACKAGES, pkg, "src"))) {
        if (file === owner) continue;
        const src = readFileSync(file, "utf8");
        if (HAND_LISTED_OUTCOME.some((re) => re.test(src))) offenders.push(relative(PACKAGES, file));
      }
    }
    expect(offenders, "derive from OUTCOME_STATUSES / OutcomeStatus instead of hand-listing").toEqual([]);
  });

  test("@fragua/types node_completed.outcomeStatus matches OUTCOME_STATUSES", () => {
    const src = readFileSync(join(PACKAGES, "types", "src", "events.ts"), "utf8");
    const lines = src.split("\n").filter((l) => /^\s*outcomeStatus\?:/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const literals = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(new Set(literals), `types/src/events.ts drifted: ${line.trim()}`).toEqual(new Set(OUTCOME_STATUSES));
    }
  });
});
