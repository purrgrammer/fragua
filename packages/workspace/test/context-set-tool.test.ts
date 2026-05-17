// context_set \u2014 wire-level execute() against a swarmContext that carries
// the per-turn `contextWrites` Map the codergen backend allocates.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment } from "@swarm/core";
import { contextSetTool } from "../src/context-set-tool.ts";
import type { SwarmToolContext } from "../src/types.ts";

function emptyEnv(): ExecutionEnvironment {
  // context_set never touches the filesystem. Cast through unknown so
  // we don't have to scaffold the full surface.
  return {} as unknown as ExecutionEnvironment;
}

function ctxWith(
  writes: Map<string, { value: string | number | boolean | null; prevValue?: string | number | boolean | null }>,
): SwarmToolContext {
  return {
    runId: "r1",
    nodeId: "n1",
    iteration: 0,
    http: { fetch: () => Promise.reject(new Error("not used")) } as unknown as SwarmToolContext["http"],
    emit: () => {},
    contextWrites: writes,
  };
}

describe("context_set tool", () => {
  test("writes scalar values into swarmContext.contextWrites", async () => {
    const writes = new Map();
    const out = await contextSetTool.execute(
      { key: "foo", value: "bar" },
      emptyEnv(),
      { swarmContext: ctxWith(writes) },
    );
    expect(out.is_error).toBeUndefined();
    expect(writes.get("foo")).toEqual({ value: "bar" });
    expect(out.data?.ok).toBe(true);
  });

  test("captures prevValue on overwrite", async () => {
    const writes = new Map();
    await contextSetTool.execute({ key: "foo", value: "first" }, emptyEnv(), {
      swarmContext: ctxWith(writes),
    });
    await contextSetTool.execute({ key: "foo", value: "second" }, emptyEnv(), {
      swarmContext: ctxWith(writes),
    });
    expect(writes.get("foo")).toEqual({ value: "second", prevValue: "first" });
  });

  test("rejects key with dot", async () => {
    const writes = new Map();
    const out = await contextSetTool.execute(
      { key: "a.b", value: "x" },
      emptyEnv(),
      { swarmContext: ctxWith(writes) },
    );
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/no dots|contains a dot/);
    expect(writes.size).toBe(0);
  });

  test("rejects empty key", async () => {
    const writes = new Map();
    const out = await contextSetTool.execute(
      { key: "", value: "x" },
      emptyEnv(),
      { swarmContext: ctxWith(writes) },
    );
    expect(out.is_error).toBe(true);
    expect(writes.size).toBe(0);
  });

  test("accepts null value", async () => {
    const writes = new Map();
    const out = await contextSetTool.execute(
      { key: "k", value: null },
      emptyEnv(),
      { swarmContext: ctxWith(writes) },
    );
    expect(out.is_error).toBeUndefined();
    expect(writes.get("k")?.value).toBeNull();
  });

  test("surfaces missing-backend wiring as an error", async () => {
    // Strip `contextWrites` from the swarmContext via a fresh object
    // instead of `as SwarmToolContext` so TS doesn't reject the
    // narrowing cast (the field is readonly + non-optional in the
    // type's positive path; passing `undefined` exercises the runtime
    // fallback guard).
    const full = ctxWith(new Map());
    const { contextWrites: _drop, ...rest } = full;
    const out = await contextSetTool.execute(
      { key: "k", value: "v" },
      emptyEnv(),
      { swarmContext: rest as SwarmToolContext },
    );
    expect(out.is_error).toBe(true);
    expect(out.text).toMatch(/backend not wired/);
  });
});
