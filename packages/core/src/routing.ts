// Typed accessor layer over `run_state.routing` — docs/proposals/typed-routing-struct.md §6.
//
// `run_state.routing` is a single flat, dotted JSON dict (`schema.sql`,
// `routing TEXT NOT NULL CHECK (length(routing) < 8192)`) carrying load-bearing
// per-run dispatch state across heterogeneous keys. This module is the typed
// READ surface over those unchanged on-disk bytes: it gathers the dotted-key
// vocabulary as named constants (one source of truth for both writers and
// readers) and exposes validate-and-degrade accessors that present a typed
// view per subsystem namespace.
//
// On-disk bytes are UNCHANGED — namespaces are a typed view, not a reshape.
// Writes keep going through the existing key-wise `routingPatch` spread; no
// validation runs in the write txn (I1). Reads degrade to the conservative
// authored default everywhere (never pause): a mis-folded key or a tampered
// import bundle yields a safe default, never a wrong dispatch decision. The
// 8 KB column CHECK stays as a defense-in-depth tripwire (I6), not a budget the
// accessors are designed against.
//
// `getFrontier` is the relocated `readActiveNodes` (the validate-and-degrade
// prototype the whole layer generalises); the reducer's fold imports it for the
// fan-out frontier read. The fold behaviour is byte-identical — it still only
// touches `internal.active_nodes` — so relocating it is a no-bump contract change.

import { type Static, Type } from "@sinclair/typebox";
import type { OutcomeStatus } from "./types/outcome.ts";

// ── Key constants / builders ────────────────────────────────────────────────
// The dotted-key vocabulary. Gathered here so writers (patch construction) and
// readers (the accessors) route through the same literals.

/** Genesis-seeded run inputs (may hold `$fragua_blob` refs); blob-spill-eligible. */
export const INPUTS_KEY = "inputs";

/** Fan-out frontier: the sub-node ids currently in flight. Fold output. */
export const ACTIVE_NODES_KEY = "internal.active_nodes";

/** Wall-clock ms at which an auto-paused run becomes wake-eligible. */
export const AUTO_RESUME_AT_KEY = "internal.auto_resume_at";

/** Per-node retry counter — bumped each time a backward edge re-enters a node. */
export function retryCountKey(nodeId: string): string {
  return `internal.retry_count.${nodeId}`;
}

/** Per-node watchdog timeout-retry attempt counter. */
export function timeoutRetriesKey(nodeId: string): string {
  return `internal.timeout_retries.${nodeId}`;
}

/** Provider auto-retry chain attempt counter (survives manual resume). */
export const PROVIDER_RETRY_ATTEMPT_KEY = "internal.provider_retry.attempt";

/** Cumulative auto-retry backoff (ms) accrued across the chain. Summed beside
 * the attempt counter so the cumulative-ms cap can bound the chain across
 * manual resumes; cleared on a successful turn. */
export const PROVIDER_RETRY_CUMULATIVE_MS_KEY = "internal.provider_retry.cumulative_ms";

/** Operator-supplied budget ceiling override, folded from `intent.budget_adjusted`. */
export function budgetOverrideKey(scope: "run" | "node", metric: "cost" | "tokens"): string {
  return `budget_override.${scope}.${metric}`;
}

/** Once-per-run `budget.warn` dedup tag set (`(scope:metric)` strings). */
export const BUDGET_WARNED_KEY = "__budget_warned";

/** Per-node `max_retries` override, folded from `intent.max_retries_adjusted`. */
export function maxRetriesOverrideKey(nodeId: string): string {
  return `max_retries_override.${nodeId}`;
}

/** Operator override for the per-run loop ceiling. */
export const MAX_LOOPS_OVERRIDE_KEY = "max_loops_override";

/** Operator override for the per-gate goal-gate retarget ceiling. */
export const MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY = "max_goal_gate_retries_override";

/** Key prefix for per-gate outcome records (`goal_gates.<nodeId>`). */
export const GOAL_GATE_OUTCOME_KEY_PREFIX = "goal_gates.";

/** Build the routing key for a given gate node id. */
export function goalGateOutcomeKey(nodeId: string): string {
  return `${GOAL_GATE_OUTCOME_KEY_PREFIX}${nodeId}`;
}

