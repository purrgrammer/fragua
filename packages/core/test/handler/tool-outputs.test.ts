// Tests for the `tool` handler's structured-output production ($FRAGUA_OUTPUT).
//
// A stub ExecutionEnvironment supplies `createScratchFile`, and each test
// drives the read-back result the handler validates and attaches.

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@fragua/types";
import { makeToolHandler } from "../../src/handler/handlers/tool.ts";
import type { HandlerContext, SideEffectRecorder, ToolRegistry } from "../../src/handler/types.ts";
import type { ExecutionEnvironment, ScratchReadResult } from "../../src/types/execution.ts";
import type { OutputsDecl } from "../../src/types/outputs.ts";

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

const TOTAL_DECL: OutputsDecl = { total: { kind: "number" } };

interface EnvOpts {
  exitCode?: number;
  scratchRead?: ScratchReadResult;
  withScratch?: boolean;
  onExecEnv?: (env: Record<string, string> | undefined) => void;
  readThrows?: unknown;
}

function makeEnv(opts: EnvOpts): ExecutionEnvironment {
  const env: ExecutionEnvironment = {
    cwd: () => "/cwd",
    projectCwd: () => "/cwd",
    readFile: async () => {
      throw new Error("nyi");
    },
    writeFile: async () => {},
    exists: async () => false,
    exec: async (_command, options) => {
      opts.onExecEnv?.(options?.env);
      return { stdout: "", stderr: "", exitCode: opts.exitCode ?? 0, durationMs: 1 };
    },
    listDir: async () => [],
    glob: async () => [],
  };
  if (opts.withScratch !== false) {
    env.createScratchFile = async (_key) => ({
      path: "/tmp/fragua-scratch/r/collect-0",
      read: async () => {
        if (opts.readThrows !== undefined) throw opts.readThrows;
        return opts.scratchRead ?? { kind: "absent" };
      },
      dispose: async () => {},
    });
  }
  return env;
}

function stubCtx(env: ExecutionEnvironment, sink?: AgentMessage[]): HandlerContext {
  const messages: AgentMessage[] = sink ?? [];
  const recorder: SideEffectRecorder = {
    recordIntent: () => {},
    recordDone: () => {},
    recordFailed: () => {},
  };
  void recorder;
  return {
    runId: "r",
    nodeId: "collect",
    iteration: 0,
    signal: new AbortController().signal,
    routing: {},
    env,
    llm: { call: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }) },
    http: { fetch: async () => new Response("") },
    tools: emptyRegistry,
    messages: {
      append: (m: AgentMessage) => {
        messages.push(m);
        return { ordinal: messages.length - 1 };
      },
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: (key: string, content: string | Uint8Array) => {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        return { runId: "r", nodeId: "collect", iteration: 0, key, sha256: "", sizeBytes: text.length, mime: null };
      },
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_: unknown, fn: (key: string) => unknown) => fn("stub-key"),
    args: {},
    emit: () => {},
  } as unknown as HandlerContext;
}

describe("tool handler structured outputs", () => {
  test("attaches validated outputs when the scratch file holds a valid struct", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: '{"total":42}' } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("success");
      expect(result.outputs).toEqual({ total: 42 });
    }
  });

  test("FRAGUA_OUTPUT is injected into the child env", async () => {
    let seen: Record<string, string> | undefined;
    const capture = (e: Record<string, string> | undefined): void => {
      seen = e;
    };
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: '{"total":1}' }, onExecEnv: capture }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    await spec.handler(ctx);
    expect(seen?.["FRAGUA_OUTPUT"]).toBe("/tmp/fragua-scratch/r/collect-0");
  });

  test("absent emission on exit 0 fails the node with producer.no_emission", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "absent" } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("producer.no_emission");
      expect(result.outputs).toBeUndefined();
    }
  });

  test("renamed emission fails with producer.rename_not_supported", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "renamed" } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("producer.rename_not_supported");
    }
  });

  test("oversize emission fails with producer.invalid_emission", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "oversize" } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("producer.invalid_emission");
    }
  });

  test("unparseable JSON fails the node, not a downstream UnpopulatedOutputError", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: "not json" } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("not valid JSON");
    }
  });

  test("schema-invalid struct fails via validateOutputsValue", async () => {
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: '{"total":"nope"}' } }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("producer.invalid_emission");
    }
  });

  test("abort during read-back halts terminally, not a transition-fail", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const ctx = stubCtx(makeEnv({ readThrows: abortErr }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("halt");
  });

  test("a node declaring outputs in an env lacking createScratchFile fails closed", async () => {
    const ctx = stubCtx(makeEnv({ withScratch: false }));
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("$FRAGUA_OUTPUT channel");
    }
  });

  test("non-zero exit does not read the scratch file and fails as before", async () => {
    let read = false;
    const env = makeEnv({ exitCode: 1 });
    env.createScratchFile = async () => ({
      path: "/tmp/x",
      read: async () => {
        read = true;
        return { kind: "absent" };
      },
      dispose: async () => {},
    });
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(stubCtx(env));
    if (result.kind === "transition") {
      expect(result.outcomeStatus).toBe("fail");
      expect(result.failureReason).toContain("exit 1");
    }
    expect(read).toBe(false);
  });

  test("the emitted struct rides on the tool_node message, appended exactly once", async () => {
    const sink: AgentMessage[] = [];
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: '{"total":42}' } }), sink);
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    await spec.handler(ctx);
    expect(sink).toHaveLength(1);
    const msg = sink[0];
    expect(msg?.role).toBe("tool_node");
    if (msg?.role === "tool_node") expect(msg.outputs).toEqual({ total: 42 });
  });

  test("a rejected emission still appends the message, so the terminal output diagnoses it", async () => {
    const sink: AgentMessage[] = [];
    const ctx = stubCtx(makeEnv({ scratchRead: { kind: "ok", text: "not json" } }), sink);
    const spec = makeToolHandler({ toolCommand: "./collect.sh", outputs: TOTAL_DECL });
    const result = await spec.handler(ctx);
    if (result.kind === "transition") expect(result.outcomeStatus).toBe("fail");
    expect(sink).toHaveLength(1);
    const msg = sink[0];
    if (msg?.role === "tool_node") expect(msg.outputs).toBeUndefined();
  });

  test("a non-producing tool node appends its message with no outputs", async () => {
    const sink: AgentMessage[] = [];
    const ctx = stubCtx(makeEnv({}), sink);
    const spec = makeToolHandler({ toolCommand: "./fmt.sh" });
    await spec.handler(ctx);
    expect(sink).toHaveLength(1);
    const msg = sink[0];
    if (msg?.role === "tool_node") expect(msg.outputs).toBeUndefined();
  });
});
