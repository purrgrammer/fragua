// fragua store — public types. Mirrors §4 of docs/ARCHITECTURE.md.
//
// The typed event unions (IntentEvent, FactEvent, RunStatus, etc.) live
// in @fragua/types so the web client can import them without pulling in
// the SQLite-backed store. We re-export them here so existing daemon /
// server callers keep their `from "@fragua/store"` imports working.

import type {
  AgentMessage,
  AnyEvent as AnyEventFromTypes,
  ChangeStat,
  DaemonEvent as DaemonEventFromTypes,
  EventEnvelope,
  EventWriter as EventWriterFromTypes,
  FactEvent as FactEventFromTypes,
  FactType as FactTypeFromTypes,
  HaltReason as HaltReasonFromTypes,
  InboxStatus,
  IntentEvent as IntentEventFromTypes,
  IntentType as IntentTypeFromTypes,
  MessageRole as MessageRoleFromTypes,
  PauseReason as PauseReasonFromTypes,
  QuarantineReason as QuarantineReasonFromTypes,
  RunStatus as RunStatusFromTypes,
} from "@fragua/types";
import type {
  AnalyticsWindow,
  BucketedWindow,
  CacheByBucketRow,
  DrilldownFilters,
  DrilldownPage,
  HaltDistributionRow,
  KpiTotalsRow,
  ModelDistributionRow,
  RunsByBucketRow,
  SpendByBucketRow,
  TokensByBucketRow,
  TopWorkflowRow,
  WorkflowDirectoryRow,
} from "./analytics-queries.ts";
import type { OrphanSideEffectRow, PendingIntentRow } from "./event-queries.ts";
import type {
  GcSnapshotRunRow,
  GlobalMetricsTotalsRow,
  GlobalModelBreakdownRow,
  ListRunIdsOpts,
  ListRunSummaryRowsOpts,
  RunCostTotalsRow,
  RunSummaryRow,
  StepAggregateRow,
  WakeCandidateRow,
} from "./run-state-queries.ts";

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
  PauseReason,
  QuarantineReason,
  RawEvent,
  RunStatus,
} from "@fragua/types";
export { ALL_DAEMON_EVENT_TYPES, AUTO_WAKE_PAUSE_REASONS, isTerminal } from "@fragua/types";
export type {
  AnalyticsWindow,
  BucketedWindow,
  BucketKind,
  CacheByBucketRow,
  DrilldownFilters,
  DrilldownPage,
  HaltDistributionRow,
  KpiTotalsRow,
  ModelDistributionRow,
  RunsByBucketRow,
  SpendByBucketRow,
  TokensByBucketRow,
  TopWorkflowRow,
  WorkflowDirectoryRow,
  WorkflowScopeFilter,
} from "./analytics-queries.ts";
export { decodeCursor, encodeCursor, getFirstRunAt } from "./analytics-queries.ts";
export type { OrphanSideEffectRow, PendingIntentRow } from "./event-queries.ts";
export type {
  GcSnapshotRunRow,
  GlobalMetricsTotalsRow,
  GlobalModelBreakdownRow,
  ListRunIdsOpts,
  ListRunSummaryRowsOpts,
  RunCostTotalsRow,
  RunSummaryRow,
  StepAggregateRow,
  WakeCandidateRow,
} from "./run-state-queries.ts";

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
type PauseReason = PauseReasonFromTypes;
// Re-affirm so unused-import check passes on the aliases above.
type _Touch =
  | AnyEventFromTypes
  | EventEnvelope
  | HaltReason
  | QuarantineReason
  | IntentType
  | FactType
  | MessageRole
  | PauseReason;

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
  /** Cost attributable to cache-read tokens (pi-ai's
   * `usage.cost.cacheRead`, billed at ~0.1× input rate on Anthropic).
   * 0 on older runs. */
  totalCacheReadCostUsd: number;
  /** Cost attributable to cache-write tokens (pi-ai's
   * `usage.cost.cacheWrite`, billed at ~1.25× input rate on Anthropic).
   * 0 on older runs. */
  totalCacheWriteCostUsd: number;
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
  contractVersion: number;
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
   * the UI falls back to the workflow name in that case. */
  title: string | null;
  /** HEAD sha of the worktree at provision time. Set by the executor on
   * `fact.run_started` when a `WorktreeProvisioner` is configured.
   * `null` for runs without a worktree (LocalEnvironment / no provisioner). */
  baseGitSha: string | null;
  /** Branch short name of the source repo HEAD at provision — the post-run
   * merge/commit target default. Set by the executor on `fact.run_started`.
   * `null` when the source checkout is detached / on a tag / unborn, or for
   * runs without a provisioner. */
  baseGitRef: string | null;
  /** Worktree snapshot + inbox projection, written by the terminal
   * `fact.snapshot_recorded`. All `null` while the run is live and for
   * bare-cwd runs. `finalGitSha` / `finalHeadRef` = worktree HEAD + its
   * branch at terminal; `diffBaseSha` = the honest diff base (==
   * `baseGitSha` unless HEAD relocated); `changeStat` = committed +
   * uncommitted deltas; `inboxStatus` drives the inbox. */
  finalGitSha: string | null;
  finalHeadRef: string | null;
  diffBaseSha: string | null;
  changeStat: ChangeStat | null;
  inboxStatus: InboxStatus | null;
  /** Tip of the operator's branch after the last `accept` (run → commit
   * traceability). Set by `fact.run_accepted`. */
  acceptedSha: string | null;
  /** Per-machine LOCATION binding — the resolved project root on this box.
   * `null` for runs enqueued without filesystem context (CI, tests). NOTE: a
   * null `cwd` does NOT mean the run is imported — see `imported`. */
  cwd: string | null;
  /** Read-derived (NOT a persisted column): true when the run carries the
   * `imported_runs` inert marker. This — not `cwd == null` — is the authoritative
   * "imported, never dispatched" signal (a legitimately-enqueued run can have a
   * null `cwd`). Populated by `getState`; absent on reducer-produced states. */
  imported?: boolean;
  /** Project IDENTITY (the committed `id`) and its display label. Stable
   * across clones / machines / imports; this — not `cwd` — is how a run
   * attributes to a project. Always present (NOT NULL in the store). */
  projectId: string;
  projectName: string;
  /** Resolved workflow name when the caller passed a bare name; `null`
   * for path-based or ephemeral runs. */
  workflowName: string | null;
  /** How the workflow argument resolved. `'global'` → matched
   * `~/.fragua/workflows/<name>.yaml`. `'local'` → matched
   * `<cwd>/.fragua/workflows/<name>.yaml` (fallback when global misses).
   * `'path'` → caller passed an explicit path. `'ephemeral'` →
   * enqueued via the API without filesystem context. `null` on legacy
   * rows pre-globalization. */
  workflowScope: "global" | "local" | "path" | "ephemeral" | null;
  /** Filesystem path of the .yaml file at resolution time. Diagnostic
   * only — replay keys on `workflowSha`. */
  workflowPath: string | null;
  /** Schedule lineage — the id of the schedule that fired this run, or
   * `null` for manually-enqueued runs. Schedule deletion is hard
   * DELETE; this field is informational, not a foreign-key cascade
   * target, so a run keeps its lineage even after the schedule row is
   * gone. */
  scheduleId: string | null;
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
 * @fragua/store callers that already imported it under that name. New
 * code should prefer `AnyEventType` from @fragua/types. */
