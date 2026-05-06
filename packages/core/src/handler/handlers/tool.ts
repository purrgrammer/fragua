// tool handler — attractor-spec §4.10 graph-level shell step.
//
// A `tool` node (parallelogram shape) runs `node.attrs.tool_command` as a
// single shell invocation — no LLM, no agent loop. It is the deterministic
// complement to codergen: fixed string goes in, exit code + captured
// stdout/stderr come out, outcome maps directly.
//
// Distinct from agent-callable tools (read / write / edit / bash) that an
// LLM invokes inside a codergen turn. Those live in the ToolRegistry the
// pi-agent backend passes to each call; the ToolRegistry is untouched
// here.
//
// Design choices:
//
//   - `tool_command` is substituted through the same prompt substitution
//     machinery codergen uses ($ARGUMENTS, $nodeId.output[.path],
//     ${context.x}). This is the only place the substitution fires
//     outside prompts.
//
//   - Exit 0 → outcome=success. Non-zero → outcome=fail. Bash has no
//     native "retry" signal; a workflow that wants retry wraps the tool
//     node in a codergen that inspects stdout and emits the desired
//     outcome. (Future: allow tools to print a trailing `OUTCOME: retry`
//     line; omitted for now — YAGNI.)
//
//   - Stdout + stderr are written as artifacts keyed by `${nodeId}:stdout`
//     / `${nodeId}:stderr` so downstream nodes can `$toolNodeId.output`
//     against them through the normal substitution path. A
//     `tool_node`-role message row is also appended to `messages`
//     carrying the command, cwd, exit code, and a tail-truncated
//     stdout/stderr — that's what RunConversation reads.
//
//   - Execution routes through `ctx.env.exec(...)` when an
//     `ExecutionEnvironment` is wired (production; isolates per-run
//     cwd to the worktree, and inherits the env adapter's blocklist
//     and abort/timeout behaviour). Falls back to `Bun.spawn` against
//     `process.cwd()` only when no env is available (bare daemon,
//     unit tests). An explicit `cfg.spawner` overrides both for tests.
//
//   - AbortSignal is wired: ctx.signal abort → subprocess.kill() (Bun
//     fallback) or env.exec abort (production path).
//
//   - externalCall envelope wraps the spawn — shell is inherently
//     non-idempotent, but the intent / done facts let the startup sweep
//     quarantine a run whose daemon crashed mid-spawn.

import type { ToolNodeMessage } from "@swarm/types";
import { substitute } from "../../engine/substitution.ts";
import type { ContextMap } from "../../types/context.ts";
import type { ExecutionEnvironment } from "../../types/execution.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

export interface ToolConfig {
  /** Raw shell command; substituted at dispatch time. Required — an empty
   * tool_command is a workflow authoring error. */
  toolCommand: string;
  /** Next node on success (exit 0). When unset, defers to the executor's
   * edge selector (5-rule priority on unconditional outgoing edges). */
  nextNode?: string;
  /** Hard timeout. Defaults to 5 minutes — a shell step that needs more
   * should probably be broken up. */
  maxMs?: number;
  /** Optional ContextMap merged with routing when substituting
   * `${context.*}` tokens in the tool command. Prompt substitution
   * matches codergen's merge order: defaults first, routing overrides. */
  defaultContext?: ContextMap;
  /** Spawn function injection point for tests. Defaults to `runWithBun`. */
  spawner?: SpawnFn;
}

export interface ToolRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type SpawnFn = (cmd: string, signal: AbortSignal) => Promise<ToolRunResult>;

const DEFAULT_MAX_MS = 5 * 60 * 1000;

