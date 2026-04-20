// Handler contract — REARCHITECTURE.md §5.
//
// A Handler is a pure async function: given an immutable context, produce a
// HandlerResult. Handlers never touch the filesystem, spawn processes, or
// reach into the store directly. All side effects route through the context
// helpers, which the executor wires to the event store.

import type { ArtifactRef, ArtifactScope, Message, MessageRole } from "@swarm/store";

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
  messages: { role: MessageRole; content: string }[];
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
}

export interface MessagesApi {
  append(role: MessageRole, content: string): { ordinal: number };
  recent(n: number): Message[];
  since(ordinal: number): Message[];
}

export interface ArtifactsApi {
  put(key: string, content: string | Uint8Array, mime?: string): ArtifactRef;
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
  argsHash: string;
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
  /** 0 outside loops; from routing.loop_counter inside loops. */
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
   * the prompt hits the LLM. Keys are the literal tokens ($ARGUMENTS,
   * $RUN_ID, $WORKTREE_PATH, $LOG_DIR, $1..$9, etc.). The executor populates
   * this from `run_state.routing` + ambient run info (runId, worktree path).
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
  readonly hitlInput?: unknown;
  /** Optional: steering text folded in before this node run. */
  readonly steering?: string;
}

export type HandlerResult =
  | {
      kind: "transition";
      nextNode: string;
      outputRef?: ArtifactRef;
      routingDelta?: Record<string, unknown>;
      tokens: number;
      costUsd: number;
      modelName?: string;
    }
  | {
      kind: "yield_hitl";
      prompt: string;
      routingDelta?: Record<string, unknown>;
    }
  | {
      kind: "halt";
      reason: "budget" | "max_loops" | "error";
      detail?: string;
    };
