// Handler contract — ARCHITECTURE.md §5.
//
// A Handler is a pure async function: given an immutable context, produce a
// HandlerResult. Handlers never touch the filesystem, spawn processes, or
// reach into the store directly. All side effects route through the context
// helpers, which the executor wires to the event store.

import type { ArtifactRef, ArtifactScope, Message } from "@swarm/store";
import type { AgentMessage, Message as PiMessage } from "@swarm/types";
import type { ExecutionEnvironment } from "../types/execution.ts";

export type SideEffect = "none" | "idempotent" | "external";

export interface HandlerSpec {
  kind: string;
  sideEffect: SideEffect;
  /** Hard per-call timeout. Applied via AbortSignal.timeout inside the executor. */
  maxMs: number;
  handler: Handler;
}

export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

export interface LlmCallParams {
  model: string;
  /** Prompt-to-LLM message list — pi-ai's `Message` union
   * (`UserMessage | AssistantMessage | ToolResultMessage`). For richer
   * per-turn history (thinking, custom-type messages) use the agent
   * surface via `makeCodergenHandler` instead; this low-level helper
   * is for bare single-call handlers. */
  messages: PiMessage[];
  /** Soft token cap; provider-specific. */
  maxTokens?: number;
}

export interface LlmResult {
  content: string;
  tokens: number;
  costUsd: number;
  model: string;
}

export interface LlmClient {
  call(params: LlmCallParams): Promise<LlmResult>;
}