export type EventType = import("@fragua/types").AnyEventType;

export { FEED_EVENT_KINDS } from "@fragua/types";

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

// `MessageRole` is re-exported from @fragua/types at the top of this file.

export interface Message {
  runId: string;
  ordinal: number;
  /** The pi-agent-core `AgentMessage` stored as-is. Round-trips through
   * JSON.parse/stringify losslessly; same shape pi-ai hands us at
   * `message_end` and accepts back as `priorMessages`. */
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
  /** Goal-gate re-entry epoch (mirrors fact.*.payload.pass). Threadless
   * resume hydration scopes to (nodeId, iteration, pass) so a fresh gate
   * pass starts with a clean transcript. 0 for never-retargeted runs. */
  pass: number;
}

/** Wire-shape projection of `Message` for the web transcript endpoint.
 * `runId` is omitted (already pinned by the URL). `iteration` is included
 * so the transcript can align looped-node sections to their per-iteration
 * nodeState. Returned directly by `IEventStore.getMessagesNarrow`. */
export interface NarrowMessage {
  ordinal: number;
  content: AgentMessage;
  nodeId: string | null;
  iteration: number;
  pass: number;
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

/** One row of a run's artifact listing — metadata only, no bytes. Returned
 * by `IEventReader.listArtifacts`; the body comes from `getArtifact(scope)`. */
export interface ArtifactListRow {
  nodeId: string;
  iteration: number;
  key: string;
  mime: string | null;
  blobSha: string;
  sizeBytes: number;
  createdAt: number;
}

// ─────────────── Daemon lock + results ───────────────

export interface DaemonLockRow {
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
}

/** Where the HTTP server fronting this store is listening. Written by the
 * harness's in-process server or a standalone `fragua serve` after binding;
 * cleared on shutdown. The discovery surface CLIs read (replaces serve.json). */
export interface ServerEndpointRow {
  url: string;
  port: number;
  pid: number;
  startedAt: number;
  harnessVersion: string | null;
}

export interface DaemonLockResult {
  acquired: boolean;
  current: DaemonLockRow;
}

export interface FactAppendResult {
  committed: true;
  newVersion: number;
  seqs: number[];
  /** The post-commit `run_state` projection, folded inside the same transaction.
   * Lets a caller that needs fresh state right after a commit (e.g. the fan-out
   * budget gate) reuse it instead of issuing a redundant `getState`. Optional so
   * non-Sqlite implementers needn't compute it. */
  state?: RunState;
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
  source: string;
  /** Persisted canonical IR (loc-stripped Graph JSON) + its contract version.
   * NOT NULL — every workflow is parsed once at mint and carries its IR; the
   * GraphLoader deserializes this rather than re-parsing `source`. */
  ir: string;
  irVersion: number;
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
  /** Absolute project root the run was enqueued from. Surfaced on
   * `run_state.cwd` and used as the project identifier in the
   * harness-by-default model. Omitted for callers with no filesystem
   * context (CI, integration tests). */
  cwd?: string;
  /** Project IDENTITY — the stable committed `id` from `.fragua/config.yaml`
   * (a UUIDv7), resolved at the enqueue boundary (CLI/server). Portable
   * across clones / machines / imports. When omitted, the store falls back
   * to `cwd` (then `"local"`) so the NOT NULL column is always satisfied —
   * production callers always pass a real resolved id. */
  projectId?: string;
  /** Denormalized display label for the project, captured at enqueue.
   * Defaults to the cwd basename when omitted. Lets imported-only projects
   * (no local config) show a real name instead of a bare id. */
  projectName?: string;
  /** Resolved workflow name when the caller passed a bare name. Surfaced
   * on `run_state.workflow_name`. Omitted for path-based runs. */
  workflowName?: string;
  /** How the workflow argument resolved. `'global'` matched
   * `~/.fragua/workflows/<name>.yaml`; `'local'` fell back to
   * `<cwd>/.fragua/workflows/<name>.yaml`; `'path'` for explicit paths;
   * `'ephemeral'` for runs enqueued via the API without filesystem
   * context. */
  workflowScope?: "global" | "local" | "path" | "ephemeral";
  /** Filesystem path of the .yaml file at resolution time. Diagnostic
   * only; replay still keys on `workflowSha`. */
  workflowPath?: string;
  /** Schedule lineage — the id of the schedule that fired this run.
   * Set only by the daemon's schedule-dispatcher; manual `fragua run`
   * leaves it undefined. Surfaced on `run_state.schedule_id`. Schedule
   * deletion does NOT cascade here; lineage outlives the schedule. */
  scheduleId?: string;
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

// ─── Segregated store interfaces ───
//
// `IEventStore` was a god interface; the surface is now split into four
// concerns that map onto the actual SQL boundaries:
//
//   IEventWriter        — every method that mutates run-level state
//                         (events, run_state, messages, artifacts,
//                         workflows, projects). One transaction surface;
//                         shares the writer connection.
//   IEventReader        — read-only run-level reads (state, events,
//                         messages, artifacts, workflows, aggregates).
//   IAnalyticsReader    — dashboard aggregations. Distinct from
//                         IEventReader because analytics queries warrant
//                         dedicated tuning (cache_size, multi-query
//                         consistent snapshots).
//   IDaemonCoordinator  — the daemon_events / daemon_lock surface. Truly
//                         orthogonal: no transactional overlap with
//                         run_state, no OCC, separate tables.
//
// `IEventStore` is preserved as a type-alias intersection so existing
// callers don't break. `SqliteStore` implements all four sub-interfaces
// in one class today; nothing prevents future implementations from
// composing them out of separate connections / backends.

export interface IEventWriter {
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

