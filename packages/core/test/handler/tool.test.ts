// Tests for the graph-level `tool` handler (parallelogram shape).
//
// Uses an injected spawner so the suite runs hermetically — no real
// subprocesses. A separate smoke test at the bottom exercises the
// default Bun spawner to confirm the shell path works end-to-end.

import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@swarm/types";
import fc from "fast-check";
import { makeToolHandler, runWithBun, type SpawnFn, type ToolRunResult } from "../../src/handler/handlers/tool.ts";
import type { HandlerContext, SideEffectRecorder, ToolRegistry } from "../../src/handler/types.ts";
import type { ExecutionEnvironment } from "../../src/types/execution.ts";

interface ArtifactRecord {
  key: string;
  content: string;
}

const emptyRegistry: ToolRegistry = {
  get: () => {
    throw new Error("no tools");
  },
  has: () => false,
  list: () => [],
  select: () => emptyRegistry,
};

function stubCtx(overrides: Partial<HandlerContext> = {}): HandlerContext & {
  __emitted: { type: string; payload: Record<string, unknown> }[];
  __artifacts: ArtifactRecord[];
  __messages: AgentMessage[];
  __recorder: SideEffectRecorder;
} {
  const emitted: { type: string; payload: Record<string, unknown> }[] = [];
  const artifacts: ArtifactRecord[] = [];
  const messages: AgentMessage[] = [];
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
    tools: emptyRegistry,
    messages: {
      append: (m) => {
        messages.push(m);
        return { ordinal: messages.length - 1 };
      },
      recent: () => [],
      since: () => [],
    },
    artifacts: {
      put: (key, content) => {
        const text = typeof content === "string" ? content : new TextDecoder().decode(content);
        artifacts.push({ key, content: text });
        // nodeId / iteration mirror the node the handler is running on so
        // assertions about outputRef.nodeId can match real behaviour. The
        // production stub (buildHandlerContext) does the same — it pulls
        // these from the surrounding scope before calling store.putArtifact.
        return {
          runId: "r",
          nodeId: overrides.nodeId ?? "lint",
          iteration: 0,
          key,
          sha256: "",
          sizeBytes: text.length,
          mime: null,
        };
      },
      get: () => new Uint8Array(),
      ref: () => null,
      getFrom: () => new Uint8Array(),
    },
    externalCall: async (_, fn) => fn("stub-key"),
    args: overrides.args ?? {},
    nodeOutputs: overrides.nodeOutputs ?? new Map(),
    emit: (type, payload) => emitted.push({ type, payload }),
    withScope: () => {
      throw new Error("stubCtx: withScope not implemented for this test");
    },
  };
  const merged = { ...base, ...overrides };
  return Object.assign(merged, {
    __emitted: emitted,
    __artifacts: artifacts,
    __messages: messages,
    __recorder: recorder,
  });
}

/** Minimal in-memory ExecutionEnvironment so tests can verify the
 * handler routes through `env.exec` instead of the Bun fallback. Only
 * `cwd()` and `exec()` are exercised. */
