// Event types. Immutable records written to the EventSink.
// See docs/SPEC.md §3.5.
//
// The string-literal `EventType` union lives in `@swarm/types/events`
// so web + agent + daemon can import it without pulling in core's
// pure-reducer dep tree. Envelope shapes (data payloads, EventPayloadMap,
// FactEvent / IntentEvent / ObservabilityEvent) stay here — they carry
// core-specific types (Outcome, FidelityMode, SummaryPurpose).

import type { EventType } from "@swarm/types";
import type { FidelityMode } from "./fidelity.ts";
import type { Outcome } from "./outcome.ts";

export type { EventType } from "@swarm/types";

/** Current event envelope version. Bumped when an incompatible field rename
 * or removal lands. Additive field changes do NOT bump this number; they're
 * picked up transparently by consumers that ignore unknown fields. */
export const EVENT_SCHEMA_VERSION = 1;

export interface Event {
  run_id: string;
  session_id?: string;
  node_id?: string;
  type: EventType;
  /** ISO-8601 timestamp. Tests may substitute a fixed clock. */
  timestamp: string;
  /** SHA of the workflow source for post-hoc reproducibility. */
  workflow_sha: string;
  /** Envelope version. Emitters stamp `EVENT_SCHEMA_VERSION`; pre-versioned
   * JSONL from older runs omits this field and consumers treat `undefined`
   * as `1` for back-compat. */
  schema_version?: number;
  data: Record<string, unknown>;
}

/** Typed convenience payloads for the most common events. */
export interface NodeCompletedData {
  outcome: Outcome;
  duration_ms: number;
  retry_count: number;
}

/**
 * Static inputs to a node — everything knowable before any substitution or
 * LLM call. Captured on `node.started` so a debugger can see the node's
 * configuration without re-parsing the DOT source. The *resolved* prompt
 * (post-substitution) is intentionally NOT here — it lives on `llm.start`
 * because loop/retry nodes resolve a different prompt per iteration.
 *
 * Values are optional because handlers without templates / context / tools
 * (start, exit, conditional, fan_in) simply omit them.
 */
export interface NodeStartedData {
  /** Handler key — `codergen`, `loop`, `wait.human`, `parallel`, ... */
  node_type?: string;
  /** Raw `node.attrs.prompt` before any substitution. */
  prompt_template?: string;
  /** Model hint from `node.attrs.llm_model` — authoritative binding is on `llm.start`. */
  model?: string;
  /** Provider hint from `node.attrs.llm_provider`. */
  provider?: string;
  /** Resolved thread id (see engine/fidelity.ts). */
  thread_id?: string;
  /** Resolved fidelity mode (see engine/fidelity.ts). */
  fidelity?: FidelityMode;
  /** Tool allowlist from `node.attrs.allowed_tools`. */
  allowed_tools?: string[];
  /** Tool denylist from `node.attrs.denied_tools`. */
  denied_tools?: string[];
  /** `node.attrs.context_files` — paths loaded into the system prompt. */
  context_files?: string[];
}

/** Per-file record captured alongside the assembled system prompt. The
 * raw bytes are intentionally not carried on the event envelope — the sha
 * plus a flag is enough for a replay consumer to decide whether the file
 * has drifted between a run and its replay. */
export interface ContextFileCapture {
  path: string;
  sha256: string;
  bytes: number;
  truncated: boolean;
  status: "ok" | "missing";
  error?: string;
}

/** Generation settings captured per LLM call. All fields optional because not
 * every provider honours every knob, and some settings (top_p, stop) are
 * left at provider defaults today. When node attrs like `reasoning_effort`
 * are resolved for a specific call, this is where they land. */
export interface LlmSettings {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  reasoning_effort?: "low" | "medium" | "high";
  stop?: string[];
}

/** Serialisable snapshot of a single message in the agent's conversation at
 * the moment the LLM call is issued. We keep `content` as `unknown` because
 * pi-ai content is a discriminated union (text / image / tool call / tool
 * result); the emitter stores it verbatim and the UI / replay consumer
 * narrows as needed. */
export interface MessageSnapshot {
  role: "user" | "assistant" | "toolResult";
  content?: unknown;
  timestamp?: number;
}

/** Read-only cumulative cost + token counters at the moment the LLM call
 * is issued. Populated by the executor from `run_state.metrics` plus the
 * ceilings configured on the graph / node attrs. Single source of truth
 * for "how much has the run spent by step N" — UIs render this without
 * summing every `cost.recorded` themselves. The `engine/budget-policy`
 * module enforces the ceilings at each turn boundary; this snapshot is
 * the read side of that machinery. */
export interface BudgetSnapshot {
  cumulative_cost_usd: number;
  cumulative_tokens: number;
  /** Node-level ceiling if `node.attrs.max_cost_usd` is set. */
  max_cost_usd?: number;
  /** Run-level ceiling if `graph.attrs.budget_usd` is set. */
  run_max_cost_usd?: number;
}

