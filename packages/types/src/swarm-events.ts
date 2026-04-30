// Typed unions for swarm's event log — intent events (writer: "web"),
// fact events (writer: "daemon"), and the wire envelope used by both
// per-run and global SSE/REST endpoints.
//
// These live in @swarm/types (not @swarm/store) so the web client can
// import them and get typed payloads on the global feed without pulling
// the SQLite-backed store into its compile graph. @swarm/store re-
// exports them so existing daemon/server callsites stay unchanged.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Lifecycle states for a run. The `paused_provider_error` and
 * `quarantined` states are operator-actionable; the rest are
 * automatic. Mirrored by `run_state.status` (CHECK constraint in
 * schema.sql) and the daemon's intent fold. */
export type RunStatus =
  | "queued"
  | "running"
  | "paused_hitl"
  | "paused_provider_error"
  | "completed"
  | "cancelled"
  | "halted"
  | "quarantined";

/** Who appended the event. Web writes intents (operator actions);
 * daemon writes facts (run lifecycle, observability). */
export type EventWriter = "daemon" | "web";

export type HaltReason = "budget" | "max_loops" | "abort_loop" | "schema_drift" | "error" | "aborted_exit";

export type QuarantineReason = "orphan_side_effect" | "other";

/** pi-agent-core role passthrough, matching `AgentMessage["role"]`. */
export type MessageRole = AgentMessage["role"];

// ─────────────── Intent events (writer: "web", no OCC) ───────────────

export type IntentEvent =
  | { type: "intent.run_enqueued"; payload: { workflowSha: string; priority?: number } }
  | { type: "intent.steering_requested"; payload: { text: string } }
  | { type: "intent.pause_requested"; payload: Record<string, never> }
  | { type: "intent.cancel_requested"; payload: { reason?: string } }
  | { type: "intent.hitl_input"; payload: { selected: string; note?: string } }
  | { type: "intent.resume"; payload: { note?: string } }
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

/**
 * Payload-shape contract for fact events: every payload must serialise
 * comfortably below the per-event byte cap enforced at insert time
 * (currently 4 KB; see `MAX_EVENT_PAYLOAD_BYTES` in @swarm/store). Bulky
 * free-form strings (LLM output, prompts, large artefact snapshots) DO
 * NOT belong in fact payloads — push them to the `messages` table or to
 * an `artifacts` row and reference by sha or `(node, iteration, key)`.
 *
 * Operator-supplied intents (`intent.steering_requested.text`,
 * `intent.hitl_input.input`, etc.) flow through the cap too; the
 * server translates `PayloadTooLargeError` to a 413 so callers see a
 * typed `code: "payload_too_large"` instead of a 500.
 */
