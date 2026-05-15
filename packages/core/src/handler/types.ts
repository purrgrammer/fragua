// Handler contract — ARCHITECTURE.md §5.
//
// A Handler is a pure async function: given an immutable context, produce a
// HandlerResult. Handlers never touch the filesystem, spawn processes, or
// reach into the store directly. All side effects route through the context
// helpers, which the executor wires to the event store.

import type { AgentMessage, Message as PiMessage } from "@swarm/types";
import type { NodeOutput } from "../engine/substitution.ts";
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

export interface HandlerMessage {
  runId: string;
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
}

export interface ArtifactScope {
  runId: string;
  nodeId: string;
  iteration: number;
  key: string;
}

export interface ArtifactRef extends ArtifactScope {
  sha256: string;
  sizeBytes: number;
  mime: string | null;
}

export interface MessagesApi {
  /** Append an LLM-visible message row. Stores the full pi-agent-core
   * `AgentMessage` shape (including tool_use / tool_result / thinking
   * block structure, signatures, custom types). Round-trips through
   * JSON losslessly. */
  append(message: AgentMessage): { ordinal: number };
  recent(n: number): HandlerMessage[];
  since(ordinal: number): HandlerMessage[];
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

/**
 * Inline outcome the parent's projection records for a terminated
 * sub-run. The parallel handler in collect phase reads these to
 * synthesise the fan_in input shape. Mirrors the payload of
 * `fact.subrun_completed`. See D5 of `docs/proposals/parallel.md`.
 */
export interface SubRunOutcome {
  subRunId: string;
  parentNodeId: string;
  parallelIndex: number;
  finalStatus: "completed" | "halted" | "cancelled";
  costUsd: number;
  billedTokens: number;
  outputRef?: { nodeId: string; key: string };
  fanInScore?: number;
}

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
   * Captured outputs of prior nodes in this run, keyed by `nodeId`. The
   * executor folds the run's `fact.node_completed` events with `outputRef`
   * set into this map before each dispatch, dereferencing the artifact text
   * once. Handlers pass it through to `substitute()` so prompt tokens like
   * `$plan.output` resolve to the captured assistant text. When a node has
   * been re-entered via a backward edge, the most recent iteration's
   * output wins.
   */
  readonly nodeOutputs: ReadonlyMap<string, NodeOutput>;
  /**
   * Inline outcomes for every sub-run that has terminated under this
   * parent run, folded from `fact.subrun_completed` events on the
   * parent's own log. Keyed by sub-run id; payloads carry final status,
   * cost, billed tokens, optional `outputRef`, optional `fanInScore`.
   * Empty on top-level runs and on parent runs that haven't fanned out
   * yet. Used by the parallel handler's collect phase to synthesise
   * fan_in input without re-reading sub-run projections. See P2.3 / D5
   * of `docs/proposals/parallel.md`.
   */
  readonly subRunOutcomes: ReadonlyMap<string, SubRunOutcome>;
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
  /**
   * Return a new HandlerContext with the same run-level resources
   * (store, llm, http, recorder, signal, routing, args, nodeOutputs,
   * emitObservability, env) but rebuilt scope-sensitive surfaces:
   * `artifacts`, `messages`, `externalCall`, `emit`, `tools` (re-narrowed
   * by `allowedTools` / `deniedTools`), and `env` (re-wrapped read-only
   * when the new toolset has no mutator). Used by the auto-dispatcher
   * to hand each parallel branch a context that carries its own
   * `(nodeId, iteration)` instead of leaking the parent's via closure
   * capture. Omitted fields in `override` fall through to the current
   * scope's values. See `ScopeOverrides`.
   */
  readonly withScope: (override: ScopeOverrides) => HandlerContext;
}

/** Inputs to `HandlerContext.withScope`. Required `nodeId` and `iteration`
 * are the two non-negotiable scope axes; the rest mirror the
 * scope-sensitive subset of `BuildContextOpts`. Run-level resources
 * (store / llm / http / signal / routing / recorder / args / nodeOutputs
 * / emitObservability / env) are deliberately omitted — they're captured
 * once at top-level construction and reused across all `withScope` calls. */
