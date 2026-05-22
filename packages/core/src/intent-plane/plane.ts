// The intent plane — one validate/construct/commit surface every intent
// writer (HTTP server, CLI argv, schedule-dispatcher fiber) routes through,
// so no two writers can disagree about what a valid intent is.
//
// `build*` is pure: validate the raw request body against a TypeBox schema
// (§schemas.ts) and construct the `IntentEvent`. `commit` is the single
// store write. Adapters call `build*` then `commit` — never `store.appendIntent`
// directly (enforced by a discipline test). The store is INJECTED (only its
// type is imported, so this module adds no runtime dependency on @fragua/store
// and the `@fragua/core` main entry stays browser-safe).
//
// Enqueue (the two-op `buildSaveWorkflow` + `buildEnqueue`) and the run-id
// minter land in a follow-on increment; this is the control-intent surface.

import type { IEventStore } from "@fragua/store";
import type { IntentEvent } from "@fragua/types";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sha256Hex } from "../handler/sha256.ts";
import { CURRENT_IR_VERSION, serializeGraph } from "../ir.ts";
import { parseWorkflow } from "../parser/yaml.ts";
import type { Graph } from "../types/graph.ts";
import * as S from "./schemas.ts";

export type BuildResult<T extends IntentEvent = IntentEvent> = { ok: true; intent: T } | { ok: false; error: string };

/** The `IntentEvent` member with a given `type` discriminant. */
type IntentOf<K extends IntentEvent["type"]> = Extract<IntentEvent, { type: K }>;

/** Workflow-identity mint. `sha = sha256Hex(source)` (still source-hash;
 * `workflow-ir.md` (B) swaps this for an IR-hash *inside this one function*),
 * `ir = serializeGraph(parseWorkflow(source))`. The single chokepoint every
 * mint site (server `POST /workflows`, the by-name resolver, the schedule
 * dispatcher) routes through. Returns the parsed `graph` so callers can run
 * their own additional validation (timeout attrs, model resolution); a parse
 * failure is reported, never thrown — each adapter maps it to its own
 * handling (HTTP 400 vs schedule auto-pause). */
export type WorkflowMint =
  | { ok: true; sha: string; ir: string; irVersion: number; graph: Graph }
  | { ok: false; reason: "unparseable"; detail: string };

function fail(schema: TSchema, body: unknown): { ok: false; error: string } {
  const first = [...Value.Errors(schema, body)][0];
  return { ok: false, error: first ? `${first.path || "/"} ${first.message}`.trim() : "invalid request body" };
}

export interface IntentPlaneDeps {
  store: IEventStore;
}

export interface IntentPlane {
  buildSteer(body: unknown): BuildResult<IntentOf<"intent.steering_requested">>;
  buildPause(body: unknown): BuildResult<IntentOf<"intent.pause_requested">>;
  buildCancel(body: unknown): BuildResult<IntentOf<"intent.cancel_requested">>;
  buildHuman(body: unknown): BuildResult<IntentOf<"intent.human_input">>;
  buildResume(body: unknown): BuildResult<IntentOf<"intent.resume">>;
  buildUnquarantine(body: unknown): BuildResult<IntentOf<"intent.unquarantine">>;
  buildPriority(body: unknown): BuildResult<IntentOf<"intent.priority_adjusted">>;
  buildBudget(body: unknown): BuildResult<IntentOf<"intent.budget_adjusted">>;
  buildMaxRetries(body: unknown): BuildResult<IntentOf<"intent.max_retries_adjusted">>;
  buildGoalGate(body: unknown): BuildResult<IntentOf<"intent.goal_gate_adjusted">>;
  buildMaxLoops(body: unknown): BuildResult<IntentOf<"intent.max_loops_adjusted">>;
  /** Workflow-identity mint (parse + hash + serialize IR). Pure. */
  buildSaveWorkflow(source: string): WorkflowMint;
  /** The single intent write. Adapters never call `store.appendIntent`. */
  commit(runId: string, intent: IntentEvent): { seq: number };
  /** The single workflow write. Adapters never call `store.saveWorkflow`.
   * Content-addressed and idempotent. */
  commitSaveWorkflow(args: { sha: string; name: string; source: string; ir: string; irVersion: number }): void;
}

