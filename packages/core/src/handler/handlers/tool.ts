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
//     machinery codergen uses ($ARGUMENTS, $RUN_ID, $nodeId.output,
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
//     against them through the normal substitution path.
//
//   - The command runs via Bun.spawn with cwd = process.cwd(). Once
//     worktree provisioning lands (task #16) this will flip to the run's
//     worktree path.
//
//   - AbortSignal is wired: ctx.signal abort → subprocess.kill().
//
//   - externalCall envelope wraps the spawn — shell is inherently
//     non-idempotent, but the intent / done facts let the startup sweep
//     quarantine a run whose daemon crashed mid-spawn.

import { sha256Hex } from "@swarm/store";
import { substitute } from "../../engine/substitution.ts";
import type { ContextMap } from "../../types/context.ts";
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
  const spawner = cfg.spawner ?? runWithBun;

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
    const command = substitute(rawCommand, { args: ctx.args, context });

    const argsHash = sha256Hex(command);

    let ranResult: ToolRunResult | undefined;
    try {
      ranResult = await ctx.externalCall({ toolName: "tool.shell", argsHash, attempt: ctx.iteration + 1 }, () =>
        spawner(command, ctx.signal),
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
    // them via $nodeId.output.stdout / .stderr substitution.
    ctx.artifacts.put(`${ctx.nodeId}:stdout`, ranResult.stdout, "text/plain");
    if (ranResult.stderr.length > 0) {
      ctx.artifacts.put(`${ctx.nodeId}:stderr`, ranResult.stderr, "text/plain");
    }

    ctx.emit("tool.completed", {
      command,
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
    maxMs: cfg.maxMs ?? DEFAULT_MAX_MS,
    handler,
  };
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
