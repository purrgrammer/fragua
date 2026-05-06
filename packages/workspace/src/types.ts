// Tool primitives for swarm. The ExecutionEnvironment contract now
// lives in @swarm/core (see `types/execution.ts`) so HandlerContext
// can carry an env without inducing a core→workspace dependency. We
// re-export the types here for legacy import paths.
// See docs/SPEC.md §3.4.

import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type {
  ContextValue,
  DirEntry,
  ExecResult,
  ExecutionEnvironment,
  SummariseInput,
  SummariseOutput,
} from "@swarm/core";
import type { HttpClient } from "@swarm/core/handler";
import type { AgentDefinition, Skill } from "@swarm/types";

export type { DirEntry, ExecResult, ExecutionEnvironment };

/** Per-call swarm context passed to extension tools through
 *  `ToolExecuteOptions.swarmContext`. Built-in tools (read / write /
 *  edit / bash) ignore this field — they run off `env` alone.
 *  Loader-wrapped extension tools require it to construct their
 *  `ExtensionContext`. The `agent` tool reads `spawnSubagent` +
 *  `skillCatalog` to drive sub-agent runs. */
export interface SwarmToolContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly http: HttpClient;
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
  readonly summarise?: (input: SummariseInput) => Promise<SummariseOutput>;
  /** Spawn a sub-agent run from inside a codergen turn. Wired by the
   *  daemon (per call) when the parent node's tool pool includes
   *  `agent`. Absent in tests / extension hosts that don't drive
   *  sub-agents. */
  readonly spawnSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>;
  /** Parent's resolved skill catalog. The `agent` tool's `spec.skills`
   *  is filtered against this set; sub-agents never see a skill the
   *  parent didn't load. */
  readonly skillCatalog?: readonly Skill[];
  /** Parent's resolved agent-definition catalogue (project + user
   *  scopes merged). The `agent` tool resolves its `agent: <name>`
   *  argument against this set. Absent in tests / extension hosts
   *  that don't drive sub-agents. */
  readonly agentCatalog?: readonly AgentDefinition[];
}

/** Inputs the `agent` tool hands to `spawnSubagent`. Mirrors the
 *  tool's TypeBox schema, plus a per-call `signal` so cancellation
 *  propagates from the parent dispatch into the child run. */
export interface SubagentSpec {
  /** Optional short name for this sub-agent (e.g. "reviewer",
   *  "haiku-poet"). Surfaced in the UI as `Agent · <name>` and on
   *  the `subagent.start` payload for trace navigation. */
  name?: string;
  /** The only context the sub-agent sees — the LLM constructs it. */
  prompt: string;
  /** Optional per-call system prompt for the sub-agent. When omitted,
   *  the codergen backend builds a fresh minimal system prompt for
   *  the sub-agent's own tool pool — the parent's *assembled* system
   *  prompt is NOT inherited (it would carry tools the sub-agent
   *  can't use and 10s of KB of irrelevant framing). The framework
   *  protocol is always layered on automatically. */
  system_prompt?: string;
  /** Allowlist for the child's tool pool. Defaults to the parent's
   *  effective pool minus `agent` (no nesting). */
  allowed_tools?: readonly string[];
  /** Denylist applied after the allowlist. */
  disallowed_tools?: readonly string[];
  /** Skill names; resolved against the parent's catalog. Sub-agents
   *  never inherit the parent's loaded skills implicitly. */
  skills?: readonly string[];
  /** Hard cap on agent loop iterations; defaults to the parent's
   *  remaining budget. */
  max_iterations?: number;
  /** Forwarded from the calling tool's `ToolExecuteOptions.signal` so
   *  parent cancellation propagates as `intent.cancel_requested` on
   *  the child run. */
  signal?: AbortSignal;
  /** Resolved profile name when the parent invoked
   *  `agent({ agent: <name>, … })`. Stamped onto `subagent.start.name`
   *  by the daemon so traces / UI can group spawns by profile.
   *  Distinct from `name` (a free-form short label). */
  agentName?: string;
  /** Optional model override. When set (typically from a profile's
   *  `model:` frontmatter), the synthesised child node carries this
   *  as `llm_model` instead of inheriting the parent's. */
  model?: string;
  /** Optional provider override. When set (typically from a profile's
   *  `provider:` frontmatter), the synthesised child node carries this
   *  as `llm_provider` instead of inheriting the parent's. */
  provider?: string;
  /** Pi-agent-core tool-call id of the parent's `agent` invocation
   *  (e.g. `toolu_01ABC…`). Stamped onto `subagent.start.tool_call_id`
   *  so the web UI can link a parent toolCall card to its in-flight
   *  sub-agent before the toolResult — which carries the canonical
   *  link in `details.data.subagent_id` — has landed. Optional so
   *  test harnesses that synthesise specs by hand still work. */
  tool_call_id?: string;
}

/** What `spawnSubagent` returns to the `agent` tool. The tool packs
 *  this into its `ToolOutput.{text, data}` shape for the parent LLM.
 *  A sub-agent isn't a run — it has no `run_id` of its own. The
 *  `subagentId` is a per-spawn ULID/UUID stamped on every observability
 *  event the sub-agent emits onto the parent's stream (via the
 *  `subagent_id` payload field), so operators / UI / replay can fold
 *  the slice back together. */
export interface SubagentResult {
  /** Concatenated text of the sub-agent's final assistant message.
   *  Empty string when it terminated without one. */
  summary: string;
  /** Per-spawn discriminator. Stamped on every observability event
   *  the sub-agent emits onto the parent's stream (`subagent_id`
   *  payload field) and bracketed by `subagent.start` / `subagent.end`
   *  events carrying the same id. */
  subagentId: string;
  /** Terminal disposition of the sub-agent's codergen call. */
  status: "completed" | "halted" | "cancelled";
  /** Set when `status === 'halted'`. Free-form short string so the
   *  parent LLM can tell why the sub-agent failed without a separate
   *  log dive. */
  haltReason?: string;
  /** Count of tool calls the sub-agent made across its loop. */
  totalToolCalls: number;
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
 * (long-running bash, abortable network calls, streaming progress,
 * extensions needing run-scoped context) read what they need off the
 * third argument. Mirrors `AgentTool.execute`'s signal/onUpdate
 * plumbing in pi-agent-core, plus a swarm-specific `swarmContext`
 * slot for extension tools. */
export interface ToolExecuteOptions<TResult = ContextValue> {
  /** Cancellation signal. Tools should clean up promptly when fired. */
  signal?: AbortSignal;
  /** Streaming progress callback. Tools that produce incremental
   * output (bash, long curls) call this with partial `ToolOutput`s
   * during execution; consumers can render a live preview. */
  onUpdate?: (partial: ToolOutput<TResult>) => void;
  /** Swarm-side run context. Required by extension-supplied tools to
   * construct their `ExtensionContext`; ignored by built-ins. */
  swarmContext?: SwarmToolContext;
  /** Pi-agent-core tool-call id (e.g. `toolu_01ABC…`). The `agent` tool
   * stamps this onto the resulting `subagent.start` event so the web
   * UI can link a parent toolCall card to its in-flight sub-agent
   * before the toolResult lands; other tools ignore it. */
  tool_call_id?: string;
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
  /** When true, the tool is excluded from the catch-all "all tools"
   * set that nodes get when they don't specify `allowed_tools`. The
   * tool only surfaces when a node explicitly names it. Used by
   * non-trivial side-effecting tools (web_fetch, future credential
   * holders) so they don't silently leak into every codergen node. */
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
