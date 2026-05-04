// HandlerContext.withScope — structural rescoping for parallel branches.
//
// Replaces the two surgical patches in auto-dispatcher's deleted
// buildBranchContext (artifacts at d3eb674, emit at 08ca67d). withScope
// rebuilds all six scope-sensitive surfaces (artifacts / messages /
// externalCall / emit / tools / env) against a fresh (nodeId, iteration,
// allowedTools, deniedTools) while reusing the upstream resources
// (store, llm, http, recorder, signal, routing, …).

import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@swarm/store";
import { canonicalStringify } from "../../src/handler/canonical-stringify.ts";
import { buildHandlerContext } from "../../src/handler/context.ts";
import { InMemoryToolRegistry } from "../../src/handler/tool-registry.ts";
import type { SideEffectRecorder } from "../../src/handler/types.ts";
import type { ExecutionEnvironment } from "../../src/types/execution.ts";
import { ReadOnlyEnvError } from "../../src/types/read-only-env.ts";

interface PutCall {
  scope: { runId: string; nodeId: string; iteration: number; key: string };
  bytes: Uint8Array;
}

interface AppendCall {
  runId: string;
  nodeId: string | undefined;
  iteration: number | undefined;
}

function recorder(): SideEffectRecorder {
  return {
    recordIntent: () => {},
    recordDone: () => {},
    recordFailed: () => {},
  };
}

function fullEnv(written: { path: string; content: string }[]): ExecutionEnvironment {
  return {
    cwd: () => "/work",
    readFile: async () => "ok",
    writeFile: async (path, content) => {
      written.push({ path, content: typeof content === "string" ? content : new TextDecoder().decode(content) });
    },
    exists: async () => true,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
    listDir: async () => [],
    glob: async () => [],
  };
}

function registry(): InMemoryToolRegistry {
  const r = new InMemoryToolRegistry();
  r.register({ name: "read", sideEffect: "none", handler: async () => undefined });
  r.register({ name: "write", sideEffect: "external", handler: async () => undefined });
  r.register({ name: "bash", sideEffect: "external", handler: async () => undefined });
  return r;
}

/** Minimal IEventStore stub recording every put / append. We don't go
 * through SqliteStore because we want to assert exact (nodeId, iteration)
 * scope on each call without having to reconstruct it from the row. */
function makeStubStore(puts: PutCall[], appends: AppendCall[]) {
  return {
    putArtifact: (scope: PutCall["scope"], bytes: Uint8Array, mime?: string | null) => {
      puts.push({ scope, bytes });
      return {
        runId: scope.runId,
        nodeId: scope.nodeId,
        iteration: scope.iteration,
        key: scope.key,
        sha256: "stub",
        sizeBytes: bytes.byteLength,
        mime: mime ?? null,
      };
    },
    getArtifact: () => new Uint8Array(),
    getArtifactRef: () => null,
    appendMessage: (runId: string, row: { nodeId?: string; iteration?: number }) => {
      appends.push({ runId, nodeId: row.nodeId, iteration: row.iteration });
      return { ordinal: appends.length };
    },
    getMessages: () => [],
  };
}

function baseOpts(store: ReturnType<typeof makeStubStore>) {
  return {
    runId: "r1",
    nodeId: "parent",
    iteration: 3,
    signal: new AbortController().signal,
    routing: {},
    store: store as never,
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: registry(),
    recorder: recorder(),
  };
}

