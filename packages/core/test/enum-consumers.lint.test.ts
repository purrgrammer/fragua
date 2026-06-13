// Enum-literal consumer lint (ground rule 1) — core's runtime HaltReason set.
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

import { describe, expect, test } from "bun:test";
import { HALT_REASONS } from "@fragua/types";
import { OutcomeSchema } from "../src/types/outcome.ts";

describe("enum-literal consumers (core)", () => {
  test("OutcomeSchema halt_reason union matches HALT_REASONS", () => {
    const haltReason = OutcomeSchema.properties.halt_reason;
    const members = (haltReason.anyOf ?? []) as Array<{ const?: unknown }>;
    const listed = members.map((m) => m.const).filter((c): c is string => typeof c === "string");
    expect(
      new Set(listed),
      "core/src/types/outcome.ts OutcomeSchema.halt_reason drifted from HALT_REASONS (@fragua/types)",
    ).toEqual(new Set(HALT_REASONS));
  });
});
