// Public type API for swarm tool extensions. Loaded by user code in
// `~/.swarm/extensions/*.ts` and `<cwd>/.swarm/extensions/*.ts`.
//
// The runtime loader (discover + adapter) lives in `@swarm/workspace`;
// keeping the type surface in its own package means extension authors
// don't pull in our internals.
//
// Mirrors pi-coding-agent's `registerTool` shape verbatim — same fields,
// same execute signature, same result shape — modulo two swarm-specific
// adjustments:
//   1. `ctx` is swarm-flavored (cwd / runId / nodeId / iteration / signal /
//      http / env / emit / summarise) — pi's UI/session/compaction
//      primitives don't apply here.
//   2. `renderText?` is a daemon-evaluated markdown fallback, used for
//      log lines and as the web fallback when no paired `*.web.tsx` is
//      shipped. No pi analog.
//
// See docs/proposals/extensions-tools.md.

import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";
import type { ExecutionEnvironment, SummariseInput, SummariseOutput } from "@swarm/core";
import type { HttpClient } from "@swarm/core/handler";

export type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
export type { ImageContent, TextContent } from "@mariozechner/pi-ai";

/** Context handed to a tool's `execute` (and to hook handlers in the
 *  sibling proposal). Swarm-flavored — pi's TUI / session / compaction
 *  primitives are deliberately absent. */
export interface ExtensionContext {
  /** Working directory of the run. Worktree path when a provisioner is
   *  active, the project cwd otherwise. */
  readonly cwd: string;
  readonly runId: string;
  readonly nodeId: string;
  /** Per-node re-entry counter (attractor retry semantics). */
  readonly iteration: number;
  /** The current run's AbortSignal. Same instance also passed positionally
   *  as `signal` to `execute`; exposed on ctx for symmetry with hooks. */
  readonly signal: AbortSignal;

  /** HTTP client routed through swarm's wiring (no bare fetch in extension
   *  code per AGENTS.md ground rule #9). */
  readonly http: HttpClient;

  /** Filesystem + shell environment scoped to the run's worktree. */
  readonly env: ExecutionEnvironment;

  /** Emit observability events. Same surface handler authors use. */
  readonly emit: (type: string, payload: Record<string, unknown>) => void;

  /** Configured summariser, when one is wired to the daemon. Undefined
   *  when running with `--llm-provider stub` or against a provider with
   *  no default summariser model. Tools that need summarisation should
   *  fall back gracefully when this is undefined. */
  readonly summarise?: (input: SummariseInput) => Promise<SummariseOutput>;
}

/** Pi-verbatim tool descriptor (modulo TUI render fields, which swarm
 *  reshapes — see proposal). */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
  /** Tool name as the LLM sees it (used in `tool_use`). Bare identifier
   *  (lowercase / digits / underscore, leading letter). Collisions with
   *  built-ins or other extensions throw at registration. */
  name: string;
  /** Human-readable label. Used by ai-elements `<ToolHeader>` when no
   *  paired `*.web.tsx` overrides it. */
  label: string;
  /** Description for the LLM. Lands verbatim in the tool schema. */
  description: string;
  /** TypeBox schema for tool-call arguments. */
  parameters: TParams;

  /** Optional one-line snippet for the Available-tools section in the
   *  default system prompt. Tools without this are omitted from the
   *  catalogue (mirrors pi). */
  promptSnippet?: string;

  /** Optional guideline bullets appended to the system prompt's
   *  Guidelines section when this tool is active. */
  promptGuidelines?: string[];

  /** Optional shim that runs before TypeBox validation. Used to recover
   *  from common provider quirks (e.g. JSON-stringified arrays). */
  prepareArguments?: (args: unknown) => Static<TParams>;

  /** Daemon-evaluated markdown renderer used for log lines, CLI feed
   *  output, and the web fallback when no paired `<name>.web.tsx`
   *  exists. Pure function — no React, no pi-tui. Returning undefined
   *  falls through to the host's ai-elements default rendering of the
   *  raw `result.content[0].text`. */
  renderText?(result: AgentToolResult<TDetails>, opts: { isPartial: boolean }): string | undefined;

  /** Execute the tool. Throws on hard failure; encode user-visible
   *  errors as `isError: true` content blocks. */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
}

/** API the extension factory receives. v0 only exposes `registerTool`;
 *  hooks come from the sibling proposal. */
export interface SwarmAPI {
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
}

/** Type-inference helper. Returns its argument unchanged — same shape as
 *  pi's `defineTool`. Use it when assigning a tool to a variable so
 *  TypeScript doesn't widen `parameters` to `unknown`. */
export function defineTool<TParams extends TSchema = TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool;
}

/** Factory shape the runtime loader expects. Default-export from the
 *  extension's `index.ts` (or `*.ts` flat file). */
export type ExtensionFactory = (sw: SwarmAPI) => void | Promise<void>;

// Re-export TextContent / ImageContent / TSchema-related shapes for
// authors who want concrete types in their tool definitions.
export type { Static, TSchema } from "@sinclair/typebox";