/** Cumulative goal-gate retarget count for the run. */
export const GOAL_GATE_RETRIES_KEY = "goal_gates.__retries";

/** Workflow-level goal (`graph.attrs.goal`), surfaced to the agent context. */
export const GRAPH_GOAL_KEY = "graph.goal";

/** The run id, surfaced to the agent context. */
export const GRAPH_RUN_ID_KEY = "graph.run_id";

/** Operator-supplied dispatch priority, folded from `intent.priority_adjusted`. */
export const PRIORITY_KEY = "priority";

/** Operator gate notes awaiting delivery to the next llm step. Appended by the
 * transition planner when a human node consumes `intent.human_input` with a
 * non-empty note; cleared once an llm step consumes them (completes with a
 * success outcome). Notes are byte-truncated at write time (see
 * {@link truncateOperatorNote}); the full text stays on the intent for audit. */
export const OPERATOR_NOTES_KEY = "internal.operator_notes";

// ── Value-checked union + documentary schema ─────────────────────────────────

/** The goal-gate outcome union. A value-checked TypeBox union exercised by
 * `getGoalGate` (per-gate outcome records validate against it). */
export const OUTCOME_STATUS = Type.Union([Type.Literal("success"), Type.Literal("fail"), Type.Literal("retry")]);

const OUTCOME_VALUES = new Set<OutcomeStatus>(["success", "fail", "retry"]);
function isOutcomeStatus(v: unknown): v is OutcomeStatus {
  return typeof v === "string" && OUTCOME_VALUES.has(v as OutcomeStatus);
}

// ── Write-time routing-key gate ──────────────────────────────────────────────
// The READ accessors above degrade silently — a mis-typed or unknown key reads
// back as the conservative default. That is correct for a tampered import
// bundle, but it means a *write* of a malformed key persists unnoticed and then
// degrades the next dispatch decision (wrong retry budget, wrong loop cap) with
// no error and no audit signal. This gate closes that hole at the single point
// a `routingPatch` first enters the store: every key must belong to a known
// family and carry the expected value type, or the write is rejected before the
// transaction opens (I1 — the check stays out of the pure-SQL txn body).
//
// On-disk bytes and the read accessors are unchanged; this only constrains what
// the writer is allowed to spread into `run_state.routing`.

/** The value shape a routing-key family expects. */
type RoutingValueKind = "number" | "string" | "string-array" | "object" | "outcome-status" | "operator-notes";

const BUDGET_SCOPES = ["run", "node"] as const;
const BUDGET_METRICS = ["cost", "tokens"] as const;
const BUDGET_OVERRIDE_KEYS = new Set<string>(
  BUDGET_SCOPES.flatMap((scope) => BUDGET_METRICS.map((metric) => budgetOverrideKey(scope, metric))),
);

const RETRY_COUNT_PREFIX = "internal.retry_count.";
const TIMEOUT_RETRIES_PREFIX = "internal.timeout_retries.";
const MAX_RETRIES_OVERRIDE_PREFIX = "max_retries_override.";

/** Exact-match routing keys and the value kind each carries. */
const EXACT_ROUTING_KINDS = new Map<string, RoutingValueKind>([
  [INPUTS_KEY, "object"],
  [ACTIVE_NODES_KEY, "string-array"],
  [AUTO_RESUME_AT_KEY, "number"],
  [PROVIDER_RETRY_ATTEMPT_KEY, "number"],
  [PROVIDER_RETRY_CUMULATIVE_MS_KEY, "number"],
  [BUDGET_WARNED_KEY, "string-array"],
  [MAX_LOOPS_OVERRIDE_KEY, "number"],
  [MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY, "number"],
  [GOAL_GATE_RETRIES_KEY, "number"],
  [GRAPH_GOAL_KEY, "string"],
  [GRAPH_RUN_ID_KEY, "string"],
  [PRIORITY_KEY, "number"],
  [OPERATOR_NOTES_KEY, "operator-notes"],
]);

/** Resolve a routing key to its expected value kind, or `undefined` when the key
 * belongs to no known family. Exact keys win first; `goal_gates.__retries` is an
 * exact key so it never falls through to the per-gate outcome prefix. */
