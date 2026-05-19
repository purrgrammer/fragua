// Typed unions for swarm's event log — intent events (writer: "web"),
// fact events (writer: "daemon"), daemon-scope events, and the wire
// envelopes used by per-run and global SSE/REST endpoints.
//
// Lives in @swarm/types (not @swarm/store or @swarm/core) so the web
// client can import typed payloads without pulling the SQLite-backed
// store or core's pure-reducer dependency tree into its compile graph.
// @swarm/store re-exports the relevant pieces so existing daemon/server
// callsites stay unchanged.

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ─────────────── EventType (string union for SSE / log filters) ───────────────

export type EventType =
  // Run lifecycle
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
  // Node lifecycle
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "node.retrying"
  | "node.skipped"
  // Edge selection
  | "edge.selected"
  // Checkpoint
  | "checkpoint.saved"
  // Interview
  | "interview.started"
  | "interview.completed"
  | "interview.timeout"
  // Agent layer (bridged from pi)
  | "agent.start"
  | "agent.end"
  | "agent.turn_start"
  | "agent.turn_end"
  | "agent.message_start"
  | "agent.message_update"
  | "agent.message_end"
  | "agent.warning"
  | "agent.info"
  // LLM layer
  | "llm.start"
  | "llm.text_delta"
  | "llm.text_end"
  | "llm.thinking_delta"
  | "llm.thinking_end"
  | "llm.toolcall_delta"
  | "llm.toolcall_end"
  | "llm.done"
  | "llm.error"
  // Tool layer
  | "tool.execution_start"
  | "tool.execution_update"
  | "tool.execution_end"
  // Steering (legacy — replay only)
  | "steering.requested"
  | "steering.injected"
  // Control channel (steer / pause / resume / cancel)
  | "control.requested"
  | "control.applied"
  | "control.rejected"
  // Summariser
  | "summary.started"
  | "summary.text_delta"
  | "summary.completed"
  | "run.title_generated"
  // Budget
  | "budget.warn"
  | "budget.stop"
  // Cost
  | "cost.recorded"
  // Sub-agent boundaries (observability-only). Bracket the slice of
  // events produced by an inline `agent`-tool spawn on the parent's
  // stream; every event in between carries `subagent_id` on its
  // payload. `subagent.resumed` fires when the daemon respawns a
  // sub-agent under a deterministic subagent_id after a crash — it
  // either announces transcript hydration (`reason:
  // "transcript_hydrated"`) or short-circuits to `subagent.end` when
  // the persisted transcript was already complete
  // (`reason: "already_completed"`).
  | "subagent.start"
  | "subagent.end"
  | "subagent.resumed";

/** Every EventType value as a const array, suitable for iteration.
 * Consumers like `EventSource.addEventListener(<type>, ...)` register
 * handlers per type up front; sharing this list avoids drift between
 * the union and the registered names. Keep in sync with `EventType`
 * above — a CI test pins the mapping. */
export const ALL_EVENT_TYPES: readonly EventType[] = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "node.started",
  "node.completed",
  "node.failed",
  "node.retrying",
  "node.skipped",
  "edge.selected",
  "checkpoint.saved",
  "interview.started",
  "interview.completed",
  "interview.timeout",
  "agent.start",
  "agent.end",
  "agent.turn_start",
  "agent.turn_end",
  "agent.message_start",
  "agent.message_update",
  "agent.message_end",
  "agent.warning",
  "agent.info",
  "llm.start",
  "llm.text_delta",
  "llm.text_end",
  "llm.thinking_delta",
  "llm.thinking_end",
  "llm.toolcall_delta",
  "llm.toolcall_end",
  "llm.done",
  "llm.error",
  "tool.execution_start",
  "tool.execution_update",
  "tool.execution_end",
  "steering.requested",
  "steering.injected",
  "control.requested",
  "control.applied",
  "control.rejected",
  "summary.started",
  "summary.text_delta",
  "summary.completed",
  "run.title_generated",
  "budget.warn",
  "budget.stop",
  "cost.recorded",
  "subagent.start",
  "subagent.end",
  "subagent.resumed",
];

