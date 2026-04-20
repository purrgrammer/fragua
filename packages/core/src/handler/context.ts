import type { ArtifactRef, ArtifactScope, IEventStore, Message, MessageRole } from "@swarm/store";
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
    append(role: MessageRole, content: string) {
      return store.appendMessage(runId, {
        role,
        content,
        nodeId,
        iteration,
      });
    },
    recent(n) {
      const all = store.getMessages(runId, { limit: 10_000 });
      return all.slice(-n);
    },
    since(ordinal) {
      return store.getMessages(runId, { sinceOrdinal: ordinal, limit: 10_000 });
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

  const ctx: HandlerContext = {
    runId,
    nodeId,
    iteration,
    signal: opts.signal,
    routing: opts.routing,
    llm: opts.llm,
    http: opts.http,
    tools: opts.tools,
    messages,
    artifacts,
    externalCall,
    args: opts.args ?? {},
    emit,
    ...(opts.hitlInput !== undefined ? { hitlInput: opts.hitlInput } : {}),
    ...(opts.steering !== undefined ? { steering: opts.steering } : {}),
  };
  return ctx;
}

export type { Message };
