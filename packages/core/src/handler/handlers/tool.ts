// tool handler — graph-level shell step (SPEC §3.1 `tool`).
//
// A `tool` node runs `node.attrs.tool_command` as a single shell
// invocation — no LLM, no agent loop. Side-effect only: exit 0 →
// `outcome=success`; non-zero → `outcome=fail`. The command may
// substitute `${{ inputs.x }}`. Tool nodes do not feed data forward to
// downstream nodes — that's the llm's job, not a deterministic
// shell step.
//
// Distinct from agent-callable tools (read / write / edit / bash) that an
// LLM invokes inside a llm turn. Those live in the ToolRegistry the
// pi-agent backend passes to each call; the ToolRegistry is untouched
// here.
//
// Design choices:
//
//   - Stdout + stderr are captured as artifacts keyed by `${nodeId}:stdout`
//     / `${nodeId}:stderr` for debugging / replay; a `tool_node`-role
//     message row is also appended to `messages` carrying the command,
//     cwd, exit code, and a tail-truncated stdout/stderr — that's what
//     RunConversation reads.
//
//   - Execution routes through `ctx.env.exec(...)` when an
//     `ExecutionEnvironment` is wired (production; isolates per-run
//     cwd to the worktree, and inherits the env adapter's blocklist
//     and abort/timeout behaviour). An explicit `cfg.spawner`
//     overrides for tests. A dispatch reaching the handler with
//     `ctx.env === undefined` AND no `cfg.spawner` halts immediately
//     — silently spawning against `process.cwd()` is the worktree-leak
//     vector that motivated the env-required contract.
//
//   - AbortSignal is wired: ctx.signal abort → subprocess.kill() (Bun
//     fallback) or env.exec abort (production path).
//
//   - externalCall envelope wraps the spawn — shell is inherently
//     non-idempotent, but the intent / done facts let the startup sweep
//     quarantine a run whose daemon crashed mid-spawn.

import type { ToolNodeMessage } from "@fragua/types";
import { UnpopulatedOutputError } from "../../engine/outputs-substitution.ts";
import { substitute } from "../../engine/substitution.ts";
import { DEFAULT_TOOL_MAX_MS } from "../../parser/yaml.ts";
import type { ExecutionEnvironment, ScratchFile } from "../../types/execution.ts";
import type { OutputsDecl, OutputsValue } from "../../types/outputs.ts";
import { validateOutputsValue } from "../../types/outputs.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

/** Read-back cap for the `$FRAGUA_OUTPUT` channel, and the source of truth for
 *  the stdout `SOFT_CAP_BYTES` below — comfortably above any struct that
 *  legitimately spills to the blob CAS. An oversized emission is a per-node
 *  failure. The two were independent literals tied only by a comment, so
 *  raising the stdout cap for large scripts would silently have left the
 *  read-back cap behind and rejected an emission whose stdout was captured. */
export const FRAGUA_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

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
  /** Spawn function injection point for tests. Defaults to `runWithBun`. */
  spawner?: SpawnFn;
  /** Typed output declaration when this tool produces a struct forward via
   * `$FRAGUA_OUTPUT`. When set, the handler allocates a scratch file, hands its
   * path to the process, reads it back after a clean exit, validates it with
   * `validateOutputsValue`, and attaches it to `result.outputs`. A declared
   * `outputs:` the process never leaves as a valid struct fails the node. */
  outputs?: OutputsDecl;
}

export interface ToolRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export type SpawnFn = (cmd: string, signal: AbortSignal) => Promise<ToolRunResult>;