  // ─── Run lifecycle (mutations)
  enqueueRun(params: EnqueueRunParams): void;
  /**
   * Atomically claim the next eligible queued run (highest priority, lowest
   * ready_at), or `null` when the daemon is at capacity or no run is
   * eligible.
   */
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

  // ─── Messages (write)
  /**
   * Append a message under `(run, node, iteration, pass)`. Returns the
   * assigned ordinal. `pass` defaults to 0 (the goal-gate re-entry epoch —
   * the dispatcher stamps it; direct callers without gate context omit it).
   * Pass `opts.dedup: true` to enable replay-safe dedup: a subsequent call
   * with byte-identical content at the same scope returns the existing
   * ordinal instead of minting a duplicate row. Default OFF because agent
   * transcripts carry per-call timestamps that differ even when the
   * semantic message is the same; opting in is the caller's job.
   */
  appendMessage(
    runId: string,
    row: Omit<Message, "runId" | "ordinal" | "pass"> & { pass?: number },
    opts?: { dedup?: boolean },
  ): {
    ordinal: number;
  };

  // ─── Artifacts (write)
  /**
   * Write an artifact at the given scope. Replay-safe by default:
   *  - Identical content at the same scope → returns the existing ref (no-op).
   *  - Different content + `replace: false` (default) → throws `ArtifactCollisionError`.
   *  - Different content + `replace: true` → overwrites.
   */
  putArtifact(scope: ArtifactScope, content: Uint8Array, mime?: string, opts?: { replace?: boolean }): ArtifactRef;

