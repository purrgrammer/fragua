// GraphLoader: prefer the persisted canonical IR; fall back to parsing
// `source` only when a row carries no IR (proposal workflow-ir, move A).

import { describe, expect, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph, stripLoc } from "@fragua/core";
import type { WorkflowRow } from "@fragua/store";
import { makeGraphLoader } from "../src/graph-loader.ts";

const SOURCE = `name: t
steps:
  work: {type: llm, prompt: do it, next: exit}
`;

function fakeStore(rows: Record<string, WorkflowRow>): { getWorkflow(sha: string): WorkflowRow | null } {
  return { getWorkflow: (sha) => rows[sha] ?? null };
}

function row(over: Partial<WorkflowRow>): WorkflowRow {
  return {
    sha: "s",
    name: "t",
    source: SOURCE,
    ir: serializeGraph(parseWorkflow(SOURCE)),
    irVersion: CURRENT_IR_VERSION,
    createdAt: 0,
    ...over,
  };
}

describe("makeGraphLoader — deserialize stored IR", () => {
  test("deserializes the stored IR and never touches source", () => {
    // Source is deliberately un-parseable: if the loader used it, this fails.
    const loader = makeGraphLoader(fakeStore({ s: row({ source: "}{ not yaml" }) }));
    const res = loader.load("s");
    expect(res.ok).toBe(true);
    // IR is the loc-stripped parse output — executor-equivalent.
    if (res.ok) expect(res.graph).toEqual(stripLoc(parseWorkflow(SOURCE)));
  });

  test("missing workflow → reason 'missing'", () => {
    const loader = makeGraphLoader(fakeStore({}));
    const res = loader.load("nope");
    expect(res).toEqual({ ok: false, reason: "missing" });
  });

  test("malformed IR JSON → reason 'unparseable' carrying the JSON parse message", () => {
    const loader = makeGraphLoader(fakeStore({ s: row({ ir: "}{ broken", irVersion: CURRENT_IR_VERSION }) }));
    const res = loader.load("s");
    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "unparseable") throw new Error("expected unparseable");
    expect(res.errorMessage).toMatch(/JSON/i);
  });

  test("ir_version newer than this runtime → 'unparseable' (no down-conversion) with the version message", () => {
    const ir = serializeGraph(parseWorkflow(SOURCE));
    const loader = makeGraphLoader(fakeStore({ s: row({ ir, irVersion: CURRENT_IR_VERSION + 1 }) }));
    const res = loader.load("s");
    expect(res.ok).toBe(false);
    if (res.ok || res.reason !== "unparseable") throw new Error("expected unparseable");
    expect(res.errorMessage).toContain(`ir_version ${CURRENT_IR_VERSION + 1} > supported ${CURRENT_IR_VERSION}`);
  });

  test("unparseable result — including its message — is memoized (no re-parse per dispatch)", () => {
    let calls = 0;
    const broken = row({ ir: "}{ broken", irVersion: CURRENT_IR_VERSION });
    const loader = makeGraphLoader({
      getWorkflow: () => {
        calls++;
        return broken;
      },
    });
    const first = loader.load("s");
    const second = loader.load("s");
    expect(second).toEqual(first);
    if (second.ok || second.reason !== "unparseable") throw new Error("expected unparseable");
    expect(second.errorMessage).toMatch(/JSON/i);
    expect(calls).toBe(1);
  });
});