export function makeToolHandler(cfg: ToolConfig): HandlerSpec {
  const explicitSpawner = cfg.spawner;
  const maxMs = cfg.maxMs ?? DEFAULT_TOOL_MAX_MS;

  const handler: Handler = async (ctx) => {
    const rawCommand = cfg.toolCommand;
    if (rawCommand.trim().length === 0) {
      return {
        kind: "halt",
        reason: "error",
        detail: "tool node has empty tool_command",
      } satisfies HandlerResult;
    }

    // Tool commands are shell strings. A `${{ inputs.x }}` value may
    // contain whitespace, newlines, quotes, or anything else the run's
    // input legitimately carries. Without escapeForShell, a trailing
    // newline turns one statement into several when /bin/sh re-tokenises
    // the rendered command — every substitution becomes an injection
    // vector. Llm prompts don't need this: prose tolerates stray
    // whitespace; shell does not.
    // An unpopulated `${{ outputs.X.f }}` read FAILS CLOSED as a node `fail`
    // (routes via fail-edge / aborted_exit), never an uncaught throw the
    // executor would turn into a fatal `reason:"error"` halt.
    let command: string;
    try {
      command = substitute(rawCommand, {
        args: ctx.args,
        escapeForShell: true,
      });
    } catch (err) {
      if (err instanceof UnpopulatedOutputError) {
        return { kind: "transition", outcomeStatus: "fail", failureReason: err.message, tokens: 0, costUsd: 0 };
      }
      throw err;
    }

    // cwd resolution: every production dispatch MUST carry `ctx.env`
    // — the executor wires the run-scoped `ExecutionEnvironment` onto
    // the HandlerContext so concurrent runs each see their own
    // worktree. The only legitimate path to a missing env is a test
    // that supplies an explicit `cfg.spawner` (which bypasses cwd
    // entirely). Anything else halts: a silent `process.cwd()`
    // fallback would let a tool node leak edits to the daemon's pwd
    // (the exact same-cwd worktree-isolation regression that motivated
    // this contract).
    if (ctx.env === undefined && explicitSpawner === undefined) {
      return {
        kind: "halt",
        reason: "error",
        detail:
          "tool handler: no execution environment wired (this is a bug — every dispatch must carry ctx.env or cfg.spawner)",
      } satisfies HandlerResult;
    }
    const cwd = ctx.env?.cwd() ?? "";

    // Producing tool: allocate the `$FRAGUA_OUTPUT` scratch file before the
    // spawn. The capability is optional on `ExecutionEnvironment`; a tool that
    // declares `outputs:` but runs in an env without it (a bare spawner test,
    // a read-only env) fails closed rather than silently producing nothing.
    const producesOutputs = cfg.outputs !== undefined;
    let scratch: ScratchFile | undefined;
    if (producesOutputs) {
      if (ctx.env?.createScratchFile === undefined) {
        return {
          kind: "transition",
          outcomeStatus: "fail",
          failureReason:
            "producer.invalid_emission: tool declares `outputs:` but its execution environment has no $FRAGUA_OUTPUT channel",
          tokens: 0,
          costUsd: 0,
        } satisfies HandlerResult;
      }
      scratch = await ctx.env.createScratchFile({ runId: ctx.runId, nodeId: ctx.nodeId, iteration: ctx.iteration });
    }

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

    try {
      let ranResult: ToolRunResult | undefined;
      try {
        ranResult = await ctx.externalCall(
          { toolName: "tool.shell", args: { command, cwd }, attempt: ctx.iteration + 1 },
          () => runCommand(command, ctx.signal, ctx.env, explicitSpawner, maxMs, onData, scratch?.path),
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

      // Persist stdout/stderr as artifacts for debugging / replay. Shell
      // output is non-deterministic by nature (timestamps, pids, paths),
      // so retries within the same iteration legitimately produce
      // different content — pass `replace: true` so a quarantine-retry
      // doesn't trip ArtifactCollisionError.
      const stdoutArtifactKey = `${ctx.nodeId}:stdout`;
      ctx.artifacts.put(stdoutArtifactKey, ranResult.stdout, "text/plain", { replace: true });
      if (ranResult.stderr.length > 0) {
        ctx.artifacts.put(`${ctx.nodeId}:stderr`, ranResult.stderr, "text/plain", { replace: true });
      }

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
      // A producing node's message is held back until the read-back below, so
      // the emitted struct can ride on it. Every exit path appends exactly
      // once — including the fail-closed ones, where the terminal output is
      // the whole diagnosis of why the emission was rejected.
      let messageAppended = false;
      const appendToolMessage = (outputs?: OutputsValue): void => {
        if (messageAppended) return;
        messageAppended = true;
        if (outputs !== undefined) message.outputs = outputs as Record<string, unknown>;
        ctx.messages.append(message);
      };
      if (!producesOutputs) appendToolMessage();

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
      };
      // A failing tool step's last line of output is the reason an operator
      // wants on the halt banner — not just "failed with no fail route".
      if (outcomeStatus === "fail") {
        result.failureReason =
          `exit ${ranResult.exitCode}: ${lastLine(ranResult.stderr) ?? lastLine(ranResult.stdout) ?? "no output"}`.slice(
            0,
            400,
          );
      }

      // Producer read-back: a tool that declared `outputs:` and exited 0 must
      // leave a valid struct on `$FRAGUA_OUTPUT`. Absent / renamed-over /
      // oversized / unparseable / schema-invalid is a NODE failure (fails closed
      // here), never a silent empty struct that resurfaces as a distant
      // `UnpopulatedOutputError` at a consumer. Only a clean exit is read.
      if (producesOutputs && outcomeStatus === "success" && scratch !== undefined && cfg.outputs !== undefined) {
        const failClosed = (reason: string): HandlerResult => {
          appendToolMessage();
          return {
            kind: "transition",
            outcomeStatus: "fail",
            failureReason: reason.slice(0, 400),
            tokens: 0,
            costUsd: 0,
          };
        };
        let readResult: Awaited<ReturnType<ScratchFile["read"]>>;
        try {
          readResult = await scratch.read(FRAGUA_OUTPUT_MAX_BYTES, ctx.signal);
        } catch (err) {
          // Discriminate a mid-read cancel from an I/O fault: an abort must land
          // terminally (a halt), never be swallowed into a transition-fail that
          // lets the run advance past the cancel.
          if (isAbortError(err)) {
            // Append before halting, like every other post-spawn return. The
            // command ran; without the row the conversation shows a gap where
            // the node was, and the stdout/stderr artifacts on disk have
            // nothing linking them to a command and a cwd.
            appendToolMessage();
            return { kind: "halt", reason: "error", detail: "tool aborted" } satisfies HandlerResult;
          }
          return failClosed(`producer.invalid_emission: reading $FRAGUA_OUTPUT failed: ${errorMessage(err)}`);
        }
        if (readResult.kind === "absent") {
          return failClosed("producer.no_emission: tool exited 0 but wrote no $FRAGUA_OUTPUT");
        }
        if (readResult.kind === "renamed") {
          return failClosed(
            'producer.rename_not_supported: $FRAGUA_OUTPUT was replaced (inode changed) — write in place with `command > "$FRAGUA_OUTPUT"`; do not rm, mv onto, or symlink it',
          );
        }
        if (readResult.kind === "oversize") {
          return failClosed(`producer.invalid_emission: $FRAGUA_OUTPUT exceeds ${FRAGUA_OUTPUT_MAX_BYTES} bytes`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(readResult.text);
        } catch {
          return failClosed("producer.invalid_emission: $FRAGUA_OUTPUT is not valid JSON");
        }
        const valErr = validateOutputsValue(cfg.outputs, parsed);
        if (valErr !== null) {
          return failClosed(`producer.invalid_emission: ${valErr}`);
        }
        result.outputs = parsed as OutputsValue;
        appendToolMessage(result.outputs);
      }
      // A producing node that failed its exit code never reached the read-back.
      appendToolMessage();

      if (cfg.nextNode !== undefined) result.nextNode = cfg.nextNode;
      return result;
    } finally {
      if (scratch !== undefined) await scratch.dispose();
    }
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

function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (text.length <= maxBytes) return { text, truncated: false };
  return { text: text.slice(text.length - maxBytes), truncated: true };
}

/** Dispatch resolution. Explicit `cfg.spawner` wins (test injection);
 * else `ctx.env.exec` (production worktree path; receives the
 * onData stream). No `process.cwd()` fallback — the top-of-handler
 * guard rejects an env-less dispatch before this function is called.
 * `runWithBun` remains exported as a turnkey `SpawnFn` for tests
 * that want a real subprocess without standing up an env. */
async function runCommand(
  command: string,
  signal: AbortSignal,
  env: ExecutionEnvironment | undefined,
  spawner: SpawnFn | undefined,
  timeoutMs: number,
  onData?: (chunk: string, kind: "stdout" | "stderr") => void,
  outputPath?: string,
): Promise<ToolRunResult> {
  if (spawner) return spawner(command, signal);
  if (env) {
    const r = await env.exec(command, {
      signal,
      timeoutMs,
      ...(onData ? { onData } : {}),
      ...(outputPath ? { env: { FRAGUA_OUTPUT: outputPath } } : {}),
    });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs };
  }
  throw new Error("tool handler: unreachable — env-less dispatch without spawner should have halted earlier");
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
 * output is truncated with a `[fragua: truncated]` marker.
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

const SOFT_CAP_BYTES = FRAGUA_OUTPUT_MAX_BYTES;

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
  if (total >= SOFT_CAP_BYTES) return `${joined.slice(0, SOFT_CAP_BYTES)}\n[fragua: truncated]\n`;
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