function routingKeyKind(key: string): RoutingValueKind | undefined {
  const exact = EXACT_ROUTING_KINDS.get(key);
  if (exact !== undefined) return exact;
  if (BUDGET_OVERRIDE_KEYS.has(key)) return "number";
  if (key.length > RETRY_COUNT_PREFIX.length && key.startsWith(RETRY_COUNT_PREFIX)) return "number";
  if (key.length > TIMEOUT_RETRIES_PREFIX.length && key.startsWith(TIMEOUT_RETRIES_PREFIX)) return "number";
  if (key.length > MAX_RETRIES_OVERRIDE_PREFIX.length && key.startsWith(MAX_RETRIES_OVERRIDE_PREFIX)) return "number";
  if (key.length > GOAL_GATE_OUTCOME_KEY_PREFIX.length && key.startsWith(GOAL_GATE_OUTCOME_KEY_PREFIX)) {
    return "outcome-status";
  }
  return undefined;
}

function matchesRoutingKind(value: unknown, kind: RoutingValueKind): boolean {
  switch (kind) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "string-array":
      return Array.isArray(value) && value.every((e) => typeof e === "string");
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "outcome-status":
      return isOutcomeStatus(value);
    case "operator-notes":
      return Array.isArray(value) && value.every(isOperatorNote);
  }
}

/** Thrown by {@link validateRoutingPatch} when a key is outside the known
 * vocabulary (`unknown-family`) or carries a value of the wrong type for its
 * family (`wrong-type`). A typed error so callers can distinguish a write-gate
 * rejection from an OCC/payload-size failure. */
export class RoutingPatchError extends Error {
  constructor(
    readonly key: string,
    readonly violation: "unknown-family" | "wrong-type",
    readonly value: unknown,
  ) {
    super(
      violation === "unknown-family"
        ? `routingPatch key ${JSON.stringify(key)} belongs to no known routing-key family`
        : `routingPatch key ${JSON.stringify(key)} has a value of the wrong type for its family`,
    );
    this.name = "RoutingPatchError";
  }
}

/** Gate a `routingPatch` against the known routing-key vocabulary before it is
 * spread into `run_state.routing`. Throws {@link RoutingPatchError} on the first
 * unknown key family or wrong-typed value; returns normally when every entry is
 * well-formed. Pure — no I/O — so it can run before the write transaction opens. */
export function validateRoutingPatch(patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    const kind = routingKeyKind(key);
    if (kind === undefined) throw new RoutingPatchError(key, "unknown-family", value);
    if (!matchesRoutingKind(value, kind)) throw new RoutingPatchError(key, "wrong-type", value);
  }
}

/** Documentary TypeBox schema describing the LOGICAL namespaces the accessors
 * present. It is the single place the typed view's shape is written down — it
 * is NOT the on-disk serialization (which stays flat + dotted) and is never
 * `Value.Check`'d against the whole routing object. Per ruling 3 the `inputs`
 * slot is `Record(String, Unknown)`: `getInputs` is annotation-only and never
 * validates a deep input tree, so there is no recursive `InputValue` tower. */
export const RoutingStruct = Type.Object({
  inputs: Type.Record(Type.String(), Type.Unknown()),
  frontier: Type.Union([Type.Array(Type.String()), Type.Null()]),
  budget: Type.Object({
    overrides: Type.Record(Type.String(), Type.Number()),
    warned: Type.Array(Type.String()),
  }),
  retry: Type.Object({
    count: Type.Record(Type.String(), Type.Number()),
    timeoutRetries: Type.Record(Type.String(), Type.Number()),
    providerAttempt: Type.Number(),
    providerCumulativeMs: Type.Number(),
  }),
  goalGate: Type.Object({
    outcomes: Type.Record(Type.String(), OUTCOME_STATUS),
    retries: Type.Number(),
  }),
  limits: Type.Object({
    maxLoops: Type.Optional(Type.Number()),
    maxGoalGateRetries: Type.Optional(Type.Number()),
    maxRetries: Type.Record(Type.String(), Type.Number()),
  }),
  timer: Type.Object({ autoResumeAt: Type.Optional(Type.Number()) }),
  context: Type.Object({ goal: Type.Optional(Type.String()), runId: Type.Optional(Type.String()) }),
  operatorNotes: Type.Array(Type.Object({ gateNodeId: Type.String(), route: Type.String(), note: Type.String() })),
});
export type RoutingStruct = Static<typeof RoutingStruct>;

