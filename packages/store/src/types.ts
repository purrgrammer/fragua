// swarm store — public types. Mirrors §4 of docs/ARCHITECTURE.md.
//
// The typed event unions (IntentEvent, FactEvent, RunStatus, etc.) live
// in @swarm/types so the web client can import them without pulling in
// the SQLite-backed store. We re-export them here so existing daemon /
// server callers keep their `from "@swarm/store"` imports working.

import type {
  AgentMessage,
  AnyEvent as AnyEventFromTypes,
  DaemonEvent as DaemonEventFromTypes,
  EventEnvelope,
  EventWriter as EventWriterFromTypes,
  FactEvent as FactEventFromTypes,
  FactType as FactTypeFromTypes,
  HaltReason as HaltReasonFromTypes,
  IntentEvent as IntentEventFromTypes,
  IntentType as IntentTypeFromTypes,
  MessageRole as MessageRoleFromTypes,
  Project,
  QuarantineReason as QuarantineReasonFromTypes,
  RunStatus as RunStatusFromTypes,
} from "@swarm/types";
import type { RunCostTotalsRow, StepAggregateRow } from "./queries.ts";

export type {
  AnyEvent,
  AnyEventType,
  DaemonEvent,
  DaemonEventEnvelope,
  DaemonEventType,
  EventEnvelope,
  EventWriter,
  FactEvent,
  FactType,
  FeedEvent,
  HaltReason,
  IntentEvent,
  IntentType,
  MessageRole,
  Project,
  QuarantineReason,
  RawEvent,
  RunStatus,
} from "@swarm/types";
export { ALL_DAEMON_EVENT_TYPES } from "@swarm/types";
export type { RunCostTotalsRow, StepAggregateRow };

// Local aliases below let us narrow the re-exported unions in places
// that previously referenced these names directly. Equivalent to the
// re-exports above; just keeps function signatures in this file
// readable without long type-import names.
type RunStatus = RunStatusFromTypes;
type EventWriter = EventWriterFromTypes;
type IntentEvent = IntentEventFromTypes;
type FactEvent = FactEventFromTypes;
type DaemonEvent = DaemonEventFromTypes;
type HaltReason = HaltReasonFromTypes;
type QuarantineReason = QuarantineReasonFromTypes;
type IntentType = IntentTypeFromTypes;
type FactType = FactTypeFromTypes;
type MessageRole = MessageRoleFromTypes;
// Re-affirm so unused-import check passes on the aliases above.
type _Touch = AnyEventFromTypes | EventEnvelope | HaltReason | QuarantineReason | IntentType | FactType | MessageRole;