// ─────────────── Status / pause / halt / quarantine enums ───────────────

/** Lifecycle states for a run. Three non-terminal pause statuses,
 * partitioned 1:1 against the operator-attention category:
 *
 * - `paused` — operator must act; reason on `fact.run_paused.payload.reason`
 * - `paused_auto` — daemon owes a clock tick; operator may short-circuit via `intent.resume`
 * - `paused_human` — workflow asked a question; answer via `intent.human_input`
 *
 * Mirrored by `run_state.status` (CHECK constraint in schema.sql) and
 * the daemon's intent fold. See {@link PauseReason} for the reason
 * partition; status follows reason 1:1. */
export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "paused_human"
  | "paused_auto"
  | "completed"
  | "cancelled"
  | "halted"
  | "quarantined";

/** Reason discriminator on `fact.run_paused`. Status follows reason —
 * the reducer reads `payload.reason` and projects without consulting
 * any other field. Partition:
 *
 * **→ `paused` (operator must act)**
 * - `operator` — operator hit pause from the UI/CLI; resume to continue.
 * - `provider_error` — manual-class provider HTTP failure (400/401/403/
 *   404/413/422). Operator rotates creds / fixes request; resume retries.
 * - `payment_required` — 402 from the provider; operator tops up
 *   off-ledger and resumes.
 * - `budget` — local cap (`graph.budget_*` / `node.max_*`) hit; operator
 *   raises the cap via `intent.budget_adjusted` and resumes.
 *
 * **→ `paused_auto` (daemon owes a clock tick)**
 * - `provider_retry` — auto-retryable provider transport error
 *   (408/429/5xx/529/network); wake-pending sweeps `auto_resume_at`.
 * - `handler_retry` — handler returned `outcomeStatus="retry"`; engine
 *   scheduled a backoff window per attractor §3.5/§3.6.
 *
 * Adding a new reason is a one-line addition here plus a UI renderer
 * body branch (`Record<PauseReason, ReasonRenderer>` exhaustiveness
 * fires until the branch lands). No new status, no schema migration.
 * Stage 3 of the proposal will add `max_retries`, `goal_gate`,
 * `max_loops`, `abort_loop`, `provider_exhausted`. PR 4 will add
 * `timeout_retry`. */
export type PauseReason =
  | "operator"
  | "provider_error"
  | "payment_required"
  | "budget"
  | "max_retries"
  | "goal_gate"
  | "max_loops"
  | "abort_loop"
  | "provider_exhausted"
  | "provider_retry"
  | "handler_retry"
  | "timeout_retry";

/** Reasons that project to `paused_auto` (daemon timer). Everything
 * else in {@link PauseReason} projects to `paused` (operator must
 * act). Single source of truth for the reducer + wake-pending. */
export const AUTO_WAKE_PAUSE_REASONS: ReadonlySet<PauseReason> = new Set<PauseReason>([
  "provider_retry",
  "handler_retry",
  "timeout_retry",
]);

/** Who appended the event. Web writes intents (operator actions);
 * daemon writes facts (run lifecycle, observability). */
export type EventWriter = "daemon" | "web";

/** Terminal halt reasons. After Stage 3 of recoverable-budget-pause.md
 * the previously-recoverable-class halts (`max_loops`, `abort_loop`,
 * `goal_gate_unsatisfied`, `max_retries_exceeded`, `provider_exhausted`)
 * have moved to {@link PauseReason} so operators can grant N more
 * attempts. What remains here is genuinely terminal: schema/engine
 * failures, the workflow author's `<abort>` sentinel, the opt-in
 * `budget_policy="stop"` path, and the watchdog-cap exhaustion that
 * paused-class `timeout_retry` escalates to. */
