import type { AgentMessage } from "@swarm/types";
import type { ExecutionEnvironment } from "../types/execution.ts";
import { ENV_MUTATOR_TOOLS, makeReadOnlyEnv } from "../types/read-only-env.ts";
import { makeExternalCall } from "./external-call.ts";
import type {
  ArtifactRef,
  ArtifactScope,
  ArtifactsApi,
  BudgetSnapshotInput,
  ExternalCall,
  HandlerContext,
  HandlerMessage,
  HttpClient,
  LlmClient,
  MessagesApi,
  ScopeOverrides,
  SideEffectRecorder,
  ToolRegistry,
} from "./types.ts";

export interface HandlerStore {
  appendMessage(
    runId: string,
    row: { content: AgentMessage; nodeId: string | null; iteration: number },
    opts?: { dedup?: boolean },
  ): { ordinal: number };
  getMessages(runId: string, opts?: { sinceOrdinal?: number; limit?: number; nodeId?: string }): HandlerMessage[];
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
}

export interface BuildContextOpts {
  runId: string;
  nodeId: string;
  iteration: number;
  signal: AbortSignal;
  routing: Readonly<Record<string, unknown>>;
  store: HandlerStore;
  llm: LlmClient;
  http: HttpClient;
  tools: ToolRegistry;
  /** Hard-filter applied to `tools` before it reaches `ctx.tools`. Sourced
   * from `node.attrs.allowed_tools` / `denied_tools`; when set, a handler
   * that calls `ctx.tools.get(name)` for a non-allowed tool gets the same
   * error as for an unregistered tool. */
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  recorder: SideEffectRecorder;
  /** Prompt-substitution args. Today carries only `$ARGUMENTS` (sourced
   * from `routing.input`); empty when the run has no input string.
   * Passed through to HandlerContext unchanged. */
  args?: Readonly<Record<string, string>>;
  /** Observability sink. Every ctx.emit(type, payload) call routes here.
   * The executor wires this to a collector it drains into
   * store.appendObservabilityEvents after the node's terminal fact lands.
   * If omitted, ctx.emit becomes a no-op (useful for tests). */
  emitObservability?: (type: string, payload: Record<string, unknown>) => void;
  humanInput?: { route: string; note?: string } | string;
  steering?: string;
  /** Per-run filesystem + shell environment. When set, handlers run
   * inside this env's cwd rather than the daemon's process cwd. Wired
   * by the executor when a `WorktreeProvisioner` is in play. */
  env?: ExecutionEnvironment;
  /** Budget snapshot for `llm.start.budget`. Optional; the executor only
   * sets this when a graph or node ceiling is configured. */
  budgetSnapshot?: BudgetSnapshotInput;
}

/** Run-level resources captured once at top-level context construction
 * and reused across every `withScope` rescoping. Anything keyed off
 * `(nodeId, iteration)` or per-node policy lives on `ScopeOverrides`,
 * NOT here. */
interface CtxUpstream {
  runId: string;
  signal: AbortSignal;
  routing: Readonly<Record<string, unknown>>;
  store: HandlerStore;
  llm: LlmClient;
  http: HttpClient;
  /** Un-narrowed root registry. Per-scope `allowedTools` / `deniedTools`
   * are applied via `tools.select(...)` inside `buildScopedContext`. */
  tools: ToolRegistry;
  recorder: SideEffectRecorder;
  args: Readonly<Record<string, string>>;
  emitObservability: (type: string, payload: Record<string, unknown>) => void;
  /** Un-wrapped env. The read-only proxy is reapplied per scope based
   * on the scope's tool narrowing. */
  env?: ExecutionEnvironment;
}

/**
 * Wire a HandlerContext to a concrete store + runtime clients.
 *
 * Construction is two-layered: a `CtxUpstream` captures the run-level
 * resources once; `buildScopedContext` builds the six scope-sensitive
 * surfaces (artifacts / messages / externalCall / emit / tools / env)
 * for a given `(nodeId, iteration, allowedTools, deniedTools, ...)`.
 * The returned context exposes `withScope` so a parallel branch can
 * rebuild those six surfaces against its own scope without touching
 * upstream resources.
 */