export function makeToolHandler(cfg: ToolConfig): HandlerSpec {
  const explicitSpawner = cfg.spawner;
  const maxMs = cfg.maxMs ?? DEFAULT_MAX_MS;

  const handler: Handler = async (ctx) => {
    const rawCommand = cfg.toolCommand;
    if (rawCommand.trim().length === 0) {
      return {
        kind: "halt",
        reason: "error",
        detail: "tool node has empty tool_command",
      } satisfies HandlerResult;
    }

    const context = mergeContext(cfg.defaultContext, ctx.routing);
    // Tool commands are shell strings. Substituted values can contain
    // whitespace, newlines, quotes, or anything else a previous node
    // legitimately captured into an artifact (an upstream `echo "$PR"`
    // for example produces `"9876\n"`). Without escapeForShell, that
    // trailing newline turns one statement into several when /bin/sh
    // re-tokenises the rendered command — every substitution becomes
    // an injection vector. Codergen prompts don't need this: prose
    // tolerates stray whitespace; shell does not.
    const command = substitute(rawCommand, {
      args: ctx.args,
      context,
      nodeOutputs: ctx.nodeOutputs,
      escapeForShell: true,
    });

    // cwd resolution: prefer the run's ExecutionEnvironment so concurrent
    // runs each see their own worktree; fall back to the daemon's process
    // cwd only when no env is wired (tests, bare-LocalEnv daemon).
    const cwd = ctx.env?.cwd() ?? process.cwd();

    // Per-(nodeId, kind) chunk index counters. Streamed to the UI as
    // `tool.output_chunk` observability events: arrival order is
    // preserved by the SSE channel, but the index lets a consumer
    // detect gaps if it joins mid-stream and reconcile against the
    // persisted `tool_node` message that lands on completion.
    let stdoutChunkIndex = 0;
    let stderrChunkIndex = 0;
    const onData = (chunk: string, kind: "stdout" | "stderr"): void => {
      if (chunk.length === 0) return;
      // Slice each onData call to fit comfortably under the 4KB
      // observability payload cap. `chunk` from a child-process pipe
      // can land at OS buffer boundaries (typically 16-64 KB), so we
      // can't trust it to be small. Slice at 3 KB to leave room for
      // routing fields (nodeId, iteration, kind, content_index, …).
      // The persisted `tool_node` message at completion still carries
      // a tail-truncated copy, so an SSE chunk that nevertheless
      // overflows (the store will write a truncation marker)
      // degrades gracefully — the operator just sees the missing tail
      // appear at completion.
      const SLICE_BYTES = 3 * 1024;
      for (let i = 0; i < chunk.length; i += SLICE_BYTES) {
        const piece = chunk.slice(i, i + SLICE_BYTES);
        const idx = kind === "stdout" ? stdoutChunkIndex++ : stderrChunkIndex++;
        ctx.emit("tool.output_chunk", { kind, delta: piece, content_index: idx });
      }
    };

    let ranResult: ToolRunResult | undefined;
    try {
      ranResult = await ctx.externalCall(
        { toolName: "tool.shell", args: { command, cwd }, attempt: ctx.iteration + 1 },
        () => runCommand(command, ctx.signal, ctx.env, explicitSpawner, maxMs, onData),
      );
    } catch (err) {
      if (isAbortError(err)) {
        return {
          kind: "halt",
          reason: "error",
          detail: "tool aborted",
        } satisfies HandlerResult;
      }
      return {
        kind: "halt",
        reason: "error",
        detail: `tool spawn failed: ${errorMessage(err)}`,
      } satisfies HandlerResult;
    }

    // Persist stdout/stderr as artifacts so downstream nodes can read
    // them via $nodeId.output.stdout / .stderr substitution. Shell output
    // is non-deterministic by nature (timestamps, pids, paths), so retries
    // within the same iteration legitimately produce different content —
    // pass `replace: true` so a quarantine-retry doesn't trip
    // ArtifactCollisionError.
    const stdoutArtifactKey = `${ctx.nodeId}:stdout`;
    ctx.artifacts.put(stdoutArtifactKey, ranResult.stdout, "text/plain", { replace: true });
    if (ranResult.stderr.length > 0) {
      ctx.artifacts.put(`${ctx.nodeId}:stderr`, ranResult.stderr, "text/plain", { replace: true });
    }
    // The bare `output` artifact is the contract the executor's nodeOutputs
    // fold reads via `outputRef` below; downstream `$<nodeId>.output`
    // resolves to stdout, the natural "what did the tool produce" default.
    const outputRef = ctx.artifacts.put("output", ranResult.stdout, "text/plain", { replace: true });

    // Append a `tool_node` message so the conversation view can render
    // the execution as a Terminal card without round-tripping to the
    // artifacts store. Inline stdout/stderr is tail-truncated; the
    // artifact is the source of truth for the full bytes.
    const stdoutTail = truncateTail(ranResult.stdout, INLINE_OUTPUT_BYTES);
    const stderrTail = truncateTail(ranResult.stderr, INLINE_OUTPUT_BYTES);
    const message: ToolNodeMessage = {
      role: "tool_node",
      command,
      cwd,
      exitCode: ranResult.exitCode,
      durationMs: ranResult.durationMs,
      stdout: stdoutTail.text,
      stderr: stderrTail.text,
      ...(stdoutTail.truncated ? { stdoutTruncated: true } : {}),
      ...(stderrTail.truncated ? { stderrTruncated: true } : {}),
      outputArtifactKey: stdoutArtifactKey,
      timestamp: Date.now(),
    };
    ctx.messages.append(message);

    ctx.emit("tool.completed", {
      command,
      cwd,
      exitCode: ranResult.exitCode,
      durationMs: ranResult.durationMs,
      stdoutBytes: ranResult.stdout.length,
      stderrBytes: ranResult.stderr.length,
    });

    const outcomeStatus: "success" | "fail" = ranResult.exitCode === 0 ? "success" : "fail";
    const result: HandlerResult = {
      kind: "transition",
      outcomeStatus,
      tokens: 0,
      costUsd: 0,
      outputRef,
      routingDelta: {
        [`tool.${ctx.nodeId}.exit_code`]: ranResult.exitCode,
      },
    };
    if (cfg.nextNode !== undefined) result.nextNode = cfg.nextNode;
    return result;
  };

  return {
    kind: "tool",
    sideEffect: "external",
    maxMs,
    handler,
  };
}