  // ─── Workflow catalog (write)
  saveWorkflow(sha: string, name: string, source: string, ir: string, irVersion: number): void;

  // ─── Maintenance
  vacuum(): void;
  gcBlobs(maxRows?: number): { deleted: number };
  close(): void;
}

export interface IEventReader {
  // ─── Run state + enumeration
  getState(runId: string): RunState | null;
  /** Enumerate run ids with status filter, ordering, and limit pushed
   * into SQL. Powers the web `/runs` list and the analytics drilldown
   * re-hydration loop. */
  listRunIds(opts?: ListRunIdsOpts): string[];
  /** SQL-backed `RunSummary` projection rows. Used by list surfaces so
   * they do not hydrate thousands of events per run just to derive
   * count, duration, title, and metrics. */
  listRunSummaryRows(opts?: ListRunSummaryRowsOpts): RunSummaryRow[];
  /** Counts used by the `/health` daemon enrichment. Cheap (indexed). */
  runStateCounts(): { running: number; queued: number };

  // ─── Event log
  getEvents(runId: string, opts?: GetEventsOpts): StoredEvent[];
  /**
   * Every event of `type` for `runId` in seq order. SQL filter — the
   * caller would otherwise have to scan `getEvents` and re-filter in JS.
   */
  getEventsByType(runId: string, type: string): StoredEvent[];
  /**
   * All worktree-snapshot events for `runId` in seq order: both the
   * per-step / HITL `snapshot.captured` observability events and the
   * terminal `fact.snapshot_recorded` fact. The Diff scrubber feed.
   */
  getSnapshotEvents(runId: string): StoredEvent[];
  /**
   * The last `limit` events for `runId`, newest first. Bounded
   * backwards walk for callers that need "what just happened" without
   * paying for a full scan. Covered by the `(run_id, seq)` primary
   * key — cheap even on long-lived runs.
   */
  getLatestEvents(runId: string, limit: number): StoredEvent[];
  /**
   * The TYPE of the most recent node-lifecycle fact per node
   * (`NODE_LIFECYCLE_FACT_TYPES`: dispatch_started / node_started /
   * node_completed / node_aborted). One windowed SQL pass — the fan-out
   * recovery scan reads this instead of materialising the full event log
   * every dispatch turn.
   */
  getLatestLifecycleByNode(runId: string): Array<{ nodeId: string; type: string }>;
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
  /**
   * Run rows in the requested statuses, optionally narrowed to those
   * whose `routing.internal.auto_resume_at` is at or before the given
   * cutoff (used by the daemon's wake-pending sweep for `paused_auto`
   * timer wake — both provider and handler retries). Returns `{ runId, version,
   * lastAppliedSeq, status }` so the caller can attempt OCC-protected
   * fact appends without a second per-run round-trip. SQL filter — the
   * daemon reaching for `db` directly was the historical alternative.
   */
  getWakeCandidates(opts: { statuses: readonly RunStatus[]; autoResumeBefore?: number }): WakeCandidateRow[];
  /**
   * Terminal runs in the inbox (`inbox_status` ∈ `pending`/`acted`) that
   * carry an unapplied operator-action intent (`intent.branch_run` /
   * `commit_run` / `merge_run` / `discard_run`). Scoped by the inbox
   * partial index + an EXISTS over events so the daemon's operator-action
   * sweep never walks every terminal run. Same OCC-ready row shape as
   * `getWakeCandidates`.
   */
  getInboxActionCandidates(): WakeCandidateRow[];
  /**
   * Terminal runs in `cwd` whose worktree snapshot refs are eligible for
   * GC: settled status, older than `cutoff` (ms epoch), and not awaiting an
   * operator decision (`inbox_status` not `pending`). Drives
   * `fragua gc --snapshots`.
   */
  getGcEligibleSnapshotRuns(opts: { cwd: string; cutoff: number }): GcSnapshotRunRow[];
  /**
   * The next unapplied intent of the given `type` strictly after
   * `sinceSeq`, or `null`. Payload is parsed JSON. Used by the daemon's
   * wake-pending sweep (cancel / human_input / resume / unquarantine).
   */
  getNextPendingIntent(runId: string, type: IntentType, sinceSeq: number): PendingIntentRow | null;
  /**
   * `fact.side_effect_intent` rows on a run whose `idempotencyKey` has
   * no matching `fact.side_effect_done` / `_failed`. The
   * `intent.unquarantine { resolution: "treat_as_done" }` path
   * synthesises one `fact.side_effect_done` per orphan to clear the
   * startup-sweep flag on subsequent restarts.
   */
  findOrphanSideEffects(runId: string): OrphanSideEffectRow[];