// ── Accessors (validate-and-degrade) ─────────────────────────────────────────

/** Read a string-valued routing key, degrading non-strings to undefined. The
 * generic primitive `getContext` is built on, kept here so the only raw routing
 * index for an arbitrary key lives inside the accessor module. */
export function routingString(routing: Record<string, unknown>, key: string): string | undefined {
  const v = routing[key];
  return typeof v === "string" ? v : undefined;
}

function finiteNumber(routing: Record<string, unknown>, key: string): number {
  const v = routing[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read `routing.inputs` preserving object / array input values. Degrades a
 * non-object to `{}`. Preserves the three write-path guards verbatim: the
 * `__proto__` key filter (the sole prototype-polluting key — `constructor` /
 * `toString` are legitimate own keys the write path stores verbatim), the
 * per-entry un-materialized `$fragua_blob` ref drop (probed with `Object.hasOwn`
 * so a polluted `Object.prototype.$fragua_blob` can't disappear every structured
 * input), and object-or-`{}`. */
export function getInputs(routing: Record<string, unknown>): Record<string, unknown> {
  const v = routing[INPUTS_KEY];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "__proto__") continue;
    if (val !== null && typeof val === "object" && Object.hasOwn(val as Record<string, unknown>, "$fragua_blob")) {
      continue;
    }
    out[k] = val;
  }
  return out;
}

/** Read the RAW `routing.inputs` object (un-materialized: `$fragua_blob` refs
 * preserved) for the blob-spill WRITE path, which must see refs to spill string
 * values and skip already-spilled ones — `getInputs` drops refs and so is wrong
 * here. Returns undefined for a non-object. Keeps the spill's raw `inputs` index
 * inside the accessor seam (ruling 4). */