export interface RunMetrics {
  /** Sum across input + output + cacheRead + cacheWrite. The "what hits
   * the invoice" number — `/metrics/global` exposes it as `billed_tokens`.
   * Distinct from fresh tokens (`totalInputTokens + totalOutputTokens`),
   * which is what `budget_tokens` fences against. */
  billedTokens: number;
  totalCostUsd: number;
  /** Cost attributable to input/prompt tokens. Sums `cost.recorded`
   * payloads' input cost split (pi-ai's `usage.cost.input`). 0 on
   * older runs that pre-date the split — reducers default missing
   * fields defensively. */
  totalInputCostUsd: number;
  /** Cost attributable to output/completion tokens (includes
   * reasoning/thinking on providers that bundle them under output).
   * 0 on older runs. */
  totalOutputCostUsd: number;
  /** Fresh prompt tokens (excludes cache hits on providers that track
   * them separately, e.g. Anthropic). Zero on older runs that predate
   * the split — reducers accept missing fields defensively. */
  totalInputTokens: number;
  /** Generated output tokens (includes reasoning/thinking tokens on
   * providers that bundle them into `output_tokens`, e.g. Anthropic). */
  totalOutputTokens: number;
  /** Prompt-cache hits. Counted separately from `totalInputTokens` so
   * the dashboard can compute a cache hit rate. */
  totalCacheReadTokens: number;
  /** Cache priming tokens (ephemeral writes). Conflates 5m + 1h TTLs
   * today because pi-ai reports a single number; split upstream. */
  totalCacheWriteTokens: number;
  loopCounts: Record<string, number>;
  /** Per-model breakdown. Populated when a node reports modelName. */
  models: Record<string, { tokens: number; costUsd: number }>;
  /** Per-node cost + token accumulation across iterations. `tokens` is
   * fresh (input + output) — matches what `max_tokens` per-node ceilings
   * fence against. `costUsd` is billed (provider invoice). Empty on runs
   * that predate the field — reducers accept missing maps defensively. */
  nodeCosts: Record<string, { tokens: number; costUsd: number }>;
  /** Accumulated active dispatch time in milliseconds. Excludes time
   * spent paused (HITL / provider error / quarantined) or while the
   * daemon was dead. Compute pause time from
   * `terminal_ts - run_started_ts - activeMs`. */
  activeMs: number;
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
  /** Wall-clock when the current dispatch began. Set by
   * `fact.dispatch_started`, cleared by every terminal/pause fact (which
   * accumulates `metrics.activeMs` first). */
  dispatchStartedAt: number | null;
  updatedAt: number;
  /** Auto-generated run title (short prose, ≤80 chars by convention).
   * Populated by the daemon's auto-titler after `fact.run_started` via
   * `setRunTitle`. `null` until the summariser produces one; `null` is
   * also the terminal state when summarisation is disabled or failed —
   * the UI falls back to `routing.input` ($ARGUMENTS) in that case. */
  title: string | null;
  /** HEAD sha of the worktree at provision time. Set by the executor on
   * `fact.run_started` when a `WorktreeProvisioner` is configured.
   * `null` for runs without a worktree (LocalEnvironment / no provisioner). */
  baseGitSha: string | null;
  /** Branch preserved at dispose time when the worktree had a non-empty
   * `git status --porcelain`. Set by `fact.run_branched`, emitted from
   * the executor's terminal-cleanup path. `null` while the run is live,
   * for clean-tree runs (nothing to commit), and for runs without a
   * worktree. Convention: `swarm/runs/<run_id>`. */
  branch: string | null;
}

/**
 * Observability events carry the agent / LLM / tool / cost streaming trail
 * the UI projects into its conversation + step views. They ride alongside
 * facts in the same `events` table (same `seq` space, monotonic) but are
 * NOT reduced into `run_state` — they're pure audit. See
 * {@link IEventStore.appendObservabilityEvents}.
 *
 * The `type` stays verbatim (`agent.turn_start`, `llm.text_delta`, etc.)
 * so the SSE + REST paths expose them under their natural names.
 */
export interface ObservabilityEvent {
  type: string;
  payload: Record<string, unknown>;
}

/** Re-export: `AnyEvent["type"]` — preserved as `EventType` for
 * @swarm/store callers that already imported it under that name. New
 * code should prefer `AnyEventType` from @swarm/types. */
export type EventType = import("@swarm/types").AnyEventType;

export { FEED_EVENT_KINDS } from "@swarm/types";

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

/**
 * Read shape for a row in the `daemon_events` table. `seq` is the
 * AUTOINCREMENT primary key — disjoint from any per-run `seq` space.
 * `runId` is set for run-scoped daemon events; global lifecycle / sweep
 * / GC events leave it `null`.
 */
export interface DaemonEventRow {
  seq: number;
  type: string;
  payload: unknown;
  ts: number;
  runId: string | null;
}

// ─────────────── Messages and artifacts ───────────────

// `MessageRole` is re-exported from @swarm/types at the top of this file.

export interface Message {
  runId: string;
  ordinal: number;
  /** The pi-agent-core `AgentMessage` stored as-is. Round-trips through
   * JSON.parse/stringify losslessly; same shape pi-ai hands us at
   * `message_end` and accepts back as `priorMessages`. */
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
}

/** Wire-shape projection of `Message` for the web transcript endpoint.
 * Excludes `runId` (already pinned by the URL) and `iteration` (unused
 * by the UI). Returned directly by `IEventStore.getMessagesNarrow`. */