  // ─── Messages (read)
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
   * rehydrate the shared `inProcessWrites` set so a resumed llm
   * dispatch on a pre-existing thread doesn't misread its own transcript
   * as a foreign one. `threadId` is derived from two sources unioned:
   *  - distinct `messages.node_id` (covers the common `thread_id == node_id` case)
   *  - distinct `json_extract(events.payload, '$.thread_id')` on `llm.start`
   *    rows (covers graph-level / edge-level thread ids that don't match
   *    any node id).
   * Completed/cancelled/halted runs are excluded — their threads will
   * never be dispatched again. Non-terminal pause states (paused,
   * paused_human) are included since they resume to the same thread on
   * `intent.resume`/`intent.human_input`.
   */
  listThreadsWithMessages(): Array<{ runId: string; threadId: string }>;

  // ─── Per-run aggregates
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

  // ─── Outputs index (read)
  /** All output rows for a run, in (node_id, iteration ASC) order.
   * Each row carries the pre-parsed struct as a JSON string. */
  getOutputsForRun(runId: string): Array<{ nodeId: string; iteration: number; struct: string }>;
  /** Latest-iteration output struct for a specific node, or null. */
  getLatestOutput(runId: string, nodeId: string): string | null;

  // ─── Blobs (raw read)
  /** Read a blob by sha256. Returns `null` when the file is absent (not yet
   *  written or already GC'd). Used by `materializeRouting` callers to resolve
   *  `$fragua_blob` refs in `routing.inputs`. */
  readBlob(sha: string): Uint8Array | null;

  // ─── Artifacts (read)
  getArtifact(scope: ArtifactScope): Uint8Array;
  getArtifactRef(scope: ArtifactScope): ArtifactRef | null;
  /** Every artifact a run produced, oldest-first (metadata only — the bytes
   * come from `getArtifact(scope)`). Empty when the run has none. */
  listArtifacts(runId: string): ArtifactListRow[];
  findDoneForIntent(runId: string, idempotencyKey: string): ArtifactRef | null;

