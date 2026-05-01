// Tool primitives for swarm. The ExecutionEnvironment contract now
// lives in @swarm/core (see `types/execution.ts`) so HandlerContext
// can carry an env without inducing a core→workspace dependency. We
// re-export the types here for legacy import paths.
// See docs/SPEC.md §3.4.

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type { ContextValue, DirEntry, ExecResult, ExecutionEnvironment } from "@swarm/core";

export type { DirEntry, ExecResult, ExecutionEnvironment };

/** Per-tool truncation policy (applied before the value goes to the LLM). */
export interface TruncationPolicy {
  /** Character cap — always applied first (prevents single-line payloads). */
  max_chars: number;
  /** How to trim: keep both ends (useful for file content) or just the tail (useful for shell). */
  mode: "head_tail" | "tail";
  /** Optional secondary line cap applied after character truncation. */
  max_lines?: number;
}

/** Per-call options the host can pass to a tool. Both fields are
 * optional so adapters that don't care can ignore them; tools that do
 * (long-running bash, abortable network calls, streaming progress)
 * read them off the third argument. Mirrors `AgentTool.execute`'s
 * signal/onUpdate plumbing in pi-agent-core. */
export interface ToolExecuteOptions<TResult = ContextValue> {
  /** Cancellation signal. Tools should clean up promptly when fired. */
  signal?: AbortSignal;
  /** Streaming progress callback. Tools that produce incremental
   * output (bash, long curls) call this with partial `ToolOutput`s
   * during execution; consumers can render a live preview. */
  onUpdate?: (partial: ToolOutput<TResult>) => void;
}

/** Swarm tool definition. Names are bare identifiers — namespace
 * collisions are prevented by the registry rather than encoded in the
 * name. */
export interface Tool<TArgs = unknown, TResult = ContextValue> {
  name: string;
  description: string;
  /** TypeBox schema for argument validation. */
  parameters: TSchema;
  /** Does running this tool twice with the same args have the same effect?
   * Non-idempotent tools require human approval on resume from a dangling call. */
  idempotent: boolean;
  /** Truncation applied to the stringified result before it reaches the LLM. */
  truncation: TruncationPolicy;
  /** Optional compatibility shim for raw tool-call arguments before
   * schema validation. Used to recover from common provider quirks
   * (e.g. Opus 4.6 / GLM-5.1 sending `edits` as a JSON string instead
   * of an array, legacy `{oldText, newText}` flat shape on edit). */
  prepareArguments?: (input: unknown) => TArgs;
  /** Execute the tool. Receives validated args, the execution env,
   * and optional per-call options (signal / onUpdate). */
  execute(args: TArgs, env: ExecutionEnvironment, opts?: ToolExecuteOptions<TResult>): Promise<ToolOutput<TResult>>;
}

export interface ToolOutput<TResult = ContextValue> {
  /** Stringified payload for the LLM (post-truncation happens separately).
   * Required for backwards compatibility — when `content` is present, callers
   * should prefer it; `text` is then a plain-text fallback for renderers
   * that can't handle multi-modal blocks. */
  text: string;
  /** Optional rich content array — text + image blocks. When present,
   * the agent loop forwards this verbatim instead of wrapping `text`
   * in a single TextContent block. Tools that need to embed images
   * (read on a screenshot, future browser/screenshot tools) populate
   * this. Truncation only applies to text blocks. */
  content?: (TextContent | ImageContent)[];
  /** Optional structured payload preserved for downstream nodes via $nodeId.output.path. */
  data?: TResult;
  /** True when the tool failed (still returned to the LLM so it can retry). */
  is_error?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores tools with diverse arg/result shapes.
export type AnyTool = Tool<any, any>;

/** Tool registry. Tool names are bare identifiers (lowercase, alphanumeric +
 * underscore, starting with a letter). The graph-level `tool` node is a
 * separate primitive — namespace distinction is structural, not encoded
 * in the name. Custom tools loaded from `.swarm/tools/*.ts` land here via
 * `register()` alongside the core four. The map stores `AnyTool` so a
 * tool typed as `Tool<{path:string}, ReadResultData>` can sit next to a
 * tool typed as `Tool<{command:string}, BashResultData>` — TypeScript
 * can't infer a useful upper bound across heterogeneous result types. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(
        `tool "${tool.name}" must be a bare identifier (lowercase, alphanumeric + underscore, starting with a letter)`,
      );
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: AnyTool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Filter by a node's allowed_tools / denied_tools attributes. */
  select(opts: { allow?: string[]; deny?: string[] } = {}): AnyTool[] {
    return this.list().filter((t) => {
      if (opts.deny?.includes(t.name)) return false;
      if (opts.allow && !opts.allow.includes(t.name)) return false;
      return true;
    });
  }
}
