import type { ArtifactRef, ArtifactScope, IEventStore, Message } from "@swarm/store";
import type { AgentMessage } from "@swarm/types";
import type { ExecutionEnvironment } from "../types/execution.ts";
import { makeExternalCall } from "./external-call.ts";
import type {
  ArtifactsApi,
  ExternalCall,
  HandlerContext,
  HttpClient,
  LlmClient,
  MessagesApi,
  SideEffectRecorder,
  ToolRegistry,
} from "./types.ts";

export interface BuildContextOpts {
  runId: string;
  nodeId: string;
  iteration: number;
  signal: AbortSignal;
  routing: Readonly<Record<string, unknown>>;
  store: IEventStore;
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
  /** Prompt-substitution args ($ARGUMENTS, $RUN_ID, etc.). Empty record
   * when the caller has no positional input. Passed through to
   * HandlerContext unchanged. */
  args?: Readonly<Record<string, string>>;
  /** Observability sink. Every ctx.emit(type, payload) call routes here.
   * The executor wires this to a collector it drains into
   * store.appendObservabilityEvents after the node's terminal fact lands.
   * If omitted, ctx.emit becomes a no-op (useful for tests). */
  emitObservability?: (type: string, payload: Record<string, unknown>) => void;
  hitlInput?: unknown;
  steering?: string;
  /** Per-run filesystem + shell environment. When set, handlers run
   * inside this env's cwd rather than the daemon's process cwd. Wired
   * by the executor when a `WorktreeProvisioner` is in play. */
  env?: ExecutionEnvironment;
}

/**
 * Wire a HandlerContext to a concrete store + runtime clients.
 *
 * The messages/artifacts APIs delegate to the store; the externalCall helper
 * computes idempotency keys and reports into the recorder (which the
 * executor translates into fact events inside its write transaction).
 */
export function buildHandlerContext(opts: BuildContextOpts): HandlerContext {
  const { runId, nodeId, iteration, store } = opts;

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
    put(key, content, mime): ArtifactRef {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return store.putArtifact({ runId, nodeId, iteration, key }, bytes, mime);
    },
    get(key) {
      return store.getArtifact({ runId, nodeId, iteration, key });
    },
    ref(key) {
      return store.getArtifactRef({ runId, nodeId, iteration, key });
    },
    getFrom(scope: ArtifactScope) {
      return store.getArtifact(scope);
    },
  };

  const externalCall: ExternalCall = makeExternalCall({
    runId,
    nodeId,
    iteration,
    recorder: opts.recorder,
  });

  const emitObs = opts.emitObservability ?? (() => {});
  const emit = (type: string, payload: Record<string, unknown>): void => {
    emitObs(type, payload);
  };

  const narrowOpts: { allow?: readonly string[]; deny?: readonly string[] } = {};
  if (opts.allowedTools !== undefined) narrowOpts.allow = opts.allowedTools;
  if (opts.deniedTools !== undefined) narrowOpts.deny = opts.deniedTools;
  const scopedTools =
    opts.allowedTools !== undefined || opts.deniedTools !== undefined
      ? opts.tools.select(narrowOpts)
      : opts.tools;

  const ctx: HandlerContext = {
    runId,
    nodeId,
    iteration,
    signal: opts.signal,
    routing: opts.routing,
    llm: opts.llm,
    http: opts.http,
    tools: scopedTools,
    messages,
    artifacts,
    externalCall,
    args: opts.args ?? {},
    emit,
    ...(opts.hitlInput !== undefined ? { hitlInput: opts.hitlInput } : {}),
    ...(opts.steering !== undefined ? { steering: opts.steering } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  };
  return ctx;
}

export type { Message };