/** Inline cap for stdout/stderr stored on the `tool_node` message row.
 * Larger output is tail-truncated; the full bytes live in the artifact
 * keyed `${nodeId}:stdout` / `${nodeId}:stderr`. Matches the bash
 * agent-tool's `DEFAULT_MAX_BYTES` so the UI behaviour reads the same
 * regardless of which path produced the output. */
const INLINE_OUTPUT_BYTES = 50 * 1024;

function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) return { text, truncated: false };
  return { text: text.slice(text.length - maxBytes), truncated: true };
}

/** Dispatch resolution. Explicit `cfg.spawner` wins (test injection);
 * else `ctx.env.exec` (production worktree path; receives the
 * onData stream); else `runWithBun` against `process.cwd()`
 * (bare-daemon fallback, no streaming). */
async function runCommand(
  command: string,
  signal: AbortSignal,
  env: ExecutionEnvironment | undefined,
  spawner: SpawnFn | undefined,
  timeoutMs: number,
  onData?: (chunk: string, kind: "stdout" | "stderr") => void,
): Promise<ToolRunResult> {
  if (spawner) return spawner(command, signal);
  if (env) {
    const r = await env.exec(command, {
      signal,
      timeoutMs,
      ...(onData ? { onData } : {}),
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  }
  return runWithBun(command, signal);
}

function mergeContext(defaults: ContextMap | undefined, routing: Readonly<Record<string, unknown>>): ContextMap {
  const out: ContextMap = { ...(defaults ?? {}) };
  for (const [k, v] of Object.entries(routing)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v as ContextMap[string];
    }
  }
  return out;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) return err.name === "AbortError" || err.name === "TimeoutError";
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Default Bun-based spawner. Runs the command through `sh -c` so shell
 * expansions, pipes, and redirections work. Captures stdout + stderr
 * as UTF-8 text up to a soft cap (8 MiB combined); beyond that the
 * output is truncated with a `[swarm: truncated]` marker.
 */
export async function runWithBun(cmd: string, signal: AbortSignal): Promise<ToolRunResult> {
  const start = Date.now();
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const abortListener = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // subprocess already exited
    }
  };
  if (signal.aborted) abortListener();
  else signal.addEventListener("abort", abortListener, { once: true });

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      readStream(proc.stdout),
      readStream(proc.stderr),
      proc.exited,
    ]);
    return {
      exitCode: typeof exitCode === "number" ? exitCode : -1,
      stdout: stdoutText,
      stderr: stderrText,
      durationMs: Date.now() - start,
    };
  } finally {
    signal.removeEventListener("abort", abortListener);
  }
}

const SOFT_CAP_BYTES = 8 * 1024 * 1024;

async function readStream(stream: ReadableStream<Uint8Array> | number): Promise<string> {
  if (typeof stream === "number") return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total >= SOFT_CAP_BYTES) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new TextDecoder().decode(concat(chunks));
  if (total >= SOFT_CAP_BYTES) return `${joined.slice(0, SOFT_CAP_BYTES)}\n[swarm: truncated]\n`;
  return joined;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