export type FactEvent =
  | {
      type: "fact.run_started";
      payload: { workflowSha: string; schemaVersion: number; startNode: string };
    }
  | {
      type: "fact.dispatch_started";
      payload: {
        nodeId: string;
        iteration: number;
        /** Why this dispatch is starting. "fresh" = first dispatch of the
         * run; the others = resuming from the named prior state. Lets
         * analytics distinguish "ran straight through" from "had to be
         * woken up after X". */
        resumeOf: "fresh" | "crash" | "paused_hitl" | "paused_provider_error" | "quarantined";
      };
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
        /** USD cost split between input and output tokens (per pi-ai's
         * `usage.cost.input` / `usage.cost.output`). Optional for
         * back-compat with pre-split runs; reducer defaults to 0. */
        inputCostUsd?: number;
        outputCostUsd?: number;
        /** Input/output/cache split. Optional so older runs (pre-split)
         * still round-trip through replay; the reducer defaults missing
         * fields to 0 so totals never NaN. */
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        /** Optional: LLM provider model id, e.g. "gemini-1.5-pro". */
        modelName?: string;
        nextNode: string;
        /** Outcome status the handler (or edge selector) decided — lets the
         * UI distinguish "completed OK" from "completed with outcome=fail"
         * without walking `edge.selected` / `fact.run_halted`. */
        outcomeStatus?: "success" | "partial_success" | "fail" | "retry" | "skipped";
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
        /** Partial input/output USD split for work before the abort. */
        partialInputCostUsd?: number;
        partialOutputCostUsd?: number;
        /** Partial split for work done before the abort. Optional for
         * back-compat with pre-split runs. */
        partialInputTokens?: number;
        partialOutputTokens?: number;
        partialCacheReadTokens?: number;
        partialCacheWriteTokens?: number;
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
  | {
      type: "fact.run_paused_hitl";
      payload: {
        nodeId: string;
        label: string;
        options: Array<{ key: string; label: string; to: string }>;
      };
    }
  | {
      type: "fact.run_paused_provider_error";
      payload: {
        nodeId: string;
        httpStatus: number | null;
        provider: string;
        errorMessage: string;
      };
    }
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
  | {
      type: "fact.run_requeued_after_crash";
      payload: {
        prevNode?: string;
        /** Last `daemon_lock.heartbeat_at` recorded by the dying daemon
         * before the reaper took over. Heartbeats fire every ~5s, so
         * this is a tight upper bound on real active time and the
         * reducer uses `lastAliveAt - dispatchStartedAt` to credit the
         * pre-crash span. Undefined on the clean-acquire path (no
         * stale lock) — the reducer drops the span in that case. */
        lastAliveAt?: number;
      };
    }
  | {
      type: "fact.handler_timeout_leaked";
      payload: { nodeId: string; leakedAt: number };
    }
  | { type: "fact.daemon_takeover"; payload: { reclaimedFrom: number; at: number } };

export type FactType = FactEvent["type"];

/** Discriminated union over every typed event swarm emits. */
export type AnyEvent = IntentEvent | FactEvent;
export type AnyEventType = AnyEvent["type"];

// ─────────────── Daemon events (process / infrastructure scope) ───────────

/**
 * Daemon-level events: process lifecycle, sweep activity, reaper
 * takeovers, GC, leak detection, worktree provisioning. Persisted in
 * the dedicated `daemon_events` table (not `events`) because many
 * entries are global — no run scope — and they must not interleave
 * into the per-run `seq` space the reducer projects.
 *
 * Same 4 KB payload cap as fact events; payloads stay flat and small.
 */
export type DaemonEvent =
  | { type: "daemon.started"; payload: { pid: number; hostname: string } }
  | {
      type: "daemon.stopped";
      payload: { pid: number; reason: "clean" | "leak_limit" | "signal" | "error"; detail?: string };
    }
  | {
      type: "daemon.reaper_took_over";
      payload: { priorPid: number; priorHostname: string; priorHeartbeatAt: number; staleForMs: number };
    }
  | {
      type: "daemon.sweep_completed";
      payload: { requeued: number; quarantined: number; durationMs: number };
    }
  | { type: "daemon.blob_gc_completed"; payload: { deleted: number; durationMs: number } }
  | {
      type: "daemon.leak_detected";
      payload: { runId: string; nodeId: string; count: number; ceiling: number };
    }
  | { type: "daemon.worktree_provisioned"; payload: { runId: string; ok: boolean; errorDetail?: string } };

export type DaemonEventType = DaemonEvent["type"];

export const ALL_DAEMON_EVENT_TYPES: readonly DaemonEventType[] = [
  "daemon.started",
  "daemon.stopped",
  "daemon.reaper_took_over",
  "daemon.sweep_completed",
  "daemon.blob_gc_completed",
  "daemon.leak_detected",
  "daemon.worktree_provisioned",
];

/** Wire shape for `daemon_events` rows. `seq` is the AUTOINCREMENT
 * primary key of the `daemon_events` table — disjoint from the per-run
 * `seq` space. `runId` is set for run-scoped daemon events
 * (leak_detected, worktree_provisioned); global lifecycle / sweep / GC
 * events leave it undefined. */
export type DaemonEventEnvelope = {
  seq: number;
  ts: number;
  runId?: string;
} & DaemonEvent;

// ─────────────── Wire envelope ───────────────

/** Common envelope fields that wrap every event on the wire — both
 * the per-run REST/SSE endpoints and the global feed return this
 * shape. The `seq` is per-run (monotonic from 1 inside a run); the
 * `(runId, seq)` pair is globally unique. */
export interface EventEnvelope {
  runId: string;
  seq: number;
  ts: number;
  writer: EventWriter;
}

/**
 * Wire shape of an event coming off `GET /events`, `GET /events/stream`,
 * or `GET /runs/:id/events` — envelope + typed discriminated union of
 * the payload. Consumers narrow on `type` to access typed `payload`:
 *
 * ```ts
 * if (e.type === "fact.run_halted") e.payload.reason; // HaltReason
 * ```
 *
 * The discriminated union excludes observability events (`agent.*`,
 * `llm.*`, `tool.*`, `cost.recorded`) — those use the broader
 * `RawEvent` shape because their payloads are pi-agent-core/pi-ai
 * specific and not central to the swarm contract.
 */
export type FeedEvent = EventEnvelope & AnyEvent;

/**
 * Read-side projection for the per-run event endpoints, which mix
 * intents, facts, AND observability events under a single `seq` space.
 * The `type` is left as `string` because observability event types
 * (e.g. `agent.message_update`, `llm.text_delta`) aren't enumerated in
 * `AnyEventType`. Use {@link FeedEvent} when you want the typed
 * payload narrowing.
 */
export interface RawEvent extends EventEnvelope {
  type: string;
  payload: unknown;
}

/**
 * Operator-relevant event kinds for the global Home feed. Facts only —
 * the things that *happened*. Operator intents (pause, cancel, steer,
 * resume, hitl_input, unquarantine, priority) are intentionally excluded
 * because each request either has a corresponding fact that lands when
 * it takes effect (pause→paused, resume→resumed, cancel→cancelled), or
 * is a request the daemon may still be working through. Showing the
 * intent rows in addition to the fact rows just duplicates signal.
 *
 * Excludes node-level facts, side-effect facts, message_appended, and
 * the entire observability family (`agent.*`, `llm.*`, `tool.*`,
 * `cost.recorded`) because at sustained run rates those would drown
 * the feed.
 *
 * Both `GET /events` (backfill) and `GET /events/stream` (live SSE)
 * filter through this list on the server side. Adding a new kind here
 * is the only step needed to surface it on Home.
 */
export const FEED_EVENT_KINDS: readonly AnyEventType[] = [
  // Run lifecycle facts — every transition that flips status.
  "fact.run_started",
  "fact.run_completed",
  "fact.run_paused_hitl",
  "fact.run_paused_provider_error",
  "fact.run_resumed",
  "fact.run_cancelled",
  "fact.run_halted",
  "fact.run_quarantined",
  "fact.run_requeued_after_crash",
  // System health
  "fact.daemon_takeover",
  "fact.handler_timeout_leaked",
];