export type HaltReason =
  | "budget"
  | "schema_drift"
  | "error"
  | "aborted_exit"
  | "occ_exhausted"
  | "timeout_exhausted"
  /** Routing node's llm turn ended without an isolated call to the
   * synthesised `route` tool. See docs/proposals/llm-routing.md D3. */
  | "route_not_picked"
  /** Routing node's `route` tool call shared an assistant response with
   * other tool calls — side-effect isolation violation. */
  | "route_call_not_isolated"
  /** Handler reported a route/outcome and no outgoing edge matched.
   * Validator should prevent this statically; runtime backstop. */
  | "edge_no_match";

export type QuarantineReason = "orphan_side_effect" | "other";

/** pi-agent-core role passthrough, matching `AgentMessage["role"]`. */
export type MessageRole = AgentMessage["role"];

// ─────────────── Intent events (writer: "web", no OCC) ───────────────

export type IntentEvent =
  | { type: "intent.run_enqueued"; payload: { workflowSha: string; priority?: number } }
  | { type: "intent.steering_requested"; payload: { text: string } }
  | { type: "intent.pause_requested"; payload: Record<string, never> }
  | { type: "intent.cancel_requested"; payload: { reason?: string } }
  | { type: "intent.human_input"; payload: { route: string; note?: string } }
  | { type: "intent.resume"; payload: { note?: string } }
  | {
      type: "intent.unquarantine";
      payload: { resolution: "treat_as_done" | "retry" | "cancel"; note?: string };
    }
  | {
      type: "intent.priority_adjusted";
      payload: { newPriority: number; note?: string };
    }
  | {
      /** Operator raises a budget ceiling on a `paused{reason:"budget"}`
       * run. Recorded in `routing.budget_override.<scope>.<metric>` so
       * the next turn-boundary check sees the new ceiling. Web bundles
       * `intent.budget_adjusted` followed by `intent.resume` into one
       * "Raise & Resume" click; intents stay separate at the protocol
       * level so `intent.resume` remains naked across all pause reasons. */
      type: "intent.budget_adjusted";
      payload: {
        scope: "node" | "run";
        metric: "cost" | "tokens";
        newLimit: number;
        note?: string;
      };
    }
  | {
      /** Operator raises a node's `max_retries` cap on a
       * `paused{reason:"max_retries"}` run. Recorded in
       * `routing.max_retries_override.<nodeId>` so `resolveMaxRetries`
       * picks it up before consulting the static node attr. Cap-
       * adjustment intents follow the same Raise & Resume bundle
       * pattern as `intent.budget_adjusted`. */
      type: "intent.max_retries_adjusted";
      payload: { nodeId: string; newLimit: number; note?: string };
    }
  | {
      /** Operator raises `max_goal_gate_retries` on a
       * `paused{reason:"goal_gate"}` run. Recorded in
       * `routing.max_goal_gate_retries_override`; the goal-gate
       * resolver reads it before consulting the graph attr. */
      type: "intent.goal_gate_adjusted";
      payload: { newLimit: number; note?: string };
    }
  | {
      /** Operator raises the per-run dispatch ceiling on a
       * `paused{reason:"max_loops"}` run. Recorded in
       * `routing.max_loops_override`; the executor reads it on each
       * dispatch tick. */
      type: "intent.max_loops_adjusted";
      payload: { newLimit: number; note?: string };
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
 * `intent.human_input.route`, etc.) flow through the cap too; the
 * server translates `PayloadTooLargeError` to a 413 so callers see a
 * typed `code: "payload_too_large"` instead of a 500.
 */
