// Tests for the graph-level `tool` handler (parallelogram shape).
//
// Uses an injected spawner so the suite runs hermetically — no real
// subprocesses. A separate smoke test at the bottom exercises the
// default Bun spawner to confirm the shell path works end-to-end.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { makeToolHandler, runWithBun, type SpawnFn, type ToolRunResult } from "../../src/handler/handlers/tool.ts";
import type { HandlerContext, SideEffectRecorder } from "../../src/handler/types.ts";

interface ArtifactRecord {
  key: string;
  content: string;
}

function stubCtx(overrides: Partial<HandlerContext> = {}): HandlerContext & {
  __emitted: { type: string; payload: Record<string, unknown> }[];
  __artifacts: ArtifactRecord[];
  __recorder: SideEffectRecorder;
} {
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const artifacts: ArtifactRecord[] = [];
  const intents: Parameters<SideEffectRecorder["recordIntent"]>[0][] = [];
  const dones: Parameters<SideEffectRecorder["recordDone"]>[0][] = [];
  const faileds: Parameters<SideEffectRecorder["recordFailed"]>[0][] = [];
  const recorder: SideEffectRecorder = {
    recordIntent: (p) => intents.push(p),
    recordDone: (p) => dones.push(p),
    recordFailed: (p) => faileds.push(p),
  };
  const base: HandlerContext = {
    runId: "r",
    nodeId: overrides.nodeId ?? "lint",
    iteration: 0,
    signal: new AbortController().signal,
    routing: overrides.routing ?? {},
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: {
      get: () => {
        throw new Error("no tools");
      },
      has: () => false,
      list: () => [],
    },
    messages: {
      append: () => ({ ordinal: 0 }),
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: (key, content) => {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        artifacts.push({ key, content: text });
        return { runId: "r", nodeId: "n", iteration: 0, key, sha256: "", sizeBytes: text.length, mime: null };
      },
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: overrides.args ?? {},
    emit: (type, payload) => emitted.push({ type, payload }),
  };
  const merged = { ...base, ...overrides };
  return Object.assign(merged, {
    __emitted: emitted,
    __artifacts: artifacts,
    __recorder: recorder,
  });
}

function fakeSpawner(run: Partial<ToolRunResult>): SpawnFn {
  return async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    ...run,
  });
}

describe("makeToolHandler — happy path", () => {
  test("exit 0 → outcome=success; stdout stored as artifact", async () => {
    const ctx = stubCtx({ nodeId: "lint" });
    const spec = makeToolHandler({
      toolCommand: "bun test",
      spawner: fakeSpawner({ exitCode: 0, stdout: "OK\n", stderr: "" }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("success");
      expect(result.routingDelta?.["tool.lint.exit_code"]).toBe(0);
    }
    const stdoutArt = ctx.__artifacts.find((a) => a.key === "lint:stdout");
    expect(stdoutArt?.content).toBe("OK\n");
    // No stderr artifact when stderr is empty.
    expect(ctx.__artifacts.find((a) => a.key === "lint:stderr")).toBeUndefined();
    // Observability event emitted.
    const evt = ctx.__emitted.find((e) => e.type === "tool.completed");
    expect(evt?.payload["exitCode"]).toBe(0);
  });

  test("non-zero exit → outcome=fail; stderr captured", async () => {
    const ctx = stubCtx({ nodeId: "tests" });
    const spec = makeToolHandler({
      toolCommand: "false",
      spawner: fakeSpawner({ exitCode: 1, stdout: "", stderr: "2 tests failed\n" }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.routingDelta?.["tool.tests.exit_code"]).toBe(1);
    }
    expect(ctx.__artifacts.find((a) => a.key === "tests:stderr")?.content).toBe("2 tests failed\n");
  });

  test("explicit nextNode overrides edge selection", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "echo hi",
      nextNode: "after",
      spawner: fakeSpawner({ exitCode: 0 }),
    });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.nextNode).toBe("after");
    }
  });
});

describe("makeToolHandler — substitution", () => {
  test("$ARGUMENTS is substituted into tool_command", async () => {
    const ctx = stubCtx({ args: { $ARGUMENTS: "auth.ts" } });
    let ranWith = "";
    const spec = makeToolHandler({
      toolCommand: "bun test $ARGUMENTS",
      spawner: async (cmd) => {
        ranWith = cmd;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    });
    await spec.handler(ctx);
    expect(ranWith).toBe("bun test auth.ts");
  });

  test("${context.name} from routing is substituted", async () => {
    const ctx = stubCtx({ routing: { pkg: "@swarm/core" } });
    let ranWith = "";
    const spec = makeToolHandler({
      toolCommand: "bun run --filter='${context.pkg}' typecheck",
      spawner: async (cmd) => {
        ranWith = cmd;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    });
    await spec.handler(ctx);
    expect(ranWith).toBe("bun run --filter='@swarm/core' typecheck");
  });
});

describe("makeToolHandler — failure modes", () => {
  test("empty tool_command → halt with error", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "   ",
      spawner: fakeSpawner({ exitCode: 0 }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") expect(result.detail).toContain("empty tool_command");
  });

  test("spawner throw (not abort) → halt with error", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "anything",
      spawner: async () => {
        throw new Error("sh: not found");
      },
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") expect(result.detail).toContain("tool spawn failed");
  });

  test("AbortError from spawner → halt with aborted detail", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "sleep 60",
      spawner: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
    if (result.kind === "halt") expect(result.detail).toContain("aborted");
  });
});

describe("makeToolHandler — property: exit-code → outcome mapping is deterministic", () => {
  test("∀ exit code: 0 → success; non-zero → fail", () => {
    fc.assert(
      fc.asyncProperty(fc.integer({ min: -128, max: 255 }), async (exitCode) => {
        const ctx = stubCtx();
        const spec = makeToolHandler({
          toolCommand: "echo x",
          spawner: fakeSpawner({ exitCode }),
        });
        const result = await spec.handler(ctx);
        expect(result.kind).toBe("transition");
        if (result.kind === "transition") {
          const expected = exitCode === 0 ? "success" : "fail";
          expect(result.outcomeStatus).toBe(expected);
        }
      }),
    );
  });
});

describe("makeToolHandler — smoke test with real Bun spawner", () => {
  test("a simple `echo` command runs through runWithBun and returns exit 0", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "echo swarm-tool-smoke",
      spawner: runWithBun,
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("success");
    }
    const stdout = ctx.__artifacts.find((a) => a.key.endsWith(":stdout"))?.content ?? "";
    expect(stdout).toContain("swarm-tool-smoke");
  });

  test("a non-zero exit command (`false`) runs through runWithBun and returns outcome=fail", async () => {
    const ctx = stubCtx({ nodeId: "die" });
    const spec = makeToolHandler({
      toolCommand: "false",
      spawner: runWithBun,
    });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.routingDelta?.["tool.die.exit_code"]).not.toBe(0);
    }
  });
});
