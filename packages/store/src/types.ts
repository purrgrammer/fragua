// swarm store — public types. Mirrors §4 of docs/ARCHITECTURE.md.

export type RunStatus = "queued" | "running" | "paused_hitl" | "completed" | "cancelled" | "halted" | "quarantined";

export type EventWriter = "daemon" | "web";

export interface RunMetrics {
  totalTokens: number;
  totalCostUsd: number;
  loopCounts: Record<string, number>;
  /** Per-model breakdown. Populated when a node reports modelName. */
  models: Record<string, { tokens: number; costUsd: number }>;
}

export interface RunState {
  runId: string;
  version: number;
  status: RunStatus;
  currentNode: string | null;
  workflowSha: string;
  schemaVersion: number;
  routing: Record<string, unknown>;
  metrics: RunMetrics;
  nextSeq: number;
  lastAppliedSeq: number;
  priority: number;
  enqueuedAt: number;
  readyAt: number;
  nodeStartedAt: number | null;
  updatedAt: number;
}

// ─────────────── Intent events (writer: "web", no OCC) ───────────────

export type IntentEvent =
  | { type: "intent.run_enqueued"; payload: { workflowSha: string; priority?: number } }
  | { type: "intent.steering_requested"; payload: { text: string } }
  | { type: "intent.pause_requested"; payload: Record<string, never> }
  | { type: "intent.cancel_requested"; payload: { reason?: string } }
  | { type: "intent.hitl_input"; payload: { input: unknown } }
  | {
      type: "intent.unquarantine";
      payload: { resolution: "treat_as_done" | "retry" | "cancel"; note: string };
    }
  | {
      type: "intent.priority_adjusted";
      payload: { newPriority: number; note: string };
    };

export type IntentType = IntentEvent["type"];

// ─────────────── Fact events (writer: "daemon", OCC-checked) ───────────

export type HaltReason = "budget" | "max_loops" | "abort_loop" | "schema_drift" | "error" | "aborted_exit";

export type QuarantineReason = "orphan_side_effect" | "other";

export type FactEvent =
  | {
      type: "fact.run_started";
      payload: { workflowSha: string; schemaVersion: number; startNode: string };
    }
  | { type: "fact.node_started"; payload: { nodeId: string; iteration: number } }
  | {
      type: "fact.node_completed";
      payload: {
        nodeId: string;
        iteration: number;
        outputRef?: string;
        tokens: number;
        costUsd: number;
        /** Optional: LLM provider model id, e.g. "gemini-1.5-pro". */
        modelName?: string;
        nextNode: string;
      };
    }
  | {
      type: "fact.node_aborted";
      payload: {
        nodeId: string;
        iteration: number;
        cause: string;
        partialTokens: number;
        partialCostUsd: number;
      };
    }
  | {
      type: "fact.intents_folded";
      payload: { intentSeq: number; folded: string };
    }
  | {
      type: "fact.side_effect_intent";
      payload: {
        nodeId: string;
        iteration: number;
        toolName: string;
        argsHash: string;
        attempt: number;
        idempotencyKey: string;
      };
    }
  | {
      type: "fact.side_effect_done";
      payload: {
        idempotencyKey: string;
        artifactKey: string;
        tokens?: number;
        costUsd?: number;
      };
    }
  | {
      type: "fact.side_effect_failed";
      payload: { idempotencyKey: string; errorCode: string; retriable: boolean };
    }
  | {
      type: "fact.tool_completed";
      payload: {
        toolName: string;
        argsHash: string;
        artifactKey: string;
        preview: string;
        summary?: string;
      };
    }
  | {
      type: "fact.message_appended";
      payload: {
        ordinal: number;
        role: MessageRole;
        nodeId: string | null;
        iteration: number;
      };
    }
  | { type: "fact.run_paused_hitl"; payload: { nodeId: string; prompt: string } }
  | {
      type: "fact.run_resumed";
      payload: {
        fromStatus: RunStatus;
        inputIntentSeq?: number;
      };
    }
  | { type: "fact.run_completed"; payload: { finalNode: string } }
  | {
      type: "fact.run_halted";
      payload: { reason: HaltReason; detail?: string };
    }
  | { type: "fact.run_cancelled"; payload: { intentSeq: number } }
  | {
      type: "fact.run_quarantined";
      payload: { reason: QuarantineReason; orphanedIntents?: number[] };
    }
  | { type: "fact.run_requeued_after_crash"; payload: { prevNode?: string } }
  | {
      type: "fact.handler_timeout_leaked";
      payload: { nodeId: string; leakedAt: number };
    }
  | { type: "fact.daemon_takeover"; payload: { reclaimedFrom: number; at: number } };

export type FactType = FactEvent["type"];

/**
 * Observability events carry the agent / LLM / tool / cost streaming trail
 * the UI projects into its conversation + step views. They ride alongside
 * facts in the same `events` table (same `seq` space, monotonic) but are
 * NOT reduced into `run_state` — they're pure audit. See
 * {@link IEventStore.appendObservabilityEvents}.
 *
 * The `type` stays verbatim (`agent.turn_start`, `llm.text_delta`, etc.)
 * so the SSE + REST paths expose them under their natural names, matching
 * what `events-to-conversation.ts` folds.
 */
export interface ObservabilityEvent {
  type: string;
  payload: Record<string, unknown>;
}