  // ─── Workflow catalog (read)
  getWorkflow(sha: string): WorkflowRow | null;
  /** Distinct `cwd` values across `run_state` ordered by most-recent
   * activity. Powers UI project listings under the harness-by-default
   * model where projects are emergent paths. NULL `cwd` rows are
   * excluded. */
  listCwds(): Array<{ cwd: string; lastUpdatedAt: number; runCount: number }>;
  listProjects(): Array<{
    projectId: string;
    projectName: string;
    cwdHint: string | null;
    lastUpdatedAt: number;
    runCount: number;
  }>;
}

export interface IAnalyticsReader {
  /**
   * KPI totals for the analytics dashboard window: run count + total
   * cost + token sums (input / output / cache read / cache write).
   * `enqueued_at`-anchored — a run that started yesterday and finished
   * today bucket-counts as yesterday. Pass `window.cwd` to scope every
   * helper on this reader to one project root (exact `run_state.cwd`
   * match); omit it to aggregate across every project.
   */
  getKpiTotals(window: AnalyticsWindow): KpiTotalsRow;
  /** Per-bucket run counts split by lifecycle status. One column per
   *  status so the chart stacks without client-side re-derivation. */
  getRunsByBucket(window: BucketedWindow): RunsByBucketRow[];
  /** Per-bucket spend with input / output cost split. Falls back to a
   *  token-ratio split for runs predating the cost-split metrics; 50/50
   *  as a last resort. */
  getSpendByBucket(window: BucketedWindow): SpendByBucketRow[];
  /** Per-bucket fresh-token totals (input + output, excludes cache). */
  getTokensByBucket(window: BucketedWindow): TokensByBucketRow[];
  /** Per-bucket cache-token totals (read hits + write priming). */
  getCacheByBucket(window: BucketedWindow): CacheByBucketRow[];
  /** Outcomes donut: status → count over the window. */
  getHaltDistribution(window: AnalyticsWindow): HaltDistributionRow[];
  /** Per-model spend pivot. `metrics.models` is keyed by model name with
   *  `{ tokens, costUsd }` entries; SQL pivots inline via `json_each`. */
  getModelDistribution(window: AnalyticsWindow): ModelDistributionRow[];
  /** Most-run workflows in the window joined to `workflows.name`. */
  getTopWorkflows(window: AnalyticsWindow, limit: number): TopWorkflowRow[];
  /** Minimum `enqueued_at` across runs matching the analytics window +
   *  filters. `null` when no rows match. Drives WindowSelector option
   *  filtering: lastN options are shown only when the data span is >= N
   *  days. */
  getFirstRunAt(window: AnalyticsWindow): number | null;
  /** Distinct `(scope, name[, cwd])` identities across `run_state` for
   *  the workflow selector on `/analytics`. Sha collapses (every edit
   *  of `research.yaml` shares one row); `path` and `ephemeral` runs
   *  are excluded. */
  getWorkflowDirectory(opts: { cwd?: string }): WorkflowDirectoryRow[];
  /** Newest-first paginated run-id scan matching the analytics filters
   *  (workflow / halt category / model). Cursor encodes `(enqueued_at,
   *  run_id)` for stable pagination across same-ms inserts. */
  getDrilldownPage(filters: DrilldownFilters, opts: { limit: number; cursor?: string | undefined }): DrilldownPage;
  /** Cross-status totals for the `/metrics/global` route. `sinceMs`
   *  filters by `run_state.updated_at`. Cheap (covered by index). */
  getGlobalMetricsTotals(opts: { sinceMs: number }): GlobalMetricsTotalsRow;
  /** Per-model breakdown over the same window. */
  getGlobalModelBreakdown(opts: { sinceMs: number }): GlobalModelBreakdownRow[];
}

/**
 * Recurring-run primitive. A row in `schedules` carries the
 * (workflow_ref, cwd, interval_ms, optional input) triple plus a
 * `nextFireAt` cursor; the daemon's schedule-dispatcher fiber selects
 * rows where `next_fire_at <= now AND paused_at IS NULL` once per
 * minute and fires runs by calling `enqueueRun` with `scheduleId` set.
 *
 * `workflowRef` is the workflow name or path as a string — NOT a sha.
 * Resolution happens at fire time so schedules survive workflow edits;
 * if the file is missing or fails to validate, the dispatcher records
 * `fact.schedule_invalid_workflow` and auto-pauses.
 */
export type ScheduleOverlapPolicy = "skip" | "queue" | "concurrent";

export interface Schedule {
  id: string;
  workflowRef: string;
  cwd: string;
  /** Project IDENTITY the schedule belongs to (see `EnqueueRunParams`).
   * Fired runs inherit it; `cwd` is the spawn-location hint, resolved at
   * fire time. */
  projectId: string;
  intervalMs: number;
  intervalText: string;
  /** Run title stamped on every fired run. `null` when the schedule has no
   * description. Set by `--title` on `fragua schedule add`. */
  title: string | null;
  overlapPolicy: ScheduleOverlapPolicy;
  nextFireAt: number;
  lastFireAt: number | null;
  lastRunId: string | null;
  pausedAt: number | null;
  /** Why the schedule was auto-paused (the latest
   * `fact.schedule_invalid_workflow` audit error). Populated only while
   * `pausedAt` is set — a stale error on a since-resumed schedule is noise.
   * `null` for operator pauses with no recorded cause. */
  lastError: string | null;
  createdAt: number;
}

export interface CreateScheduleParams {
  id: string;
  workflowRef: string;
  cwd: string;
  /** Project IDENTITY. Resolved at the CLI/server boundary; falls back to
   * `cwd` when omitted so the NOT NULL column is always satisfied. */
  projectId?: string;
  intervalMs: number;
  intervalText: string;
  title?: string;
  overlapPolicy?: ScheduleOverlapPolicy;
  /** When true (default), `nextFireAt = now`. When false,
   * `nextFireAt = now + intervalMs` so the first fire waits a full
   * interval. Mirrors the CLI's `--no-fire-on-create` flag. */
  fireOnCreate?: boolean;
}

export interface IDaemonCoordinator {
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
  /**
   * Newest process-lifecycle row (`daemon.started` / `daemon.stopped`),
   * or `null` when no daemon has ever run against this store. A
   * `daemon.started` result with no later stop means the prior daemon
   * crashed hard — it never reached its shutdown append.
   */
  latestDaemonLifecycleEvent(): DaemonEventRow | null;