/**
 * Per-LLM-call record. Fires once per actual `backend.run()` invocation —
 * that means once for a codergen node, N times for a loop node with N
 * iterations, and zero times for non-LLM handlers. Carries the snapshot
 * of what the agent was actually asked so `events.jsonl` alone is enough
 * to reconstruct "what the agent saw at step N".
 */
export interface LlmStartData {
  provider?: string;
  model?: string;
  /** Fully substituted user prompt sent to the LLM. */
  prompt?: string;
  /** System prompt (context_files + configured system prompt) assembled
   * for this call. */
  system_prompt?: string;
  thread_id?: string;
  allowed_tools?: string[];
  denied_tools?: string[];
  /** Loop iteration metadata when the call originates from a loop handler. */
  iteration?: { n: number; max: number };
  /** Prior conversation turns visible to the agent at call time. Empty on a
   * fresh session; non-empty when a shared `thread_id` restored a prior
   * pi-agent-core session. */
  messages?: MessageSnapshot[];
  /** Generation settings resolved for this call. */
  settings?: LlmSettings;
  /** Per-file records for every path listed in `node.attrs.context_files`.
   * Order matches the input. Durable enough to detect drift between a run
   * and its replay (compare sha256 per path). */
  context_files?: ContextFileCapture[];
  /** Read-only budget snapshot. See `BudgetSnapshot`. */
  budget?: BudgetSnapshot;
  /** Tier-1 skill catalog shown to the model for this step. Parallel to
   * `context_files`: a per-SKILL.md sha256 + bytes record lets replay
   * detect drift. This is what was *advertised* — which skills the
   * model actually read is inferred from `tool.execution_*` events
   * targeting the catalog's `location` paths via the `read` tool. */
  skills?: SkillCatalogCapture[];
}

/** Per-skill capture record carried on `llm.start.skills[]`. Mirrors the
 * `ContextFileCapture` shape. `skill_dir` / `allowed_tools` etc. stay off
 * the wire — the replay harness can re-derive them from `location`. */
export interface SkillCatalogCapture {
  name: string;
  location: string;
  sha256: string;
  bytes: number;
  scope: "project" | "user";
  source_dir: string;
}

/** Why a summariser call was made.
 *
 * The concrete type lives in `./summariser.ts` (the port module); this
 * file re-exports the type alias so the event payloads can reference it
 * without pulling the port's functions into the event surface. See
 * docs/SPEC.md §3.5 for where each value shows up on `events.jsonl`. */
import type { SummaryPurpose } from "./summariser.ts";

/** Fires when the summariser starts an LLM call. The synthetic node_id on
 * the envelope (e.g. `__summary.title`, `__summary.plan`) lets the UI
 * render it as a lightweight step without it participating in graph
 * routing — `completed_nodes` / `node_outcomes` stay graph-only. */
export interface SummaryStartedData {
  purpose: SummaryPurpose;
  provider?: string;
  model?: string;
  /** Real node id that triggered this compression, when purpose="fidelity". */
  caller_node_id?: string;
  /** Iteration metadata if the caller is a loop (copied from the caller's
   * own `llm.start.iteration`). */
  iteration?: { n: number; max: number };
  /** The fidelity mode that caused the call (e.g. `summary:medium`). */
  fidelity?: FidelityMode;
}

/** Streaming delta from a summariser call. Fires N times between
 * `summary.started` and `summary.completed` so UIs can render the
 * title / narrative as it arrives rather than waiting for the full
 * call to resolve. Rides under the same synthetic node_id as its
 * bookends. */
export interface SummaryTextDeltaData {
  purpose: SummaryPurpose;
  delta: string;
  /** Monotonic index within this summariser call so a late-arriving
   * delta can be ordered correctly if the caller parallelises. */
  content_index?: number;
}

/** Fires when the summariser call finishes. Carries its own cost fields so
 * a single summariser call corresponds to exactly one cost line — matching
 * the "each summary gets its own cost" principle. The backend *also* emits
 * a `cost.recorded` event under the same synthetic node_id so existing
 * cost aggregators that only read `cost.recorded` keep working unchanged. */
export interface SummaryCompletedData {
  purpose: SummaryPurpose;
  provider?: string;
  model?: string;
  caller_node_id?: string;
  iteration?: { n: number; max: number };
  fidelity?: FidelityMode;
  /** Tokens in — prior messages + goal + any purpose-specific framing. */
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_ms: number;
  /** For `purpose="title"` this is the full title (≤80 chars by convention).
   * For `purpose="fidelity"` this is the narrative tail embedded in the
   * caller's fidelity seed. UIs may clamp. */
  output_text: string;
  /** Populated when the summariser refused / failed. Paired with
   * `output_text === ""` so a replay consumer can tell "no summary" from
   * "empty summary". */
  error?: string;
}