export type AnyEvent = IntentEvent | FactEvent;
export type EventType = AnyEvent["type"];

/**
 * What the store actually gives you back from the `events` table. The
 * `type` column is a plain string in SQLite — the fact/intent unions are
 * the TYPED-WRITE contract only, not a read-side constraint. Observability
 * events (agent.*, llm.*, tool.*, cost.recorded) land in the same table
 * under their verbatim types and must be readable without casts.
 */
export interface StoredEvent {
  runId: string;
  seq: number;
  type: string;
  writer: EventWriter;
  payload: unknown;
  ts: number;
}

// ─────────────── Messages and artifacts ───────────────

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  runId: string;
  ordinal: number;
  role: MessageRole;
  content: string;
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

// ─────────────── Daemon lock + results ───────────────

export interface DaemonLockRow {
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface DaemonLockResult {
  acquired: boolean;
  current: DaemonLockRow;
}

export interface FactAppendResult {
  committed: true;
  newVersion: number;
  seqs: number[];
}

export interface AppendFactOpts {
  /** Merge into run_state.routing inside the same transaction. */
  routingPatch?: Record<string, unknown>;
  /**
   * Advance `last_applied_seq` to this value. If omitted, last_applied_seq
   * is left untouched so intents written since the last fold remain
   * unapplied and visible to getUnappliedIntents.
   */
  advanceAppliedTo?: number;
}

export interface IntentAppendResult {
  seq: number;
  ts: number;
}

export interface WorkflowRow {
  sha: string;
  name: string;
  dotSource: string;
  createdAt: number;
}

// ─────────────── Errors ───────────────

export class ConcurrencyError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`concurrency conflict: expected version ${expectedVersion}, got ${actualVersion}`);
    this.name = "ConcurrencyError";
  }
}

export class ArtifactTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly max: number,
  ) {
    super(`artifact too large: ${sizeBytes} > ${max}`);
    this.name = "ArtifactTooLargeError";
  }
}

export class SchemaDriftError extends Error {
  constructor(
    public readonly runVersion: number,
    public readonly codeVersion: number,
  ) {
    super(`schema drift: run pinned to v${runVersion}, code is v${codeVersion}`);
    this.name = "SchemaDriftError";
  }
}

export class QuarantineError extends Error {
  constructor(
    public readonly runId: string,
    public readonly reason: QuarantineReason,
  ) {
    super(`run ${runId} is quarantined: ${reason}`);
    this.name = "QuarantineError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly max: number,
  ) {
    super(`event payload too large: ${sizeBytes} > ${max}`);
    this.name = "PayloadTooLargeError";
  }
}

// ─────────────── Size bounds ───────────────

export const MAX_EVENT_PAYLOAD_BYTES = 4096;
export const MAX_ROUTING_BYTES = 8192;
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_CHARS = 512;

// ─────────────── Store interface ───────────────

export interface EnqueueRunParams {
  runId: string;
  workflowSha: string;
  priority?: number;
  initialRouting?: Record<string, unknown>;
}

export interface GetEventsOpts {
  sinceSeq?: number;
  limit?: number;
}

export interface GetMessagesOpts {
  sinceOrdinal?: number;
  limit?: number;
  nodeId?: string;
}

export interface SweepResult {
  requeued: string[];
  quarantined: string[];
}

export interface IEventStore {
  // ─── Writes
  appendFact(runId: string, events: FactEvent[], expectedVersion: number, opts?: AppendFactOpts): FactAppendResult;
  appendIntent(runId: string, event: IntentEvent): IntentAppendResult;
  /**
   * Append observability events (agent.*, llm.*, tool.*, cost.recorded).
   * They share the same seq space as facts/intents, so a consumer tailing
   * `/runs/:id/events` sees them interleaved in causal order — but they do
   * NOT trigger the reducer, do NOT bump `run_state.version`, and do NOT
   * require an expectedVersion (so handlers can emit mid-step without
   * racing the terminal appendFact).
   */
  appendObservabilityEvents(runId: string, events: ObservabilityEvent[]): { seqs: number[] };

  // ─── Run lifecycle
  enqueueRun(params: EnqueueRunParams): void;
  claimNextRun(maxInFlight: number): { runId: string } | null;
  startupSweep(): SweepResult;

  // ─── State reads
  getState(runId: string): RunState | null;
  getEvents(runId: string, opts?: GetEventsOpts): StoredEvent[];
  getUnappliedIntents(runId: string): StoredEvent[];

  // ─── Messages
  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal">,
  ): {
    ordinal: number;
  };
  getMessages(runId: string, opts?: GetMessagesOpts): Message[];

  // ─── Artifacts
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string): ArtifactRef;
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null;

  // ─── Daemon lock
  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  heartbeatDaemonLock(pid: number): void;
  releaseDaemonLock(pid: number): void;
  currentDaemonLock(): DaemonLockRow | null;
  /** Counts used by the `/health` daemon enrichment. Cheap (indexed). */
  runStateCounts(): { running: number; queued: number };

  // ─── Workflows
  saveWorkflow(sha: string, name: string, dotSource: string): void;
  getWorkflow(sha: string): WorkflowRow | null;

  // ─── Subscriptions (post-commit, in-process; no IPC)
  onCommit(listener: (runId: string, seq: number) => void): () => void;

  // ─── Maintenance
  vacuum(): void;
  gcBlobs(maxRows?: number): { deleted: number };
  close(): void;
}