  // ─── Daemon lock
  acquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  forceAcquireDaemonLock(pid: number, hostname: string): DaemonLockResult;
  heartbeatDaemonLock(pid: number): void;
  releaseDaemonLock(pid: number): void;
  currentDaemonLock(): DaemonLockRow | null;
  currentServerEndpoint(): ServerEndpointRow | null;
  setServerEndpoint(args: { url: string; port: number; pid: number; version: string | null }): void;
  clearServerEndpoint(pid: number): void;

  // ─── Schedules
  /**
   * Insert a new schedule row. Caller mints `id` (e.g. `sch_<rand>`).
   * `nextFireAt` is set from `fireOnCreate`: true → now, false →
   * `now + intervalMs`. Audit row (`intent.schedule_create`) is the
   * caller's responsibility — the route layer writes one via
   * `appendDaemonEvent`.
   */
  createSchedule(params: CreateScheduleParams, now: number): Schedule;
  /** Single row by id, or `null` if missing. */
  getSchedule(id: string): Schedule | null;
  /** All schedules for `cwd` (or every schedule when `cwd` is
   *  undefined), ordered by `created_at ASC`. */
  listSchedules(opts?: { cwd?: string }): Schedule[];
  /** Schedules where `next_fire_at <= now AND paused_at IS NULL`,
   *  ordered by `next_fire_at ASC`. Powers the daemon's tick loop. */
  getDueSchedules(now: number): Schedule[];
  /** Mark a schedule paused. Idempotent: re-pause is a no-op. */
  pauseSchedule(id: string, now: number): void;
  /** Clear `paused_at` and re-anchor `next_fire_at = now + intervalMs`.
   *  Per the proposal: resume must NOT retroactively contradict the
   *  pause window, so no catch-up fire is emitted. */
  resumeSchedule(id: string, now: number): void;
  /** Hard `DELETE FROM schedules WHERE id = ?`. Past runs retain their
   *  `schedule_id` for lineage. */
  deleteSchedule(id: string): void;
  /**
   * Atomically advance after a successful fire: set `last_fire_at = now`,
   * `last_run_id = runId`, `next_fire_at = now + interval_ms`. Anchored
   * to actual fire time per proposal §Daemon dispatcher.
   */
  recordScheduleFire(scheduleId: string, runId: string, now: number): void;
  /**
   * Advance `next_fire_at = now + interval_ms` without recording a fire.
   * Used on `overlap=skip` skip-paths so the dispatcher doesn't busy-loop
   * on the same due row.
   */
  recordScheduleSkipped(scheduleId: string, now: number): void;
  /** Return the last `limit` runs fired by `scheduleId`, newest-first.
   *  Powers the health stripe in `fragua schedule list`. */
  getScheduleRuns(scheduleId: string, limit: number): Array<{ runId: string; status: string; enqueuedAt: number }>;
}

/**
 * Built-in provider credentials.
 *
 * One row per `provider` id; the JSON `payload` carries the full
 * AuthCredential object (api_key form or OAuthCredentials). The
 * `kind` discriminator is denormalised from `payload.type` so
 * post-mortems can `SELECT provider, kind FROM provider_credentials`
 * without JSON-parsing. `payload` typing stays `unknown` at this
 * layer — the agent package owns the AuthCredential shape and keeps
 * the store free of pi-ai types.
 */
export interface ProviderCredentialRow {
  provider: string;
  kind: "api_key" | "oauth";
  payload: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface IProviderCredentialStore {
  /** Single row by provider id, or `null` if missing. `payload` is
   *  parsed JSON. */
  getProviderCredential(provider: string): ProviderCredentialRow | null;
  /** All rows ordered by provider ASC. Cheap (full scan; <20 rows in
   *  practice). */
  listProviderCredentials(): ProviderCredentialRow[];
  /** Upsert. On conflict, `created_at` is preserved and `updated_at`
   *  advances. `payload` must already be a JSON-serialised string;
   *  serialisation happens in the caller per invariant I1 (no
   *  `JSON.stringify` inside the write txn). */
  upsertProviderCredential(args: { provider: string; kind: "api_key" | "oauth"; payload: string }): void;
  /** Hard delete. No-op when the row is absent. */
  deleteProviderCredential(provider: string): void;
}

/**
 * Custom-provider config blobs.
 *
 * One row per `provider` id; the JSON `config` body carries the
 * per-provider definition (baseUrl, headers, compat, models,
 * modelOverrides) — the `ProviderConfigSchema` shape from
 * `@fragua/agent` minus the `apiKey` field. Credentials always come
 * from `provider_credentials`. Per-row Ajv validation lives in
 * `ModelRegistry.loadCustomModels` so one corrupt provider can be
 * skipped without poisoning sibling rows.
 */
export interface ProviderConfigRow {
  provider: string;
  /** Parsed JSON. The agent layer owns the per-provider schema; the
   *  store keeps `unknown` so it doesn't pull pi-ai types. */
  config: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface IProviderConfigStore {
  /** Single row by provider id, or `null` if missing. `config` is
   *  parsed JSON. */
  getProviderConfig(provider: string): ProviderConfigRow | null;
  /** All rows ordered by provider ASC. Cheap (full scan; <20 rows in
   *  practice). */
  listProviderConfigs(): ProviderConfigRow[];
  /** Upsert. On conflict, `created_at` is preserved and `updated_at`
   *  advances. `config` must already be a JSON-serialised string;
   *  serialisation happens in the caller per invariant I1 (no
   *  `JSON.stringify` inside the write txn). */
  upsertProviderConfig(args: { provider: string; config: string }): void;
  /** Hard delete. No-op when the row is absent. */
  deleteProviderConfig(provider: string): void;
  /** Cheap (single-query) revision watermark for caches that want to
   *  invalidate when another process mutates `provider_config`.
   *  Pair of `(maxUpdatedAt, rowCount)` — rowCount catches deletes
   *  that don't raise any timestamp. Readers compare against the pair
   *  they saw at last reload. */
  getProviderConfigRevision(): { maxUpdatedAt: number; rowCount: number };
}

/**
 * Composite store contract — backward-compatible alias for the original
 * `IEventStore` shape. New code should depend on the narrowest sub-
 * interface that fits its needs (e.g. analytics routes only need
 * `IAnalyticsReader`, the daemon supervisor only needs `IDaemonCoordinator`).
 */
export type IEventStore = IEventWriter &
  IEventReader &
  IAnalyticsReader &
  IDaemonCoordinator &
  IProviderCredentialStore &
  IProviderConfigStore;