export type FactEvent =
  | {
      type: "fact.run_started";
      payload: {
        workflowSha: string;
        schemaVersion: number;
        startNode: string;
        /** HEAD sha of the run's worktree at provision time. Set when a
         * `WorktreeProvisioner` is configured; absent for runs with a
         * shared `LocalEnvironment` or no provisioner. Replay reads this
         * to reconstruct the starting tree even after the worktree dir
         * and `swarm/runs/<runId>` branch are gone. */
        baseGitSha?: string;
      };
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
        resumeOf: "fresh" | "crash" | "paused" | "paused_human" | "paused_auto" | "quarantined";
      };
    }
  | {
      type: "fact.node_started";
      payload: {
        nodeId: string;
        iteration: number;
      };
    }
  | {
      type: "fact.node_completed";
      payload: {
        nodeId: string;
        iteration: number;
        tokens: number;
        costUsd: number;
        /** USD cost split across the four token buckets (per pi-ai's
         * `usage.cost.{input,output,cacheRead,cacheWrite}`). Optional
         * for back-compat with pre-split runs; reducer defaults to 0. */
        inputCostUsd?: number;
        outputCostUsd?: number;
        cacheReadCostUsd?: number;
        cacheWriteCostUsd?: number;
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
        outcomeStatus?: "success" | "fail" | "retry";
        /** Present iff the source node declared `routes=` and the llm
         * agent exited via the synthesised `route` tool. The chosen route
         * name; the engine's Step-0 edge selector keys on this. */
        route?: string;
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
        /** Partial USD split for work before the abort, across all
         * four token buckets. */
        partialInputCostUsd?: number;
        partialOutputCostUsd?: number;
        partialCacheReadCostUsd?: number;
        partialCacheWriteCostUsd?: number;
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
      type: "fact.run_paused_human";
      payload: {
        nodeId: string;
        /** Operator-facing prompt rendered above the route buttons.
         * Sourced from the human node's `text=` attribute. */
        text: string;
        /** Declared route names, in DOT order. Each becomes one button;
         * button label resolves via the matching outgoing edge's
         * `label=` override, falling back to `humanize(route)`. */
        routes: string[];
      };
    }
  | {
      /** Unified pause fact, reason-discriminated. The reducer projects
       * `run_state.status` from `payload.reason`: reasons in
       * {@link AUTO_WAKE_PAUSE_REASONS} → `paused_auto` (daemon timer),
       * everything else → `paused` (operator must act).
       *
       * 402 routes to `reason:"payment_required"`; manual-class HTTP
       * failures (400/401/403/404/413/422) → `provider_error`;
       * auto-retryable transport (408/429/5xx/529/network) →
       * `provider_retry`. Local budget overruns route here when
       * `budget_policy="pause"` (default); `budget_policy="stop"`
       * keeps terminal halt semantics. */
      type: "fact.run_paused";
      payload:
        | { reason: "operator"; nodeId: string }
        | {
            reason: "provider_error";
            nodeId: string;
            httpStatus: number | null;
            provider: string;
            errorMessage: string;
          }
        | {
            reason: "payment_required";
            nodeId: string;
            provider: string;
            errorMessage: string;
          }
        | {
            reason: "budget";
            nodeId: string;
            scope: "node" | "run";
            metric: "cost" | "tokens";
            limit: number;
            actual: number;
          }
        | {
            /** Provider auto-retry. Daemon scheduled a backoff window;
             * `routing.internal.auto_resume_at` carries `resumeAt` so
             * wake-pending re-queues at the right moment. Operator may
             * short-circuit via `intent.resume`. */
            reason: "provider_retry";
            nodeId: string;
            httpStatus: number | null;
            provider: string;
            errorMessage: string;
            attempt: number;
            resumeAt: number;
          }
        | {
            /** Handler returned `outcomeStatus="retry"` (attractor §3.5/
             * §3.6). Concurrency slot released for the backoff window.
             * Wake-pending re-queues at `resumeAt`; the same node
             * re-dispatches because `fact.node_completed` already
             * pointed `nextNode` back at it. Operator may short-circuit
             * via `intent.resume`. */
            reason: "handler_retry";
            nodeId: string;
            attempt: number;
            delayMs: number;
            resumeAt: number;
            maxRetries: number;
          }
        | {
            /** Watchdog timeout (`maxMs` exceeded). System-initiated;
             * the prior dispatch's transcript stays on disk and the
             * resume re-dispatches with it intact. Bounded by
             * `routing.internal.timeout_retries.<nodeId>` — past the
             * cap (default 3) the run halts with
             * `fact.run_halted{reason:"timeout_exhausted"}`. See
             * docs/proposals/watchdog-timeout-pause-retry.md. */
            reason: "timeout_retry";
            nodeId: string;
            attempt: number;
            delayMs: number;
            resumeAt: number;
            maxAttempts: number;
            /** Wall-clock ms the handler ran for before the watchdog
             * fired (i.e. the node's resolved `maxMs`). Carried for the
             * UI banner so operators can read "watchdog at 30m" without
             * opening the graph. */
            attemptedMs: number;
          }
        | {
            /** Node's retry counter exhausted (handler returned
             * outcomeStatus="retry" past `max_retries`). Operator may
             * grant more retries via `intent.max_retries_adjusted`
             * (writes `routing.max_retries_override.<nodeId>`); naked
             * `intent.resume` grants exactly one more attempt at the
             * current cap. See recoverable-budget-pause.md Stage 3. */
            reason: "max_retries";
            nodeId: string;
            currentLimit: number;
            attempts: number;
          }
        | {
            /** Goal-gate retarget chain capped at
             * `max_goal_gate_retries`. Operator may grant more cycles
             * via `intent.goal_gate_adjusted` (writes
             * `routing.max_goal_gate_retries_override`). */
            reason: "goal_gate";
            gateNodeId: string;
            currentLimit: number;
          }
        | {
            /** Per-run dispatch ceiling exceeded. Operator may raise
             * via `intent.max_loops_adjusted` (writes
             * `routing.max_loops_override`); naked resume re-enters
             * with a fresh JS-local counter and the same effective
             * cap. */
            reason: "max_loops";
            currentLimit: number;
            dispatches: number;
          }
        | {
            /** Per-(nodeId) consecutive-abort counter saturated.
             * Usually a real bug, but operator may know the underlying
             * cause is fixed. Naked resume only — no per-run knob;
             * the abort-loop ceiling is daemon config. */
            reason: "abort_loop";
            nodeId: string;
            consecutiveAborts: number;
          }
        | {
            /** Provider auto-retry chain capped (5 attempts or 5
             * cumulative minutes, attractor §3.6). Naked resume
             * re-enters and starts a fresh chain. No per-run knob —
             * chain config is daemon-wide. */
            reason: "provider_exhausted";
            nodeId: string;
            attempts: number;
            cumulativeMs: number;
          };
    }
  | {
      /** Emitted on every auto-retry attempt that fires after a
       * `paused_auto{reason:"provider_retry"}` wake. One fact per
       * attempt — folding into a mutable chain on the pause fact would
       * violate fact immutability (I3). Operators query `WHERE
       * type='fact.provider_retry_attempted' AND run_id=X ORDER BY seq`
       * to see the retry chain. */
      type: "fact.provider_retry_attempted";
      payload: {
        nodeId: string;
        attempt: number;
        httpStatus: number | null;
        delayMs: number;
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
      payload: {
        reason: HaltReason;
        detail?: string;
        /** Set when `reason="occ_exhausted"`. Carries the OCC retry
         * context — count of consecutive `ConcurrencyError` failures,
         * the node + iteration where the storm hit, the last observed
         * `run_state.version`, and the type of fact whose append
         * couldn't land. Operators read this for post-mortem instead
         * of grepping the string detail. */
        occContext?: {
          count: number;
          nodeId: string;
          iteration: number;
          lastVersion: number;
          attemptedFactType: string;
        };
      };
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
  | { type: "fact.daemon_takeover"; payload: { reclaimedFrom: number; at: number } }
  | {
      /** Emitted by the executor's terminal-cleanup path after the
       * worktree's dispose() preserved a branch (because the working tree
       * had a non-empty `git status --porcelain`). Sets `run_state.branch`
       * so `swarm gc --branches` can later join the refspace against
       * terminated runs. Not emitted when dispose drops a clean tree
       * (no branch was created) or when the run had no worktree
       * provisioner. Lands AFTER the terminal status fact. */
      type: "fact.run_branched";
      payload: { branch: string };
    };

// Note: there are no dedicated `fact.subagent.*` events. Sub-agents
// are a tool implementation, not a run — they have no `run_state` row
// and no separate event stream. The two observability event types
// `subagent.start` / `subagent.end` (see EventType union above)
// bracket the slice; every event the sub-agent emits in between
// (`llm.start`, `llm.toolcall_*`, `cost.recorded`, `agent.turn_*`)
// carries `subagent_id` on its payload as a discriminator. Cost rolls
// into the parent's `metrics` through the existing accumulation path;
// the reducer doesn't filter on `subagent_id`. The bidirectional
// handle the parent LLM sees is `tool_name="agent"` plus the
// toolcall result's `data.subagent_id` — see SubagentStartData /
// SubagentEndData in @swarm/core/types/events for the bracket
// payloads.

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
  | { type: "daemon.worktree_provisioned"; payload: { runId: string; ok: boolean; errorDetail?: string } }
  // ─── Schedules (proposal: docs/proposals/scheduled-runs.md) ───
  // Schedules are global primitives — they fire workflows on a fixed
  // interval regardless of any one run's lifecycle. Their audit log
  // rides `daemon_events` (not the per-run `events` table) because at
  // the moment of `intent.schedule_create` no run yet exists, and
  // `fact.schedule_skipped` may fire without a corresponding run id.
  // When a fire produces a run, the daemon writes
  // `fact.schedule_fired` with `runId` set so consumers can join the
  // schedule timeline against the run timeline.
  | {
      type: "intent.schedule_create";
      payload: {
        scheduleId: string;
        workflowRef: string;
        cwd: string;
        intervalMs: number;
        intervalText: string;
        input?: string;
        overlapPolicy: "skip" | "queue" | "concurrent";
        fireOnCreate: boolean;
      };
    }
  | { type: "intent.schedule_pause"; payload: { scheduleId: string } }
  | { type: "intent.schedule_resume"; payload: { scheduleId: string } }
  | { type: "intent.schedule_delete"; payload: { scheduleId: string } }
  | { type: "fact.schedule_fired"; payload: { scheduleId: string; runId: string } }
  | {
      type: "fact.schedule_skipped";
      payload: { scheduleId: string; reason: "overlap" | "paused" };
    }
  | {
      // Emitted *before* the catch-up fire when ≥1 slot was missed —
      // see proposal §Catch-up policy. `missedIntervals` counts whole
      // intervals between `lastTargetAt` and `now`; `lastTargetAt` is
      // the original `next_fire_at` value that aged past `now`.
      type: "fact.schedule_late";
      payload: { scheduleId: string; missedIntervals: number; lastTargetAt: number };
    }
  | {
      type: "fact.schedule_invalid_workflow";
      payload: { scheduleId: string; error: string };
    };

export type DaemonEventType = DaemonEvent["type"];

export const ALL_DAEMON_EVENT_TYPES: readonly DaemonEventType[] = [
  "daemon.started",
  "daemon.stopped",
  "daemon.reaper_took_over",
  "daemon.sweep_completed",
  "daemon.blob_gc_completed",
  "daemon.leak_detected",
  "daemon.worktree_provisioned",
  "intent.schedule_create",
  "intent.schedule_pause",
  "intent.schedule_resume",
  "intent.schedule_delete",
  "fact.schedule_fired",
  "fact.schedule_skipped",
  "fact.schedule_late",
  "fact.schedule_invalid_workflow",
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
 * resume, human_input, unquarantine, priority) are intentionally excluded
 * because each request either has a corresponding fact that lands when
 * it takes effect (pause→paused, resume→resumed, cancel→cancelled), or
 * is a request the daemon may still be working through. Showing the
 * intent rows in addition to the fact rows just duplicates signal.
 *
 * Excludes node-level facts, side-effect facts, bookkeeping kinds
 * (run_branched, message_appended), and the
 * entire observability family (`agent.*`, `llm.*`, `tool.*`,
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
  "fact.run_paused_human",
  "fact.run_paused",
  "fact.provider_retry_attempted",
  "fact.run_resumed",
  "fact.run_cancelled",
  "fact.run_halted",
  "fact.run_quarantined",
  "fact.run_requeued_after_crash",
  // System health
  "fact.daemon_takeover",
  "fact.handler_timeout_leaked",
];