function makeStubEnv(opts: {
  cwd: string;
  exec: (
    command: string,
    options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onData?: (chunk: string, kind: "stdout" | "stderr") => void;
    },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }>;
}): ExecutionEnvironment {
  return {
    cwd: () => opts.cwd,
    projectCwd: () => opts.cwd,
    readFile: async () => {
      throw new Error("not implemented");
    },
    writeFile: async () => {
      throw new Error("not implemented");
    },
    exists: async () => false,
    exec: async (command, options) => opts.exec(command, options),
    listDir: async () => [],
    glob: async () => [],
  };
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
    // Observability event emitted with cwd captured for diagnostics.
    const evt = ctx.__emitted.find((e) => e.type === "tool.completed");
    expect(evt?.payload["exitCode"]).toBe(0);
    expect(typeof evt?.payload["cwd"]).toBe("string");
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
  // Tool commands run substitution with `escapeForShell: true`, so
  // every substituted value is wrapped in POSIX single quotes. Adjacent
  // quoted/unquoted segments concatenate at shell tokenisation
  // (e.g. `--filter=''@swarm/core''` is one argument equal to
  // `--filter=@swarm/core`), so existing workflows that pre-quoted
  // their substitutions keep the same semantics.

  test("$ARGUMENTS is substituted into tool_command (shell-quoted)", async () => {
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
    expect(ranWith).toBe("bun test 'auth.ts'");
  });

  test("${context.name} from routing is substituted (shell-quoted)", async () => {
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
    // Pre-quoted templates keep working: the inner `'…'` from the
    // template + the outer `'…'` from escapeForShell concatenate at
    // shell tokenisation back into the unquoted value.
    expect(ranWith).toBe("bun run --filter=''@swarm/core'' typecheck");
  });

  test("$<nodeId>.output from prior nodes is shell-quoted (newline-bearing artifact stays one token)", async () => {
    // Regression: the crowdin-review bug. find_pr's output artifact
    // ended in `\n` (an `echo` adds it). Without escapeForShell, the
    // newline got interpolated raw and turned a one-line `gh pr review
    // …` chain into four /bin/sh statements. The fix wraps the value
    // in single quotes so the trailing newline becomes part of the
    // single argument.
    const ctx = stubCtx({
      nodeOutputs: new Map([["find_pr", { output: "9876\n", success: true, timestamp: 1 }]]),
    });
    let ranWith = "";
    const spec = makeToolHandler({
      toolCommand:
        "gh pr review $find_pr.output --approve && gh pr update-branch $find_pr.output && gh pr merge $find_pr.output --auto --squash",
      spawner: async (cmd) => {
        ranWith = cmd;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    });
    await spec.handler(ctx);
    // Each substitution wrapped in '…'; the newline is captured inside
    // the quoted token rather than ending the statement.
    expect(ranWith).toBe(
      "gh pr review '9876\n' --approve && gh pr update-branch '9876\n' && gh pr merge '9876\n' --auto --squash",
    );
  });

  test("a value containing single quotes is escaped per POSIX (close-quote, escaped quote, reopen)", async () => {
    const ctx = stubCtx({ args: { $ARGUMENTS: "it's fine" } });
    let ranWith = "";
    const spec = makeToolHandler({
      toolCommand: "echo $ARGUMENTS",
      spawner: async (cmd) => {
        ranWith = cmd;
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    });
    await spec.handler(ctx);
    expect(ranWith).toBe("echo 'it'\\''s fine'");
  });
});

describe("makeToolHandler — output capture", () => {
  test("stdout lands as artifact 'output' and outputRef is on the transition", async () => {
    // Mirrors the codergen capture contract: a tool node produces a single
    // canonical "output" artifact that downstream `$<nodeId>.output`
    // substitution dereferences. Without this, $build.output (where build
    // is a tool node) silently became "".
    const ctx = stubCtx({ nodeId: "build" });
    const spec = makeToolHandler({
      toolCommand: "bun run build",
      spawner: fakeSpawner({ exitCode: 0, stdout: "compiled 12 files\n", stderr: "" }),
    });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    if (result.kind === "transition") {
      expect(result.outputRef?.nodeId).toBe("build");
      expect(result.outputRef?.key).toBe("output");
    }
    const outputArt = ctx.__artifacts.find((a) => a.key === "output");
    expect(outputArt?.content).toBe("compiled 12 files\n");
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

describe("makeToolHandler — ExecutionEnvironment routing", () => {
  test("ctx.env.exec is used when env is wired and no spawner override is set", async () => {
    let ranCommand = "";
    let observedCwd: string | undefined;
    const env = makeStubEnv({
      cwd: "/tmp/run-xyz",
      exec: async (cmd, opts) => {
        ranCommand = cmd;
        observedCwd = "/tmp/run-xyz";
        // Verify the handler threads ctx.signal through to env.exec so
        // shutdown / steer aborts a long subprocess.
        expect(opts?.signal).toBeDefined();
        expect(typeof opts?.timeoutMs).toBe("number");
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 12 };
      },
    });
    // No `spawner` in cfg → env.exec must be the dispatch.
    const ctx = stubCtx({ nodeId: "lint", env });
    const spec = makeToolHandler({ toolCommand: "echo ok" });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    expect(ranCommand).toBe("echo ok");
    expect(observedCwd).toBe("/tmp/run-xyz");
    // tool.completed payload carries the env's cwd, not process.cwd().
    const evt = ctx.__emitted.find((e) => e.type === "tool.completed");
    expect(evt?.payload["cwd"]).toBe("/tmp/run-xyz");
  });

  test("explicit spawner overrides env.exec (test injection point preserved)", async () => {
    let envCalled = false;
    const env = makeStubEnv({
      cwd: "/tmp/run-xyz",
      exec: async () => {
        envCalled = true;
        return { exitCode: 0, stdout: "from-env", stderr: "", durationMs: 1 };
      },
    });
    const ctx = stubCtx({ env });
    const spec = makeToolHandler({
      toolCommand: "echo hi",
      spawner: fakeSpawner({ exitCode: 0, stdout: "from-spawner", stderr: "" }),
    });
    await spec.handler(ctx);
    expect(envCalled).toBe(false);
    expect(ctx.__artifacts.find((a) => a.key.endsWith(":stdout"))?.content).toBe("from-spawner");
  });

  test("no env, no spawner → falls back to Bun (process.cwd)", async () => {
    const ctx = stubCtx();
    const spec = makeToolHandler({ toolCommand: "echo no-env-fallback" });
    const result = await spec.handler(ctx);
    expect(result.kind).toBe("transition");
    const evt = ctx.__emitted.find((e) => e.type === "tool.completed");
    expect(evt?.payload["cwd"]).toBe(process.cwd());
  });
});

describe("makeToolHandler — output streaming", () => {
  test("env.exec onData chunks fan out as tool.output_chunk events with kind + content_index", async () => {
    const env = makeStubEnv({
      cwd: "/tmp/wt",
      exec: async (_cmd, opts) => {
        // Simulate a streamed stdout (two chunks) and a stderr chunk.
        opts?.onData?.("line1\n", "stdout");
        opts?.onData?.("line2\n", "stdout");
        opts?.onData?.("warn: x\n", "stderr");
        return { exitCode: 0, stdout: "line1\nline2\n", stderr: "warn: x\n", durationMs: 4 };
      },
    });
    const ctx = stubCtx({ nodeId: "build", env });
    const spec = makeToolHandler({ toolCommand: "echo build" });
    await spec.handler(ctx);

    const chunks = ctx.__emitted.filter((e) => e.type === "tool.output_chunk");
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.payload).toMatchObject({ kind: "stdout", delta: "line1\n", content_index: 0 });
    expect(chunks[1]?.payload).toMatchObject({ kind: "stdout", delta: "line2\n", content_index: 1 });
    expect(chunks[2]?.payload).toMatchObject({ kind: "stderr", delta: "warn: x\n", content_index: 0 });
  });

  test("a >3KB chunk is sliced into multiple events so the 4KB observability cap can't truncate the payload", async () => {
    const big = "y".repeat(7 * 1024); // 7 KB in one onData
    const env = makeStubEnv({
      cwd: "/tmp/wt",
      exec: async (_cmd, opts) => {
        opts?.onData?.(big, "stdout");
        return { exitCode: 0, stdout: big, stderr: "", durationMs: 1 };
      },
    });
    const ctx = stubCtx({ nodeId: "noisy", env });
    const spec = makeToolHandler({ toolCommand: "yes" });
    await spec.handler(ctx);

    const chunks = ctx.__emitted.filter((e) => e.type === "tool.output_chunk");
    // 7 KB at 3 KB per slice → 3 events.
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      const len = (c.payload["delta"] as string).length;
      expect(len).toBeLessThanOrEqual(3 * 1024);
    }
    // Slices reassemble to the original byte-perfect.
    const reassembled = chunks.map((c) => c.payload["delta"] as string).join("");
    expect(reassembled).toBe(big);
  });

  test("no onData is wired when there's no env (Bun fallback path) — chunks aren't emitted", async () => {
    // Test fallback: explicit spawner takes the place of env.exec, and
    // the test spawner doesn't synthesise streaming. No tool.output_chunk
    // events should fire.
    const ctx = stubCtx();
    const spec = makeToolHandler({
      toolCommand: "echo bare",
      spawner: fakeSpawner({ exitCode: 0, stdout: "bare\n", stderr: "" }),
    });
    await spec.handler(ctx);
    const chunks = ctx.__emitted.filter((e) => e.type === "tool.output_chunk");
    expect(chunks.length).toBe(0);
  });
});

describe("makeToolHandler — synthetic tool_node message", () => {
  test("appends a tool_node message carrying command, cwd, exit code, and stdout/stderr", async () => {
    const env = makeStubEnv({
      cwd: "/tmp/wt",
      exec: async () => ({ exitCode: 1, stdout: "line1\nline2\n", stderr: "boom\n", durationMs: 7 }),
    });
    const ctx = stubCtx({ nodeId: "tests", env });
    const spec = makeToolHandler({ toolCommand: "false" });
    await spec.handler(ctx);

    expect(ctx.__messages.length).toBe(1);
    const msg = ctx.__messages[0]! as Extract<AgentMessage, { role: "tool_node" }>;
    expect(msg.role).toBe("tool_node");
    expect(msg.command).toBe("false");
    expect(msg.cwd).toBe("/tmp/wt");
    expect(msg.exitCode).toBe(1);
    expect(msg.durationMs).toBe(7);
    expect(msg.stdout).toBe("line1\nline2\n");
    expect(msg.stderr).toBe("boom\n");
    expect(msg.stdoutTruncated).toBeUndefined();
    expect(msg.outputArtifactKey).toBe("tests:stdout");
  });

  test("very large stdout is tail-truncated inline; full bytes stay in the artifact", async () => {
    const big = "x".repeat(200 * 1024); // 200 KB
    const ctx = stubCtx({ nodeId: "build" });
    const spec = makeToolHandler({
      toolCommand: "echo big",
      spawner: fakeSpawner({ exitCode: 0, stdout: big, stderr: "" }),
    });
    await spec.handler(ctx);

    const msg = ctx.__messages[0]! as Extract<AgentMessage, { role: "tool_node" }>;
    expect(msg.stdoutTruncated).toBe(true);
    expect(msg.stdout.length).toBeLessThanOrEqual(50 * 1024);
    // Last bytes preserved (tail).
    expect(msg.stdout.endsWith("x")).toBe(true);
    // Artifact has the full 200KB.
    const stdoutArt = ctx.__artifacts.find((a) => a.key === "build:stdout");
    expect(stdoutArt?.content.length).toBe(big.length);
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