describe("HandlerContext.withScope", () => {
  test("rebuilds artifacts so put writes under the new (nodeId, iteration) scope", () => {
    const puts: PutCall[] = [];
    const store = makeStubStore(puts, []);
    const parent = buildHandlerContext(baseOpts(store));

    const child = parent.withScope({ nodeId: "branch_a", iteration: 0 });
    const ref = child.artifacts.put("output", "branch findings");

    expect(ref.nodeId).toBe("branch_a");
    expect(ref.iteration).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.scope.nodeId).toBe("branch_a");
    expect(puts[0]?.scope.iteration).toBe(0);
    expect(new TextDecoder().decode(puts[0]?.bytes)).toBe("branch findings");
  });

  test("rebuilds messages.append so the new scope is attributed on the row", () => {
    const appends: AppendCall[] = [];
    const store = makeStubStore([], appends);
    const parent = buildHandlerContext(baseOpts(store));

    const child = parent.withScope({ nodeId: "branch_b", iteration: 0 });
    child.messages.append({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 });

    expect(appends).toHaveLength(1);
    expect(appends[0]?.runId).toBe("r1");
    expect(appends[0]?.nodeId).toBe("branch_b");
    expect(appends[0]?.iteration).toBe(0);
  });

  test("rebuilds externalCall so idempotency keys reflect the new scope", async () => {
    const store = makeStubStore([], []);
    const parent = buildHandlerContext(baseOpts(store));
    const child = parent.withScope({ nodeId: "branch_c", iteration: 0 });

    let parentKey = "";
    let childKey = "";
    await parent.externalCall({ toolName: "t", args: { x: 1 }, attempt: 1 }, async (k) => {
      parentKey = k;
      return null;
    });
    await child.externalCall({ toolName: "t", args: { x: 1 }, attempt: 1 }, async (k) => {
      childKey = k;
      return null;
    });

    // Different scopes → different idempotency keys for identical args.
    expect(parentKey).not.toBe(childKey);

    // Reproduce the formula from external-call.ts to anchor the child key
    // on the new scope (branch_c, iteration=0).
    const argsHash = sha256Hex(canonicalStringify({ x: 1 }));
    const expected = sha256Hex(`r1\x00branch_c\x00${0}\x00${argsHash}\x001`);
    expect(childKey).toBe(expected);
  });

  test("rebuilds emit so payloads stamp the scope's nodeId/iteration even when upstream emitObservability stamps the parent", () => {
    const emitted: { type: string; payload: Record<string, unknown> }[] = [];
    const store = makeStubStore([], []);
    // Mimic executor.emitObservability: stamps parent currentNode/iteration,
    // then spreads payload last so payload-keys win.
    const upstreamStamp = (type: string, payload: Record<string, unknown>) => {
      emitted.push({ type, payload: { nodeId: "parent", iteration: 3, ...payload } });
    };
    const parent = buildHandlerContext({ ...baseOpts(store), emitObservability: upstreamStamp });
    const child = parent.withScope({ nodeId: "branch_d", iteration: 0 });

    child.emit("llm.start", { provider: "anthropic", model: "claude" });
    child.emit("cost.recorded", { tokens: 42 });

    expect(emitted).toHaveLength(2);
    for (const ev of emitted) {
      // Branch's scope wins: child's emit injects {...payload, nodeId,
      // iteration} into the upstream sink, and the upstream sink's
      // {...payload}-last spread preserves them.
      expect(ev.payload["nodeId"]).toBe("branch_d");
      expect(ev.payload["iteration"]).toBe(0);
    }
    expect(emitted[0]?.payload["provider"]).toBe("anthropic");
    expect(emitted[1]?.payload["tokens"]).toBe(42);
  });

  test("applies per-scope allowedTools/deniedTools to ctx.tools", () => {
    const store = makeStubStore([], []);
    const parent = buildHandlerContext(baseOpts(store));
    expect(parent.tools.has("bash")).toBe(true);
    expect(parent.tools.has("read")).toBe(true);

    const child = parent.withScope({ nodeId: "branch_e", iteration: 0, allowedTools: ["read"] });
    expect(child.tools.has("read")).toBe(true);
    expect(child.tools.has("bash")).toBe(false);
    expect(() => child.tools.get("bash")).toThrow(/unknown tool/);
  });

  test("applies per-scope allowedTools to env mutator-wrapping (read-only fallback when no mutator allowed)", async () => {
    const written: { path: string; content: string }[] = [];
    const store = makeStubStore([], []);
    const parent = buildHandlerContext({ ...baseOpts(store), env: fullEnv(written) });

    // Parent has full env: writeFile works.
    await parent.env!.writeFile("p", "parent-write");
    expect(written).toHaveLength(1);

    // Child narrows tools to read-only → env wraps to read-only proxy.
    const child = parent.withScope({ nodeId: "branch_f", iteration: 0, allowedTools: ["read"] });
    expect(child.env).toBeDefined();
    expect(await child.env!.readFile("anything")).toBe("ok");
    expect(() => child.env!.writeFile("x", "y")).toThrow(ReadOnlyEnvError);
    expect(() => child.env!.exec("ls")).toThrow(ReadOnlyEnvError);
  });

  test("does not mutate the parent ctx — parent.nodeId, parent.tools, parent.artifacts, parent.emit unchanged after child withScope", () => {
    const puts: PutCall[] = [];
    const emitted: { type: string; payload: Record<string, unknown> }[] = [];
    const store = makeStubStore(puts, []);
    const parent = buildHandlerContext({
      ...baseOpts(store),
      emitObservability: (type, payload) => emitted.push({ type, payload }),
    });

    // Trigger a child rescoping with aggressive narrowing.
    const child = parent.withScope({ nodeId: "branch_g", iteration: 0, allowedTools: ["read"] });
    expect(child.tools.has("bash")).toBe(false);

    // Parent is untouched: identity, tools, artifacts, emit all reflect
    // the original scope.
    expect(parent.nodeId).toBe("parent");
    expect(parent.iteration).toBe(3);
    expect(parent.tools.has("bash")).toBe(true);

    const ref = parent.artifacts.put("out", "parent-output");
    expect(ref.nodeId).toBe("parent");
    expect(ref.iteration).toBe(3);
    expect(puts.at(-1)?.scope.nodeId).toBe("parent");
    expect(puts.at(-1)?.scope.iteration).toBe(3);

    parent.emit("llm.start", { provider: "p" });
    const last = emitted.at(-1);
    expect(last?.payload["nodeId"]).toBe("parent");
    expect(last?.payload["iteration"]).toBe(3);
  });
});