export interface NarrowMessage {
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
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

/**
 * Thrown by `putArtifact` when an artifact already exists at the given
 * scope and the new content has a different sha. Replay-safe by default:
 * a handler that re-dispatches at the same `(run, node, iteration)` and
 * writes byte-identical content sees a no-op; writing different content
 * to the same key is a programming error unless the caller explicitly
 * passes `{ replace: true }`.
 */
export class ArtifactCollisionError extends Error {
  constructor(
    public readonly scope: ArtifactScope,
    public readonly existingSha: string,
    public readonly attemptedSha: string,
  ) {
    super(
      `artifact collision at ${scope.runId}/${scope.nodeId}#${scope.iteration}:${scope.key} ` +
        `(existing=${existingSha.slice(0, 8)}…, new=${attemptedSha.slice(0, 8)}…) — ` +
        `pass { replace: true } to overwrite`,
    );
    this.name = "ArtifactCollisionError";
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

export class MessageTooLargeError extends Error {
  constructor(
    public readonly sizeBytes: number,
    public readonly max: number,
  ) {
    super(`message too large: ${sizeBytes} > ${max} — spill via ctx.artifacts.put`);
    this.name = "MessageTooLargeError";
  }
}

// ─────────────── Size bounds ───────────────
//
// Limit semantics: pre-flight checks reject when `s.length >= MAX_*`, and
// the schema CHECK clauses reject when `length(col) >= MAX_*`. So the
// largest value that lands successfully is `MAX_* - 1`. Treat the constant
// as the *first rejected size*, not the largest accepted.
//
// Unit caveat: JS `string.length` is UTF-16 code units; SQLite `length()`
// on TEXT is Unicode code-point count. They agree on BMP characters and
// diverge by up to 2x on surrogate-pair-heavy content (emoji, supplementary
// planes). The pre-flight check is the binding constraint in practice
// because it runs first and is stricter for non-BMP content. `MAX_BLOB_BYTES`
// is the only honest-bytes constant — it gates `Uint8Array.byteLength`.

export const MAX_EVENT_PAYLOAD_BYTES = 4096;
export const MAX_ROUTING_BYTES = 8192;
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGE_CONTENT_BYTES = 1024 * 1024;
export const MAX_PREVIEW_CHARS = 512;

// ─────────────── Store interface ───────────────

export interface EnqueueRunParams {
  runId: string;
  workflowSha: string;
  priority?: number;
  initialRouting?: Record<string, unknown>;
  /** UUIDv7 from the project's `.swarm/config.jsonc`. NULL when the
   * caller has no project context (ephemeral runs, integration tests). */
  projectId?: string;
  /** Human-readable project name (from `config.jsonc` `name`, falling
   * back to `basename(cwd)`). UPSERTed into `projects` so UI filters
   * can label by name instead of UUID. Ignored when `projectId` is
   * absent. */
  projectName?: string;
  /** Project root absolute path at enqueue time. Stored on `projects`
   * for UI navigation; nullable since some callers (CI, mocks) don't
   * have one. Multi-clone is last-writer-wins. */
  projectRoot?: string;
}

export interface GetEventsOpts {
  sinceSeq?: number;
  limit?: number;
}

export interface GetGlobalEventsForwardOpts {
  /** Boundary `ts` cursor; events at `ts > floorTs`, plus events at
   * `ts == floorTs` with `(run_id, seq) > (lastRunId, lastSeq)`, are
   * returned. */
  floorTs: number;
  /** Lex-max `run_id` already emitted at `floorTs`. On first connect
   * (no emission at this ts yet), pass the sentinel `""` so every
   * real run_id qualifies as strictly greater. */
  lastRunId: string;
  /** Lex-max `seq` already emitted at `floorTs` for `lastRunId`. On
   * first connect, pass `-1` so every real seq qualifies. */
  lastSeq: number;
  /** Allow-listed event kinds. Required — the global feed always filters. */
  kindIn: readonly string[];
  limit: number;
}

export interface GetGlobalEventsAtFloorOpts {
  /** Boundary `ts` to scan. Only events at exactly this `ts` are
   * returned. */
  floorTs: number;
  /** Pagination cursor — only events with `(run_id, seq) > (afterRunId,
   * afterSeq)` qualify. Pass `""` / `-1` on the first call to walk the
   * full boundary; advance to the last returned `(runId, seq)` on
   * subsequent calls. */
  afterRunId: string;
  afterSeq: number;
  /** Allow-listed event kinds. Required — the global feed always filters. */
  kindIn: readonly string[];
  limit: number;
}

export interface GetGlobalEventsLatestOpts {
  /** Allow-listed event kinds. Required — the global feed always filters. */
  kindIn: readonly string[];
  limit: number;
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

export interface GetDaemonEventsOpts {
  /** Return rows with `seq > sinceSeq`. Defaults to 0 (all rows). */
  sinceSeq?: number;
  /** Cap rows returned. Default: unbounded (`LIMIT -1`). */
  limit?: number;
  /** Filter to a specific run. NULL run_id rows (global events) are
   * excluded when this is set. */
  runId?: string;
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

  /**
   * Append a daemon-level event to the dedicated `daemon_events` table.
   * Disjoint from the per-run event log: no OCC, no reducer, no
   * `run_state.version` bump. Use for process lifecycle (started /
   * stopped / reaper takeover), sweep summaries, GC summaries, leak
   * detection, worktree provisioning. Set `opts.runId` for run-scoped
   * events; leave undefined for global lifecycle.
   */
  appendDaemonEvent(event: DaemonEvent, opts?: { runId?: string }): { seq: number; ts: number };
  /**
   * Read daemon events ordered by `seq ASC`. Filters apply at the SQL
   * layer via indexed reads. When `opts.runId` is set, only rows whose
   * `run_id` matches qualify (NULL run_ids excluded).
   */
  getDaemonEvents(opts?: GetDaemonEventsOpts): DaemonEventRow[];

  // ─── Run lifecycle
  enqueueRun(params: EnqueueRunParams): void;
  claimNextRun(maxInFlight: number): { runId: string } | null;
  /**
   * Heal crash damage on daemon startup (requeue 'running' runs,
   * quarantine orphan side-effect intents). When the caller is the
   * reaper that just force-acquired the lock, pass
   * `priorHeartbeatAt` from the prior daemon's lock row so the
   * `fact.run_requeued_after_crash` payload carries `lastAliveAt` and
   * the reducer can credit the pre-crash active span within ~5s.
   */
  startupSweep(opts?: { priorHeartbeatAt?: number }): SweepResult;
  /**
   * Project an auto-generated title onto `run_state.title`. Idempotent —
   * last-writer wins. Never bumps `version` (the title is a UI hint, not
   * part of the causal state machine). No-op when `runId` is unknown so
   * late-arriving titles for cancelled/deleted runs don't throw.
   */
  setRunTitle(runId: string, title: string): void;

  // ─── State reads
  getState(runId: string): RunState | null;
  getEvents(runId: string, opts?: GetEventsOpts): StoredEvent[];
  /**
   * Forward direction of the global SSE feed: cross-run, ascending
   * scan of events strictly after the `(floorTs, lastRunId, lastSeq)`
   * cursor, filtered by `kindIn`. Returns events in `(ts, run_id,
   * seq)` ASC order, at most `limit` rows. `kindIn` is required and
   * allow-listed at the route layer (see {@link FEED_EVENT_KINDS}).
   */
  getGlobalEventsForward(opts: GetGlobalEventsForwardOpts): StoredEvent[];
  /**
   * Boundary rescan for the global SSE feed: events at exactly
   * `floorTs` with `(run_id, seq) > (afterRunId, afterSeq)`. The
   * loop paginates ASC from `("", -1)` and filters duplicates via a
   * per-`floorTs` Set; this covers any event at the boundary `ts`
   * the forward cursor has already stepped past.
   */
  getGlobalEventsAtFloor(opts: GetGlobalEventsAtFloorOpts): StoredEvent[];
  /**
   * The most-recent `limit` events allow-listed by `kindIn`, returned
   * oldest-first. Powers the backfill route (`GET /events`).
   */
  getGlobalEventsLatest(opts: GetGlobalEventsLatestOpts): StoredEvent[];
  getUnappliedIntents(runId: string): StoredEvent[];

  // ─── Messages
  /**
   * Append a message under `(run, node, iteration)`. Returns the assigned
   * ordinal. Pass `opts.dedup: true` to enable replay-safe dedup: a
   * subsequent call with byte-identical content at the same scope returns
   * the existing ordinal instead of minting a duplicate row. Default OFF
   * because agent transcripts carry per-call timestamps that differ even
   * when the semantic message is the same; opting in is the caller's job.
   */
  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal">,
    opts?: { dedup?: boolean },
  ): {
    ordinal: number;
  };
  getMessages(runId: string, opts?: GetMessagesOpts): Message[];
  /**
   * Same as `getMessages` but with a narrower SQL projection — only
   * `ordinal`, `content`, and `node_id` columns are selected. Skips
   * `run_id` (always equal to the URL/path scope) and `iteration` (unused
   * by the web transcript view) at the SQL layer, so neither column
   * round-trips through SQLite's row buffer or the in-memory `.map`.
   * Output is the wire shape the `/runs/:id/messages` HTTP route ships.
   */
  getMessagesNarrow(runId: string, opts?: GetMessagesOpts): NarrowMessage[];
  /**
   * Distinct `(runId, threadId)` pairs that have ≥1 persisted message or
   * `llm.start` event under a non-terminal run. Used at daemon boot to
   * rehydrate the shared `inProcessWrites` set so a resumed codergen
   * dispatch on a pre-existing thread doesn't misread its own transcript
   * as a foreign one. `threadId` is derived from two sources unioned:
   *  - distinct `messages.node_id` (covers the common `thread_id == node_id` case)
   *  - distinct `json_extract(events.payload, '$.thread_id')` on `llm.start`
   *    rows (covers graph-level / edge-level thread ids that don't match
   *    any node id).
   * Terminal runs (completed/cancelled/halted/quarantined) are excluded
   * — their threads will never be dispatched again. Non-terminal pause
   * states (paused_hitl, paused_provider_error) are included since they
   * resume to the same thread on `intent.resume`/`intent.hitl_input`.
   */
  listThreadsWithMessages(): Array<{ runId: string; threadId: string }>;

  // ─── Aggregations
  /**
   * Per-`llm.start` window summed cost / token totals plus the matching
   * last `llm.done` (endedAt + stopReason). The window is
   * `[this llm.start, next llm.start for the same nodeId)` so
   * `cost.recorded` events that fire after `llm.done` (one llm.start
   * opens the step; the agent emits multiple message_end → cost.recorded
   * inside it on tool-using turns) still attribute to the right step.
   * Sums happen in SQL — never re-fold the event stream in the caller.
   */
  getStepAggregates(runId: string): StepAggregateRow[];
  /**
   * Sum of every `cost.recorded` in a run, regardless of `llm.start`
   * containment. Diagnostic / cross-check companion to
   * `getStepAggregates` — the difference between this and the sum of
   * step aggregates is the cost of synthetic-node events (summariser,
   * title generator) that don't have an `llm.start` to anchor to.
   */
  getRunCostTotals(runId: string): RunCostTotalsRow;

  // ─── Artifacts
  /**
   * Write an artifact at the given scope. Replay-safe by default:
   *  - Identical content at the same scope → returns the existing ref (no-op).
   *  - Different content + `replace: false` (default) → throws `ArtifactCollisionError`.
   *  - Different content + `replace: true` → overwrites.
   */
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null;
  /**
   * Captured outputs of every prior node in this run, keyed by `nodeId`.
   * Folds `fact.node_completed` events that carry an `outputRef`,
   * dereferences each artifact, and returns the latest entry per nodeId
   * (so a re-entered loop sees the most recent iteration's output).
   *
   * Used by the executor to build the substitution `nodeOutputs` map at
   * dispatch time. Returns an empty Map when no prior node has captured
   * output. UTF-8-decodes artifact bytes; non-text artifacts (codergen
   * always writes text/plain; tool nodes write stdout) round-trip
   * losslessly through the decode.
   */
  getNodeOutputs(runId: string): Map<string, { output: string; success: boolean; timestamp: number }>;

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

  // ─── Projects (display cache; refreshed on every enqueueRun that
  // carries projectName)
  listProjects(): Project[];
  getProject(id: string): Project | null;
  /** Insert or refresh a project row outside the enqueue path
   * (e.g. `swarm projects rename`). Inside `enqueueRun` the same
   * UPSERT runs in the run-insert txn — no extra call needed. */
  upsertProject(args: { id: string; name: string; rootPath?: string | null }): void;

  // ─── Maintenance
  vacuum(): void;
  gcBlobs(maxRows?: number): { deleted: number };
  close(): void;
}