export function readRawInputs(routing: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = routing[INPUTS_KEY];
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** Read the fan-out frontier. Element-validated: the only non-typed write path
 * is a tampered bundle fed through `fragua import` — degrade to `null` ("no
 * fan-out", self-heals on re-derive) instead of propagating junk. This is the
 * relocated `readActiveNodes`. */
export function getFrontier(routing: Record<string, unknown>): string[] | null {
  const v = routing[ACTIVE_NODES_KEY];
  return Array.isArray(v) && v.every((e) => typeof e === "string") ? (v as string[]) : null;
}

export interface BudgetView {
  /** Operator-supplied ceiling override for a (scope, metric); undefined when
   * unset — the caller falls back to the lower authored cap (a lost override
   * only makes a run pause sooner, never overspend). */
  override(scope: "run" | "node", metric: "cost" | "tokens"): number | undefined;
  /** Once-per-run `budget.warn` dedup tags; non-array degrades to ∅. */
  warned: ReadonlySet<string>;
}

export function getBudget(routing: Record<string, unknown>): BudgetView {
  const warnedRaw = routing[BUDGET_WARNED_KEY];
  const warned = new Set<string>();
  if (Array.isArray(warnedRaw)) {
    for (const item of warnedRaw) if (typeof item === "string") warned.add(item);
  }
  return {
    override(scope, metric) {
      const v = routing[budgetOverrideKey(scope, metric)];
      return typeof v === "number" ? v : undefined;
    },
    warned,
  };
}

export interface RetryView {
  /** Per-node retry counter; non-finite degrades to 0. */
  count(nodeId: string): number;
  /** Per-node watchdog timeout-retry counter; non-finite degrades to 0. */
  timeoutRetries(nodeId: string): number;
  /** Provider auto-retry chain attempt; non-finite degrades to 0. */
  providerAttempt: number;
  /** Cumulative auto-retry backoff (ms) accrued in this chain; non-finite degrades to 0. */
  providerCumulativeMs: number;
}

export function getRetry(routing: Record<string, unknown>): RetryView {
  return {
    count: (nodeId) => finiteNumber(routing, retryCountKey(nodeId)),
    timeoutRetries: (nodeId) => finiteNumber(routing, timeoutRetriesKey(nodeId)),
    providerAttempt: finiteNumber(routing, PROVIDER_RETRY_ATTEMPT_KEY),
    providerCumulativeMs: finiteNumber(routing, PROVIDER_RETRY_CUMULATIVE_MS_KEY),
  };
}

/** Per-gate outcome captured as the run executes. */
export type GateOutcomes = ReadonlyMap<string, OutcomeStatus>;

export interface GoalGateView {
  /** This gate's recorded outcome, or undefined (treated unsatisfied → re-runs). */
  outcome(nodeId: string): OutcomeStatus | undefined;
  /** All per-gate outcomes (value-checked against `OUTCOME_STATUS`). */
  outcomes: GateOutcomes;
  /** Cumulative retarget count; non-finite degrades to 0. */
  retries: number;
}

export function getGoalGate(routing: Record<string, unknown>): GoalGateView {
  const outcomes = new Map<string, OutcomeStatus>();
  for (const [k, v] of Object.entries(routing)) {
    if (!k.startsWith(GOAL_GATE_OUTCOME_KEY_PREFIX)) continue;
    if (k === GOAL_GATE_RETRIES_KEY) continue;
    if (isOutcomeStatus(v)) outcomes.set(k.slice(GOAL_GATE_OUTCOME_KEY_PREFIX.length), v);
  }
  return {
    outcome: (nodeId) => outcomes.get(nodeId),
    outcomes,
    retries: finiteNumber(routing, GOAL_GATE_RETRIES_KEY),
  };
}

/** Read all per-gate outcomes. Thin alias over `getGoalGate`, kept as a named
 * reader for the goal-gate policy + planner. */
export function readGateOutcomes(routing: Record<string, unknown>): GateOutcomes {
  return getGoalGate(routing).outcomes;
}

/** Read the cumulative goal-gate retarget count. Defaults to 0. */
export function readGoalGateRetries(routing: Record<string, unknown>): number {
  return getGoalGate(routing).retries;
}

export interface LimitsView {
  /** `max_loops_override`; undefined → authored `max_loops` applies. */
  maxLoops: number | undefined;
  /** `max_goal_gate_retries_override`; undefined → authored gate cap applies. */
  maxGoalGateRetries: number | undefined;
  /** Per-node `max_retries_override`; undefined → authored node/graph attr applies. */
  maxRetries(nodeId: string): number | undefined;
}

export function getLimits(routing: Record<string, unknown>): LimitsView {
  const finiteOrUndef = (key: string): number | undefined => {
    const v = routing[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  return {
    maxLoops: finiteOrUndef(MAX_LOOPS_OVERRIDE_KEY),
    maxGoalGateRetries: finiteOrUndef(MAX_GOAL_GATE_RETRIES_OVERRIDE_KEY),
    maxRetries: (nodeId) => finiteOrUndef(maxRetriesOverrideKey(nodeId)),
  };
}

/** Wall-clock ms at which an auto-paused run becomes wake-eligible; non-number
 * degrades to undefined. */
export function getTimer(routing: Record<string, unknown>): number | undefined {
  const v = routing[AUTO_RESUME_AT_KEY];
  return typeof v === "number" ? v : undefined;
}

export interface ContextView {
  /** Workflow-level goal; non-string degrades to undefined. */
  goal: string | undefined;
  /** The run id; non-string degrades to undefined. */
  runId: string | undefined;
}

export function getContext(routing: Record<string, unknown>): ContextView {
  return {
    goal: routingString(routing, GRAPH_GOAL_KEY),
    runId: routingString(routing, GRAPH_RUN_ID_KEY),
  };
}

/** One operator gate note awaiting delivery (SPEC §3.4). */
export interface OperatorNote {
  /** The human node whose `intent.human_input` carried the note. */
  gateNodeId: string;
  /** The route the operator chose alongside the note. */
  route: string;
  note: string;
}

function isOperatorNote(v: unknown): v is OperatorNote {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o["gateNodeId"] === "string" && typeof o["route"] === "string" && typeof o["note"] === "string";
}

/** Read the pending operator notes. Element-validated; malformed entries and
 * empty notes degrade to absent, so a tampered bundle loses a note (the intent
 * still has it) rather than breaking a dispatch. */
export function readOperatorNotes(routing: Record<string, unknown>): OperatorNote[] {
  const v = routing[OPERATOR_NOTES_KEY];
  if (!Array.isArray(v)) return [];
  return v.filter(isOperatorNote).filter((n) => n.note.length > 0);
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

// Byte budgets, not char: the routing column's CHECK is UTF-8 `length < 8192`,
// so a 2000-char CJK/emoji note (~4-6 KB) would breach a char-only cap.
export const OPERATOR_NOTE_MAX_BYTES = 2000;
export const OPERATOR_NOTES_MAX_BYTES = 4096;

const TRUNCATION_MARKER = " [truncated]";

/** Truncate to `maxBytes` UTF-8 bytes on a codepoint boundary. Defaults to
 * {@link OPERATOR_NOTE_MAX_BYTES}; {@link capOperatorNotes} passes a tighter
 * budget when the routing column can't seat a full-size note. The marker is
 * dropped when the budget is too small to be worth spending on it.
 *
 * The loop is O(n²) in the note length. That is bounded, not overlooked: a note
 * only reaches here off `intent.human_input`, and `appendIntent` rejects any
 * payload at or above `MAX_EVENT_PAYLOAD_BYTES` (4 KiB), so `note` is always a
 * few thousand bytes. Do not call this on unbounded input. */
export function truncateOperatorNote(note: string, maxBytes: number = OPERATOR_NOTE_MAX_BYTES): string {
  if (utf8Bytes(note) <= maxBytes) return note;
  const marker = maxBytes > utf8Bytes(TRUNCATION_MARKER) * 2 ? TRUNCATION_MARKER : "";
  const budget = maxBytes - utf8Bytes(marker);
  if (budget <= 0) return "";
  let end = note.length;
  while (end > 0 && utf8Bytes(note.slice(0, end)) > budget) end--;
  if (end > 0 && end < note.length) {
    const code = note.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--; // don't split a surrogate pair
  }
  if (end === 0) return "";
  return note.slice(0, end) + marker;
}

/** Bound the serialized array to `maxBytes`, dropping oldest first. Defaults to
 * {@link OPERATOR_NOTES_MAX_BYTES}, which is an ABSOLUTE ceiling — callers that
 * write into `run_state.routing` must pass a budget computed against what the
 * rest of that run's routing already costs. The routing column's cap is shared
 * with every other key and a notes array is structural, so the blob spiller
 * (which only moves `routing.inputs` strings) can never relieve it.
 *
 * The newest note is never dropped: if it alone overruns the budget it is
 * truncated further instead, so an operator correction degrades rather than
 * vanishing silently or breaching the column. Returns `[]` only when the budget
 * cannot seat even a one-character note. The full text always stays on
 * `intent.human_input` for audit. */
export function capOperatorNotes(notes: OperatorNote[], maxBytes: number = OPERATOR_NOTES_MAX_BYTES): OperatorNote[] {
  const fits = (list: OperatorNote[]): boolean => utf8Bytes(JSON.stringify(list)) <= maxBytes;
  const out = [...notes];
  while (out.length > 1 && !fits(out)) out.shift();
  if (out.length === 0 || fits(out)) return out;

  // One note left and it still overruns. Shrink the note itself against the room
  // its envelope leaves. Halve on each miss: JSON escaping (a note of quotes or
  // newlines doubles in the serialized form) can make the truncated text still
  // not fit, and halving guarantees the loop reaches 0 rather than spinning.
  const newest = out[0]!;
  let room = maxBytes - utf8Bytes(JSON.stringify([{ ...newest, note: "" }]));
  while (room > 0) {
    const candidate = truncateOperatorNote(newest.note, room);
    if (candidate.length > 0 && fits([{ ...newest, note: candidate }])) return [{ ...newest, note: candidate }];
    room = Math.floor(room / 2);
  }
  return [];
}