export function buildHandlerContext(opts: BuildContextOpts): HandlerContext {
  const upstream: CtxUpstream = {
    runId: opts.runId,
    signal: opts.signal,
    routing: opts.routing,
    store: opts.store,
    llm: opts.llm,
    http: opts.http,
    tools: opts.tools,
    recorder: opts.recorder,
    args: opts.args ?? {},
    emitObservability: opts.emitObservability ?? (() => {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };

  const scope: ScopeOverrides = {
    nodeId: opts.nodeId,
    iteration: opts.iteration,
    ...(opts.allowedTools !== undefined ? { allowedTools: opts.allowedTools } : {}),
    ...(opts.deniedTools !== undefined ? { deniedTools: opts.deniedTools } : {}),
    ...(opts.humanInput !== undefined ? { humanInput: opts.humanInput } : {}),
    ...(opts.steering !== undefined ? { steering: opts.steering } : {}),
    ...(opts.budgetSnapshot !== undefined ? { budgetSnapshot: opts.budgetSnapshot } : {}),
  };

  return buildScopedContext(upstream, scope);
}

function buildScopedContext(upstream: CtxUpstream, scope: ScopeOverrides): HandlerContext {
  const { runId, store } = upstream;
  const { nodeId, iteration } = scope;

  const messages: MessagesApi = {
    append(message: AgentMessage) {
      return store.appendMessage(runId, {
        content: message,
        nodeId,
        iteration,
      });
    },
    recent(n) {
      // TODO(perf): replace with a tail query (`ORDER BY ordinal DESC
      // LIMIT n`) instead of pulling everything and slicing. For now
      // the call site is bounded by run lifetime — an n=10 recent call
      // on a 100k-message run reads the whole table.
      const all = store.getMessages(runId, { limit: Number.MAX_SAFE_INTEGER });
      return all.slice(-n);
    },
    since(ordinal) {
      // Unbounded: resume hydration relies on `since(0)` returning
      // every prior message. A silent cap would lose transcript
      // context on a daemon restart (§3.6).
      return store.getMessages(runId, { sinceOrdinal: ordinal, limit: Number.MAX_SAFE_INTEGER });
    },
  };

  const artifacts: ArtifactsApi = {
    put(key, content, mime, opts): ArtifactRef {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return store.putArtifact({ runId, nodeId, iteration, key }, bytes, mime, opts);
    },
    get(key) {
      return store.getArtifact({ runId, nodeId, iteration, key });
    },
    ref(key) {
      return store.getArtifactRef({ runId, nodeId, iteration, key });
    },
    getFrom(s: ArtifactScope) {
      return store.getArtifact(s);
    },
  };

  const externalCall: ExternalCall = makeExternalCall({
    runId,
    nodeId,
    iteration,
    recorder: upstream.recorder,
  });

  // Default-stamp the scope's nodeId / iteration onto observability
  // payloads, but let handler-provided values override. Spread order:
  // scope defaults FIRST, payload LAST. Two reasons:
  //   1. The executor's own emitObservability also default-stamps
  //      `currentNode` (the parent) and spreads payload last; this
  //      wrapper has to defer to the same convention so a branch can
  //      announce a sibling/child fact via the parent's emit (e.g.
  //      `parallel.ts` emits per-branch fact.node_completed with an
  //      explicit `nodeId: childId` — the explicit value MUST win or
  //      run_state.nodes lumps every branch under the parent).
  //   2. For ordinary handler emits (no nodeId in payload), the scope's
  //      stamp flows through unchanged — so a branch's `llm.start`
  //      still carries the branch nodeId rather than the parent's.
  const emit = (type: string, payload: Record<string, unknown>): void => {
    upstream.emitObservability(type, { nodeId, iteration, ...payload });
  };

  const narrowOpts: { allow?: readonly string[]; deny?: readonly string[] } = {};
  if (scope.allowedTools !== undefined) narrowOpts.allow = scope.allowedTools;
  if (scope.deniedTools !== undefined) narrowOpts.deny = scope.deniedTools;
  const scopedTools =
    scope.allowedTools !== undefined || scope.deniedTools !== undefined
      ? upstream.tools.select(narrowOpts)
      : upstream.tools;

  // Align ExecutionEnvironment with the operator-declared toolset. If
  // the scope's allowed_tools / denied_tools rules out every mutator
  // (bash / write / edit), wrap env so writeFile / exec throw — a handler
  // that loses its write *tools* also loses the raw env path that would
  // otherwise bypass them. Parallel branches rely on this to guarantee
  // read-only filesystem access. We read the rules directly from
  // allowed_tools / denied_tools rather than `scopedTools.has(...)`: the
  // executor's registry is sometimes intentionally empty (e.g. swarm's
  // daemon hands codergen its own registry; the executor's `tools` is a
  // sentinel) and querying an empty registry would falsely wrap every
  // node's env.
  const isMutatorAllowed = (name: string): boolean => {
    if (scope.allowedTools !== undefined && !scope.allowedTools.includes(name)) return false;
    if (scope.deniedTools?.includes(name)) return false;
    return true;
  };
  const hasNarrowing = scope.allowedTools !== undefined || scope.deniedTools !== undefined;
  const envCanMutate = !hasNarrowing || ENV_MUTATOR_TOOLS.some(isMutatorAllowed);
  const effectiveEnv = upstream.env !== undefined && !envCanMutate ? makeReadOnlyEnv(upstream.env) : upstream.env;

  const withScope = (override: ScopeOverrides): HandlerContext =>
    buildScopedContext(upstream, { ...scope, ...override });

  const ctx: HandlerContext = {
    runId,
    nodeId,
    iteration,
    signal: upstream.signal,
    routing: upstream.routing,
    llm: upstream.llm,
    http: upstream.http,
    tools: scopedTools,
    messages,
    artifacts,
    externalCall,
    args: upstream.args,
    emit,
    withScope,
    ...(scope.humanInput !== undefined ? { humanInput: scope.humanInput } : {}),
    ...(scope.steering !== undefined ? { steering: scope.steering } : {}),
    ...(effectiveEnv !== undefined ? { env: effectiveEnv } : {}),
    ...(scope.budgetSnapshot !== undefined ? { budgetSnapshot: scope.budgetSnapshot } : {}),
  };
  return ctx;
}