/** Fires after the asynchronous run-title summary completes. The
 * run.started event is deliberately *not* held on the title — it
 * fires immediately with `$ARGUMENTS` as the placeholder title, and this
 * event swaps in the generated title when it's ready. UI renders the
 * before/after transparently. Emitted with `node_id = "__summary.title"`
 * to stay co-located with its summariser events. */
export interface RunTitleGeneratedData {
  title: string;
  /** References the `summary.completed` event by its synthetic node id so
   * the UI can link "title" → "how was it generated + how much did it cost". */
  summary_node_id: string;
}

/** Payload for `budget.warn` / `budget.stop`. Both events share a shape;
 * the `type` on the envelope distinguishes them. */
export interface BudgetBreachData {
  /** "node" when a specific node's ceiling tripped; "run" for the
   * graph-level `budget_usd` / `budget_tokens`. */
  scope: "node" | "run";
  /** Which metric tripped. */
  metric: "cost" | "tokens";
  /** The ceiling that was configured. */
  limit: number;
  /** The cumulative value that breached (or first crossed the warn
   * threshold). Post-delta, so always ≥ `limit` for `stop`. */
  actual: number;
  /** For warn events: fraction of the ceiling (e.g. 0.82 = 82 %). */
  ratio?: number;
  /** For stop events: which real node triggered the breach (the last
   * cost-bearing call). Absent on run-level preflight-detected stops
   * where the breach was from a prior call. */
  caller_node_id?: string;
  /** Run-level run_max_cost_usd / run_max_tokens mirrored for UIs
   * that want to render "X of Y used" without cross-referencing the
   * graph attrs. */
  run_max_cost_usd?: number;
  run_max_tokens?: number;
  /** Human-readable summary — identical to the text that would appear
   * on the caller's `outcome.failure_reason` when the stop fires. */
  reason: string;
}

export interface EdgeSelectedData {
  from: string;
  to: string;
  /** Which of the 5 priority rules picked this edge. */
  rule: "condition" | "preferred_label" | "suggested_next_ids" | "weight" | "lexical";
  matched_label?: string;
  matched_condition?: string;
}

// ───── Control channel ──────────────────────────────────────────────────
// Control requests live in `.swarm/runs/<runId>/control.jsonl` (written by
// the CLI/daemon) and are mirrored into `events.jsonl` by the runtime as
// `control.requested` events. The request's `id` is a client-supplied
// idempotency key (uuid) that survives restarts via the checkpoint's
// `last_applied_control_id` — re-tailing a populated control file after
// resume never double-applies.

export type ControlCommand = "steer" | "pause" | "resume" | "cancel";

/** Free-form payload per command. Fields are command-scoped; readers should
 * switch on `command` before narrowing. Keeping a single interface with
 * optional fields (rather than a discriminated union) lets the wire
 * schema stay forward-compatible as new commands add new fields. */
export interface ControlRequestPayload {
  /** `steer`: the message to inject as a user turn. */
  message?: string;
  /** `pause` / `cancel`: optional free-form reason surfaced in UI + logs. */
  reason?: string;
}

/** Line shape in `control.jsonl`. Not an Event envelope — the runtime
 * promotes each line into a proper Event on read. */
export interface ControlRequest {
  /** Client-generated uuid. Idempotency key across restarts. */
  id: string;
  /** ISO-8601 wall-clock at request time. */
  timestamp: string;
  command: ControlCommand;
  payload?: ControlRequestPayload;
}

/** `control.requested.data` — one-to-one mirror of the request line. */
export interface ControlRequestedData {
  id: string;
  command: ControlCommand;
  payload?: ControlRequestPayload;
}

/** `control.applied.data` — fired when the runtime actually acted on the
 * request. For pause, this fires *after* the current node completes — the
 * gap between `control.requested` and `control.applied` is the implicit
 * "pending" state. */
export interface ControlAppliedData {
  id: string;
  command: ControlCommand;
  /** Node id at which the command took effect. Omitted when there is no
   * relevant node (e.g. resume from a pause that started between nodes). */
  applied_at_node?: string;
  /** Free-form note for the UI — e.g. `"injected"` for a steer that was
   * handed to the active backend. */
  note?: string;
}

/** `control.rejected.data` — fired when the runtime refuses the request
 * (e.g. resume while not paused, cancel after terminal). `reason` is a
 * stable machine-readable code so the UI can branch without parsing
 * human text. */
export interface ControlRejectedData {
  id: string;
  command: ControlCommand;
  reason: "not_paused" | "already_terminal" | "unknown_command" | string;
}

/** `run.canceled.data` — terminal event emitted as a side-effect of
 * a successful cancel, or by the runtime when an external abort signal
 * (SIGTERM / AbortController) tripped before a control request landed. */
