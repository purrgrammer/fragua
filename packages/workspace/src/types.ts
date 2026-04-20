// Tool primitives for swarm. The ExecutionEnvironment contract now
// lives in @swarm/core (see `types/execution.ts`) so HandlerContext
// can carry an env without inducing a core→workspace dependency. We
// re-export the types here for legacy import paths.
// See docs/SPEC.md §3.4.

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

/** Swarm tool definition. Namespaced names (e.g. `local:read_file`) prevent
 * collisions across adapters (MCP, Claude skills, user-defined). */
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
  /** Execute the tool. Receives validated args + execution env. */
  execute(args: TArgs, env: ExecutionEnvironment): Promise<ToolOutput<TResult>>;
}

export interface ToolOutput<TResult = ContextValue> {
  /** Stringified payload for the LLM (post-truncation happens separately). */
  text: string;
  /** Optional structured payload preserved for downstream nodes via $nodeId.output.path. */
  data?: TResult;
  /** True when the tool failed (still returned to the LLM so it can retry). */
  is_error?: boolean;
}

/** Tool registry. Tool names are bare identifiers (no namespace prefix)
 * under the trimmed four-tool surface — the graph-level `tool` node is
 * a separate primitive, so the namespace distinction is structural and
 * no longer carried in the tool name. Custom tools loaded from
 * `.swarm/tools/*.ts` land here via `register()` alongside the core four. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
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

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** Filter by a node's allowed_tools / denied_tools attributes. */
  select(opts: { allow?: string[]; deny?: string[] } = {}): Tool[] {
    return this.list().filter((t) => {
      if (opts.deny?.includes(t.name)) return false;
      if (opts.allow && !opts.allow.includes(t.name)) return false;
      return true;
    });
  }
}