export interface HttpClient {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export type ToolHandler<A, R> = (args: A, signal: AbortSignal, idempotencyKey?: string) => Promise<R>;

export interface ToolDescriptor<A = unknown, R = unknown> {
  name: string;
  sideEffect: SideEffect;
  handler: ToolHandler<A, R>;
}

export interface ToolRegistry {
  get<A = unknown, R = unknown>(name: string): ToolDescriptor<A, R>;
  has(name: string): boolean;
  list(): string[];
  /** Return a narrowed view. `allow` is an allowlist; `deny` is a blocklist
   * applied after allow. Tools outside the narrowed view are not visible to
   * `has`, `get`, or `list` — `get("bash")` on a registry narrowed to
   * `{ allow: ["read"] }` throws `unknown tool: bash`. This is the hard
   * filter that `node.attrs.allowed_tools` hangs off at the HandlerContext
   * boundary. */
  select(opts: { allow?: readonly string[]; deny?: readonly string[] }): ToolRegistry;
}

export interface MessagesApi {
  /** Append an LLM-visible message row. Stores the full pi-agent-core
   * `AgentMessage` shape (including tool_use / tool_result / thinking
   * block structure, signatures, custom types). Round-trips through
   * JSON losslessly. */
  append(message: AgentMessage): { ordinal: number };
  recent(n: number): Message[];
  since(ordinal: number): Message[];
}

export interface ArtifactsApi {
  /**
   * Write an artifact under the current `(run, node, iteration)` scope.
   * Replay-safe by default:
   *  - Identical content at the same key → returns the existing ref (no-op).
   *  - Different content + default options → throws `ArtifactCollisionError`.
   *  - Different content + `{ replace: true }` → overwrites.
   * Pass `replace: true` when the handler legitimately produces different
   * output on each attempt within the same iteration (e.g. shell tool
   * stdout containing timestamps).
   */
  put(key: string, content: string | Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;
  get(key: string): Uint8Array;
  ref(key: string): ArtifactRef | null;
  getFrom(scope: ArtifactScope): Uint8Array;
}

export interface SideEffectRecorder {
  recordIntent(params: { toolName: string; argsHash: string; attempt: number; idempotencyKey: string }): void;
  recordDone(params: { idempotencyKey: string; artifactKey: string; tokens?: number; costUsd?: number }): void;
  recordFailed(params: { idempotencyKey: string; errorCode: string; retriable: boolean }): void;
}

export interface ExternalCallParams {
  toolName: string;
  /** Arbitrary JSON-serialisable value describing the call. The framework
   * runs it through `canonicalStringify` (sorted keys, deterministic output)
   * and sha256s the result to produce the stable `argsHash` that feeds the
   * idempotency key. Passing a pre-hashed string is wrong — it defeats the
   * point of canonicalising inside the framework. */
  args: unknown;
  attempt?: number;
}

/**
 * Provider-level idempotency envelope. The handler gives us a function that
 * takes the idempotency key (to pass through as an Idempotency-Key header
 * or provider-specific equivalent), and we wrap the call with the INTENT
 * and DONE/FAILED facts.
 */
export type ExternalCall = <T>(params: ExternalCallParams, fn: (idempotencyKey: string) => Promise<T>) => Promise<T>;

export interface HandlerContext {
  readonly runId: string;
  readonly nodeId: string;
  /** Per-node re-entry counter. 0 on first entry; bumped by the executor
   * every time a backward edge returns control to this node (attractor
   * §3.6 retry semantics). Used to key idempotency hashes so repeated
   * retries of the same external call don't dedupe to a single provider
   * request. */
  readonly iteration: number;
  /** Composed AbortSignal: steer | timeout | shutdown. Respecting this is contract. */
  readonly signal: AbortSignal;
  readonly routing: Readonly<Record<string, unknown>>;
  readonly llm: LlmClient;
  readonly http: HttpClient;
  readonly tools: ToolRegistry;
  readonly messages: MessagesApi;
  readonly artifacts: ArtifactsApi;
  readonly externalCall: ExternalCall;
  /**
   * Substitution args for prompt templating. Passed to `substitute()` before
   * the prompt hits the LLM. Today the only key is `$ARGUMENTS` (sourced
   * from `run_state.routing.input` — CLI positional or POST /runs body).
   * Other tokens (`${context.*}`, `$<nodeId>.output[.path]`) read from the
   * substitution context, not from this map.
   */
  readonly args: Readonly<Record<string, string>>;
  /**
   * Emit an observability event (agent.*, llm.*, tool.*, cost.recorded,
   * summary.*). The executor persists these to the store under their
   * verbatim type so the UI's conversation + step views can project them.
   * Non-blocking: the actual write is buffered and flushed alongside the
   * node's terminal fact. Calling this inside a handler is safe under
   * abort — buffered events flush even if the handler throws.
   */
  readonly emit: (type: string, payload: Record<string, unknown>) => void;
  /** Optional: HITL input delivered to a resumed wait.human node. */
  readonly hitlInput?: { selected: string; note?: string } | string;
  /** Optional: steering text folded in before this node run. */
  readonly steering?: string;
  /** Per-run shell + filesystem environment. Set by the executor when a
   * WorktreeProvisioner is wired — points at the run's isolated
   * worktree. When unset (tests, bare LocalEnvironment daemons)
   * handlers can fall back to a process-cwd default. Handlers that
   * spawn subprocesses or read files MUST prefer this over
   * `process.cwd()` so concurrent runs don't step on each other. */
  readonly env?: ExecutionEnvironment;
  /** Snapshot of cumulative cost / tokens against configured ceilings,
   * computed by the executor from `run_state.metrics` + the active
   * graph + node attrs at dispatch time. Pass-through to backends that
   * surface "X of Y used" on `llm.start.budget`. Undefined when no
   * ceiling is configured for this run. */
  readonly budgetSnapshot?: BudgetSnapshotInput;
}

/** Subset of `BudgetSnapshot` populated by the executor and threaded
 * through the handler context to the agent backend. */
export interface BudgetSnapshotInput {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  max_cost_usd?: number;
  run_max_cost_usd?: number;
}

export type HandlerResult =
  | {
      kind: "transition";
      /** Explicit next node. When set, the executor uses it verbatim and
       * skips edge selection entirely. Handlers that want the 5-rule
       * selector (condition → preferred_label → suggested_next_ids →
       * weight → lexical) should leave this unset and populate the
       * `outcomeStatus` / `preferredLabel` / `suggestedNextIds` fields
       * instead. */
      nextNode?: string;
      /** Outcome status — matched against edge `condition="outcome=<s>"`
       * clauses by the executor's edge selector. Defaults to "success". */
      outcomeStatus?: "success" | "partial_success" | "fail" | "retry" | "skipped";
      /** Preferred edge label — matched against unconditional edges'
       * `label` attr after condition matching fails. */
      preferredLabel?: string;
      /** Suggested next node ids in priority order — matched against
       * unconditional edges' `to` after label matching fails. */
      suggestedNextIds?: string[];
      outputRef?: ArtifactRef;
      routingDelta?: Record<string, unknown>;
      tokens: number;
      costUsd: number;
      /** Input/output/cache split accumulated across every `cost.recorded`
       * event the node emitted. Optional so legacy handlers that only
       * report `tokens` + `costUsd` (e.g. tool handlers, wait.human)
       * keep compiling. The executor writes these straight into
       * `fact.node_completed` so the run-level reducer can compute a
       * cache-hit rate. */
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      modelName?: string;
    }
  | {
      kind: "yield_hitl";
      label: string;
      options: Array<{ key: string; label: string; to: string }>;
      routingDelta?: Record<string, unknown>;
    }
  | {
      kind: "halt";
      reason: "budget" | "max_loops" | "error";
      detail?: string;
    }
  | {
      /** Recoverable LLM-provider transport failure (HTTP 402 / 429 / 5xx /
       * pre-response network reset). The executor commits
       * `fact.run_paused_provider_error` and transitions the run to
       * `paused_provider_error`. An operator `intent.resume` wakes the
       * run and re-dispatches the same `(nodeId, iteration)` with the
       * rehydrated transcript. Handlers never construct this themselves
       * — the codergen agent boundary detects provider transport errors
       * and returns this kind on the handler's behalf. */
      kind: "pause_provider";
      httpStatus: number | null;
      provider: string;
      errorMessage: string;
    };
