// Tool primitives for fragua. The ExecutionEnvironment contract now
// lives in @fragua/core (see `types/execution.ts`) so HandlerContext
// can carry an env without inducing a core→workspace dependency. We
// re-export the types here for legacy import paths.
// See docs/SPEC.md §3.4.

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  ContextValue,
  DirEntry,
  ExecResult,
  ExecutionEnvironment,
  SummariseInput,
  SummariseOutput,
} from "@fragua/core";
import type { HttpClient } from "@fragua/core/handler";
import type { Skill } from "@fragua/types";
import type { TSchema } from "@sinclair/typebox";

export type { DirEntry, ExecResult, ExecutionEnvironment };

/** Per-call fragua context passed through `ToolExecuteOptions.fraguaContext`.
 *  Built-in I/O tools (read / write / edit / bash) ignore this field —
 *  they run off `env` alone. The `skill` tool reads `skillCatalog` to
 *  resolve a skill name to its loaded definition. */
export interface FraguaToolContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly http: HttpClient;
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
  readonly summarise?: (input: SummariseInput) => Promise<SummariseOutput>;
  /** The run's resolved skill catalog. The `skill` tool resolves its
   *  `name` argument against this set. */
  readonly skillCatalog?: readonly Skill[];
}

/** Per-tool truncation policy (applied before the value goes to the LLM). */
export interface TruncationPolicy {
  /** Character cap — always applied first (prevents single-line payloads). */
  max_chars: number;
  /** How to trim: keep both ends (useful for file content) or just the tail (useful for shell). */
  mode: "head_tail" | "tail";
  /** Optional secondary line cap applied after character truncation. */
  max_lines?: number;
}

/** Per-call options the host can pass to a tool. Fields are optional
 * so adapters that don't care can ignore them; tools that do
 * (long-running bash, abortable network calls, streaming progress)
 * read what they need off the third argument. Mirrors
 * `AgentTool.execute`'s signal/onUpdate plumbing in pi-agent-core, plus
 * a fragua-specific `fraguaContext` slot. */
export interface ToolExecuteOptions<TResult = ContextValue> {
  /** Cancellation signal. Tools should clean up promptly when fired. */
  signal?: AbortSignal;
  /** Streaming progress callback. Tools that produce incremental
   * output (bash, long curls) call this with partial `ToolOutput`s
   * during execution; consumers can render a live preview. */
  onUpdate?: (partial: ToolOutput<TResult>) => void;
  /** Fragua-side run context. Read by the `skill` tool; ignored by
   * built-in I/O tools. */
  fraguaContext?: FraguaToolContext;
  /** Pi-agent-core tool-call id (e.g. `toolu_01ABC…`). Available to
   * tools that need to correlate their result with the originating
   * call; most ignore it. */
  tool_call_id?: string;
}

/** Fragua tool definition. Names are bare identifiers — namespace
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
  /** When true, the rehydrate sanitiser (`sanitiseUnpairedToolCalls`)
   *  re-executes this tool to repair an unpaired toolCall left by a
   *  daemon crash mid-execution. Default false. Only set on tools
   *  with no observable side effect on the working tree (pure reads:
   *  read / grep / find / ls). The safe default surfaces an error
   *  toolResult to the LLM instead of silently re-running a
   *  potentially destructive operation — the LLM decides whether to
   *  retry. */
  idempotentOnReplay?: boolean;
  /** Truncation applied to the stringified result before it reaches the LLM. */
  truncation: TruncationPolicy;
  /** Optional compatibility shim for raw tool-call arguments before
   * schema validation. Used to recover from common provider quirks
   * (e.g. Opus 4.6 / GLM-5.1 sending `edits` as a JSON string instead
   * of an array, legacy `{oldText, newText}` flat shape on edit). */
  prepareArguments?: (input: unknown) => TArgs;
  /** When true, the tool is excluded from the catch-all "all tools"
   * set that nodes get when they don't specify `allowed_tools`. The
   * tool only surfaces when a node explicitly names it. Used by
   * non-trivial side-effecting tools (web_fetch, future credential
   * holders) so they don't silently leak into every llm node. */
  defaultDisabled?: boolean;
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
  /** Hint that the agent loop should stop after the current tool batch.
   * Forwarded to pi-agent-core's `AgentToolResult.terminate`; the loop
   * only terminates when every result in the batch sets it. Used by the
   * built-in `abort` tool. */
  terminate?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: registry stores tools with diverse arg/result shapes.
export type AnyTool = Tool<any, any>;

/** Tool registry. Tool names are bare identifiers (lowercase, alphanumeric +
 * underscore, starting with a letter). The graph-level `tool` node is a
 * separate primitive — namespace distinction is structural, not encoded
 * in the name. The map stores `AnyTool` so a tool typed as
 * `Tool<{path:string}, ReadResultData>` can sit next to a tool typed as
 * `Tool<{command:string}, BashResultData>` — TypeScript can't infer a
 * useful upper bound across heterogeneous result types. */
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

  /** Filter by a node's allowed_tools / denied_tools attributes.
   *
   * When `allow` is set, it's a pure allowlist — only tools whose
   * names are in `allow` survive (`defaultDisabled` is bypassed,
   * because the node opted in by name).
   *
   * When `allow` is unset, the node accepts the catch-all "all tools"
   * set, MINUS:
   *   - anything in `deny`,
   *   - any tool with `defaultDisabled: true`.
   *
   * The `defaultDisabled` carve-out is the opt-in mechanism for tools
   * that shouldn't leak into every node by default (e.g. `web_fetch`
   * makes outbound HTTP and burns summariser tokens — workflows that
   * want it must list it explicitly). */
  select(opts: { allow?: string[]; deny?: string[] } = {}): AnyTool[] {
    return this.list().filter((t) => {
      if (opts.deny?.includes(t.name)) return false;
      if (opts.allow) return opts.allow.includes(t.name);
      if (t.defaultDisabled) return false;
      return true;
    });
  }
}