export interface RunCanceledData {
  /** What caused the cancel. `control.cancel` is the happy path; `signal`
   * covers SIGTERM / parent-process death. */
  cause: "control.cancel" | "signal";
  /** Present when `cause === "control.cancel"` — correlates to the
   * originating `control.requested.data.id`. */
  request_id?: string;
  /** Free-form reason from the requester (or the signal handler). */
  reason?: string;
}

/** `subagent.start.data` — opens the bracket around an inline `agent`
 * tool spawn on the parent's event stream. Every event the sub-agent
 * emits between this and the matching `subagent.end` carries
 * `subagent_id` on its payload as a discriminator. The `nodeId` on the
 * envelope is the synthetic `__subagent:<uuid>` namespace, not the
 * parent codergen node — that's tracked separately on `parent_node_id`
 * so the steps aggregator can group sub-agent rows under the spawning
 * call.
 *
 * `name` and `agent_def` are independent labels:
 *   - `name`     — free-form caller-supplied label from inline
 *                  `agent({ name: "<label>", ... })`. UI surfaces it as
 *                  `Agent · <name>`.
 *   - `agent_def` — name of the resolved profile when the call used
 *                  `agent({ agent: "<def-name>", ... })`. Lets analytics
 *                  attribute cost per profile and lets the UI tell
 *                  "called by name" from "called by label" without
 *                  inspecting tool args.
 *
 * Both can coexist (`agent({ agent: "reviewer", name: "reviewer-1" })`),
 * either alone, or neither (a bare `agent({ prompt })` spawn). */
export interface SubagentStartData {
  subagent_id: string;
  /** The parent codergen node that issued the `agent` tool call. */
  parent_node_id: string;
  /** Iteration index on the parent node when the spawn fired. */
  iteration: number;
  /** Provider the sub-agent's codergen call resolved to. Inherited from
   * the parent unless a resolved profile carried `provider:` frontmatter. */
  provider: string;
  /** Model id the sub-agent's codergen call resolved to. Inherited from
   * the parent unless a resolved profile carried `model:` frontmatter. */
  model: string;
  /** Free-form caller-supplied label. See header comment. */
  name?: string;
  /** Resolved profile name from `agent({ agent: <name> })`. See header. */
  agent_def?: string;
  /** Pi-agent-core tool-call id of the parent's `agent` invocation
   *  (e.g. `toolu_01ABC…`). Lets the web UI link a parent toolCall card
   *  to its in-flight sub-agent before the toolResult — which carries
   *  the canonical link in `details.data.subagent_id` — has landed.
   *  Optional for back-compat with hand-rolled test events. */
  tool_call_id?: string;
}

/** `subagent.end.data` — closes the bracket. Carries terminal status
 * + lightweight totals so consumers (UI step rows, analytics) don't
 * have to scan the bracketed slice to render the spawn outcome. */
export interface SubagentEndData {
  subagent_id: string;
  status: "completed" | "halted" | "cancelled";
  /** Char-length of the sub-agent's final assistant message — the
   * payload itself sits on the parent's `messages` table under the
   * synthetic `__subagent:<uuid>` nodeId, this is just a cheap badge. */
  summary_chars: number;
  /** Cumulative tool-call count from the sub-agent's transcript. */
  total_tool_calls: number;
  /** Present when `status !== "completed"`. */
  halt_reason?: string;
  /** Per-spawn cost rollup. Summed from every `cost.recorded` event
   * the sub-agent forwarded onto the parent's stream during this
   * bracket. Mirrors the `partial*` shape on `fact.node_aborted` so
   * UIs and analytics can render a per-spawn total without scanning
   * the slice. Required numbers — default 0 when no `cost.recorded`
   * fired (e.g. spawn halted before any LLM call). */
  costUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** `subagent.resumed.data` — fires on the parent's stream when the
 * daemon respawns a sub-agent under a deterministic `subagent_id`
 * (sha256 of parentRunId, parentNodeId, parentIteration, tool_call_id
 * — see `docs/proposals/sub-agent-crash-resilience.md`). The original
 * `subagent.start` is still in the event log from the pre-crash
 * bracket; this event records the resume decision so consumers can
 * collapse the bracket cleanly.
 *
 * - `already_completed` — the persisted transcript ended in an
 *   assistant message with `stopReason:"stop"` and no pending
 *   toolCall. The daemon skips the LLM call and synthesises
 *   `subagent.end{status:"completed"}` directly from the transcript.
 * - `transcript_hydrated` — the persisted transcript was non-empty
 *   but in-flight; the daemon hands `priorMessages` to the backend
 *   and the sub-agent picks up where it left off. */
export interface SubagentResumedData {
  subagent_id: string;
  reason: "already_completed" | "transcript_hydrated";
}