export interface ScopeOverrides {
  nodeId: string;
  iteration: number;
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  hitlInput?: { selected: string; note?: string } | string;
  steering?: string;
  budgetSnapshot?: BudgetSnapshotInput;
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
      /** Single-line reason emitted by the handler when `outcomeStatus="fail"`.
       * Surfaces verbatim as `fact.run_halted.detail` when the fail outcome
       * routes to a terminal node (executor's `aborted_exit` path). Optional
       * — handlers that fail without a quotable reason (e.g. retry-policy
       * exhaustion) leave it unset and the executor falls back to a generic
       * detail string. Ignored on non-fail outcomes. */
      failureReason?: string;
      tokens: number;
      costUsd: number;
      /** USD cost split across the four token buckets. Sourced from
       * pi-ai's `usage.cost.{input,output,cacheRead,cacheWrite}` (or
       * `usage.reportedCost.*` when the provider returns it). Optional
       * — handlers that only know the lump-sum `costUsd` skip these
       * and the run-level reducer defaults to 0. */
      inputCostUsd?: number;
      outputCostUsd?: number;
      cacheReadCostUsd?: number;
      cacheWriteCostUsd?: number;
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
      // Executor-only HaltReason literals (drift-lint coverage):
      // `"schema_drift"`, `"aborted_exit"`, `"occ_exhausted"`,
      // `"timeout_exhausted"` are valid `fact.run_halted` reasons that
      // the executor emits directly — not constructible by handlers.
      // The reasons in this union below (`"max_retries_exceeded"`,
      // `"goal_gate_unsatisfied"`, `"max_loops"`) are accepted on the
      // handler-side type but get translated by result-to-facts into
      // `fact.run_paused` with reason `"max_retries"` / `"goal_gate"`
      // / `"max_loops"` (Stage 3 of recoverable-budget-pause.md). The
      // sibling-halt converted reasons `"abort_loop"` and
      // `"provider_exhausted"` are emitted by the executor directly
      // as `fact.run_paused`, never as halts.
      reason: "budget" | "max_loops" | "error" | "goal_gate_unsatisfied" | "max_retries_exceeded";
      detail?: string;
      /** Optional context for halts that result-to-facts converts into
       * operator-resumable pauses. The executor sets
       * `pauseContext.currentLimit` + `attempts` when it wants the
       * resulting `fact.run_paused` payload to carry the cap-hit
       * details for the operator banner. Ignored for halts that stay
       * terminal (`budget`, `error`). */
      pauseContext?: {
        currentLimit?: number;
        attempts?: number;
      };
    }
  | {
      /** Recoverable LLM-provider transport failure (HTTP 402 / 429 / 5xx /
       * pre-response network reset). The executor commits
       * `fact.run_paused{reason: "provider_error" | "payment_required"}`
       * (402 → payment_required, others → provider_error) and transitions
       * the run to `paused`. An operator `intent.resume` wakes the run
       * and re-dispatches the same `(nodeId, iteration)` with the
       * rehydrated transcript. Handlers never construct this themselves
       * — the codergen agent boundary detects provider transport errors
       * and returns this kind on the handler's behalf. */
      kind: "pause_provider";
      httpStatus: number | null;
      provider: string;
      errorMessage: string;
      /** Provider-supplied `Retry-After` (ms). When set, the daemon honours
       * it exactly — no jitter, no exponential cap. Absent → daemon falls
       * back to its own full-jitter exponential schedule. */
      retryAfterMs?: number;
    }
  | {
      /** Parallel handler requests a fan-out into N sub-runs. The
       * executor mints sub-run IDs, enqueues each as a child `run_state`
       * row, and transitions the parent to `running_children` via
       * `fact.fanout_started`. The wake-pending sweep promotes the
       * parent back to `queued` once every sub-run reaches a
       * terminal status; the next dispatch re-enters the
       * parallel handler in collect phase (detected via the
       * `parallel.<nodeId>.sub_run_ids` routing key). P2.2 of
       * `docs/proposals/parallel.md`. */
      kind: "fanout_pending";
      /** Branch root node ids — direct downstream targets of the
       * component node in the parent's DOT graph. Sub-runs dispatch
       * through the subgraph slice anchored at each id. */
      branchNodeIds: readonly string[];
      /** Convergence node the parent re-enters on collect. Sub-runs
       * terminate BEFORE entering it; their `subgraph_terminal_node_id`
       * points here. */
      fanInNode: string;
      /** Join policy hint. Surfaced into the parent's routing so a
       * `first_success` sweep can race-cancel siblings (P4). Defaults to
       * `wait_all`. */
      joinPolicy?: "wait_all" | "first_success";
    };
