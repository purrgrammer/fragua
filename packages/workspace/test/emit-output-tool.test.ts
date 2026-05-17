// emit_output \u2014 wire-level execute() against a swarmContext that carries
// the per-turn `pendingOutput` slot the codergen backend allocates, plus
// optional `outputSchema` for Value.Check enforcement.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@swarm/core";
import { emitOutputTool } from "../src/emit-output-tool.ts";
import type { SwarmToolContext } from "../src/types.ts";

function emptyEnv(): ExecutionEnvironment {
  return {} as unknown as ExecutionEnvironment;
}

function ctxWith(slot: { value: { data: unknown } | undefined }, schema?: unknown): SwarmToolContext {
  return {
    runId: "r1",
    nodeId: "n1",
    iteration: 0,
    http: { fetch: () => Promise.reject(new Error("not used")) } as unknown as SwarmToolContext["http"],
    emit: () => {},
    pendingOutput: slot,
    ...(schema !== undefined ? { outputSchema: schema } : {}),
  };
}

describe("emit_output tool", () => {
  test("stores data on swarmContext.pendingOutput", async () => {
    const slot: { value: { data: unknown } | undefined } = { value: undefined };
    const out = await emitOutputTool.execute({ data: { label: "x" } }, emptyEnv(), { swarmContext: ctxWith(slot) });
    expect(out.is_error).toBeUndefined();
    expect(slot.value).toEqual({ data: { label: "x" } });
    expect(out.data?.ok).toBe(true);
  });

  test("last-write-wins across multiple calls in one turn", async () => {
    const slot: { value: { data: unknown } | undefined } = { value: undefined };
    await emitOutputTool.execute({ data: "first" }, emptyEnv(), { swarmContext: ctxWith(slot) });
    await emitOutputTool.execute({ data: "second" }, emptyEnv(), { swarmContext: ctxWith(slot) });
    expect(slot.value).toEqual({ data: "second" });
  });

  test("accepts schema-valid data", async () => {
    const slot: { value: { data: unknown } | undefined } = { value: undefined };
    // Build the schema via Typebox so Value.Check recognises it.
    const { Type } = await import("@sinclair/typebox");
    const schema = Type.Object({ label: Type.String() });
    const out = await emitOutputTool.execute({ data: { label: "ok" } }, emptyEnv(), {
      swarmContext: ctxWith(slot, schema),
    });
    expect(out.is_error).toBeUndefined();
    expect(slot.value).toEqual({ data: { label: "ok" } });
  });

  test("rejects data violating output_schema with structured errors", async () => {
    const slot: { value: { data: unknown } | undefined } = { value: undefined };
    const { Type } = await import("@sinclair/typebox");
    const schema = Type.Object({ label: Type.String() });
    const out = await emitOutputTool.execute({ data: {} }, emptyEnv(), { swarmContext: ctxWith(slot, schema) });
    expect(out.is_error).toBe(true);
    expect(out.data?.ok).toBe(false);
    expect(Array.isArray(out.data?.errors)).toBe(true);
    expect((out.data?.errors ?? []).length).toBeGreaterThan(0);
    // Slot stays empty when validation fails.
    expect(slot.value).toBeUndefined();
  });

  test("surfaces missing-backend wiring as an error", async () => {
    const out = await emitOutputTool.execute({ data: { x: 1 } }, emptyEnv(), {
      swarmContext: { runId: "r1", nodeId: "n1", iteration: 0, http: {} as never, emit: () => {} },
    });
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/backend not wired/);
  });
});