export function makeIntentPlane(deps: IntentPlaneDeps): IntentPlane {
  return {
    buildSteer(body) {
      if (!Value.Check(S.SteerBody, body)) return fail(S.SteerBody, body);
      return { ok: true, intent: { type: "intent.steering_requested", payload: { text: body.text } } };
    },
    buildPause(body) {
      if (!Value.Check(S.PauseBody, body)) return fail(S.PauseBody, body);
      return { ok: true, intent: { type: "intent.pause_requested", payload: {} } };
    },
    buildCancel(body) {
      if (!Value.Check(S.CancelBody, body)) return fail(S.CancelBody, body);
      const payload: { reason?: string } = {};
      if (body.reason !== undefined) payload.reason = body.reason;
      return { ok: true, intent: { type: "intent.cancel_requested", payload } };
    },
    buildHuman(body) {
      if (!Value.Check(S.HumanBody, body)) return fail(S.HumanBody, body);
      const payload: { route: string; note?: string } = { route: body.route };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.human_input", payload } };
    },
    buildResume(body) {
      if (!Value.Check(S.ResumeBody, body)) return fail(S.ResumeBody, body);
      const payload: { note?: string } = {};
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.resume", payload } };
    },
    buildUnquarantine(body) {
      if (!Value.Check(S.UnquarantineBody, body)) return fail(S.UnquarantineBody, body);
      const payload: { resolution: "treat_as_done" | "retry" | "cancel"; note?: string } = {
        resolution: body.resolution,
      };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.unquarantine", payload } };
    },
    buildPriority(body) {
      if (!Value.Check(S.PriorityBody, body)) return fail(S.PriorityBody, body);
      const payload: { newPriority: number; note?: string } = { newPriority: body.newPriority };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.priority_adjusted", payload } };
    },
    buildBudget(body) {
      if (!Value.Check(S.BudgetBody, body)) return fail(S.BudgetBody, body);
      const payload: { scope: "node" | "run"; metric: "cost" | "tokens"; newLimit: number; note?: string } = {
        scope: body.scope,
        metric: body.metric,
        newLimit: body.newLimit,
      };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.budget_adjusted", payload } };
    },
    buildMaxRetries(body) {
      if (!Value.Check(S.MaxRetriesBody, body)) return fail(S.MaxRetriesBody, body);
      const payload: { nodeId: string; newLimit: number; note?: string } = {
        nodeId: body.nodeId,
        newLimit: body.newLimit,
      };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.max_retries_adjusted", payload } };
    },
    buildGoalGate(body) {
      if (!Value.Check(S.GoalGateBody, body)) return fail(S.GoalGateBody, body);
      const payload: { newLimit: number; note?: string } = { newLimit: body.newLimit };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.goal_gate_adjusted", payload } };
    },
    buildMaxLoops(body) {
      if (!Value.Check(S.MaxLoopsBody, body)) return fail(S.MaxLoopsBody, body);
      const payload: { newLimit: number; note?: string } = { newLimit: body.newLimit };
      if (body.note !== undefined) payload.note = body.note;
      return { ok: true, intent: { type: "intent.max_loops_adjusted", payload } };
    },
    buildSaveWorkflow(source) {
      let graph: Graph;
      try {
        graph = parseWorkflow(source);
      } catch (err) {
        return { ok: false, reason: "unparseable", detail: err instanceof Error ? err.message : String(err) };
      }
      return { ok: true, sha: sha256Hex(source), ir: serializeGraph(graph), irVersion: CURRENT_IR_VERSION, graph };
    },
    commit(runId, intent) {
      const { seq } = deps.store.appendIntent(runId, intent);
      return { seq };
    },
    commitSaveWorkflow(args) {
      deps.store.saveWorkflow(args.sha, args.name, args.source, args.ir, args.irVersion);
    },
  };
}
