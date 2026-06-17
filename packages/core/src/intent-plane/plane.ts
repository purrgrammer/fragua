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

import type { EnqueueRunParams, IEventWriter } from "@fragua/store";
import type { IntentEvent } from "@fragua/types";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type InputBindingError, validateInputBindings } from "../engine/inputs.ts";
import { type Diagnostic, validate } from "../engine/validator.ts";
import { sha256Hex } from "../handler/sha256.ts";
import { CURRENT_IR_VERSION, serializeGraph } from "../ir.ts";
import { parseWorkflow } from "../parser/yaml.ts";
import type { Graph, InputDecl } from "../types/graph.ts";
import * as S from "./schemas.ts";

export type BuildResult<T extends IntentEvent = IntentEvent> = { ok: true; intent: T } | { ok: false; error: string };

/** Genesis-event payload budget for the serialized run `inputs`. The store caps
 * the whole `intent.run_enqueued` payload at 4 KiB (`MAX_EVENT_PAYLOAD_BYTES`);
 * leave headroom for the other genesis fields (workflowSha, project identity,
 * routing scaffolding) so a clean enqueue-time error fires before the raw
 * `PayloadTooLargeError`. Spillable string inputs never reach this; only
 * non-spillable structured inputs can. */
const GENESIS_INPUTS_MAX_BYTES = 3584;

/** The `IntentEvent` member with a given `type` discriminant. */
type IntentOf<K extends IntentEvent["type"]> = Extract<IntentEvent, { type: K }>;

/** Workflow-identity mint. `sha = sha256Hex(source)` (still source-hash;
 * `workflow-ir.md` (B) swaps this for an IR-hash *inside this one function*),
 * `ir = serializeGraph(parseWorkflow(source))`. The single chokepoint every
 * mint site (server `POST /workflows`, the by-name resolver, the schedule
 * dispatcher) routes through. The mint REJECTS error-severity validator
 * diagnostics (`invalid`) — every enqueue path runs through here, so a graph
 * the validator hard-errors on (E-codes) never reaches the executor; warnings
 * pass (`fragua validate` is the surface that shows them). Returns the parsed
 * `graph` so callers can run their own additional validation (timeout attrs,
 * model resolution); a failure is reported, never thrown — each adapter maps
 * it to its own handling (HTTP 400 vs schedule auto-pause). */
export type WorkflowMint =
  | { ok: true; sha: string; ir: string; irVersion: number; graph: Graph }
  | { ok: false; reason: "unparseable" | "invalid"; detail: string; diagnostics?: Diagnostic[] };

/** Resolved enqueue request. The adapter resolves location/identity + the
 * workflow (§3.6) and passes them in; the plane validates the input
 * bindings, assembles `initialRouting`, mints the run id, and builds the
 * store params. `inputDecls` (the workflow's `inputs:` block) is supplied
 * only when the caller wants typed-input validation — the server does;
 * the schedule dispatcher omits it. */
export interface EnqueueInput {
  workflowSha: string;
  inputDecls?: readonly InputDecl[] | undefined;
  /** Run-provided inputs. Scalar values are strings; object / array inputs are
   * already-parsed JSON values (the CLI coerces by declared type; the server
   * receives parsed JSON). Validated against `inputDecls` at enqueue. */
  inputs?: Record<string, unknown> | undefined;
  routing?: Record<string, unknown> | undefined;
  priority?: number | undefined;
  cwd?: string | undefined;
  projectId?: string | undefined;
  projectName?: string | undefined;
  workflowName?: string | undefined;
  workflowScope?: "global" | "local" | "path" | "ephemeral" | undefined;
  workflowPath?: string | undefined;
  scheduleId?: string | undefined;
}

export type EnqueueBuild =
  | { ok: true; runId: string; params: EnqueueRunParams }
  | { ok: false; error: string; inputErrors: InputBindingError[] };

const MAX_REPORTED_ERRORS = 10;

/** "/limits/maxRetries" → "limits.maxRetries"; array indices as "[n]"
 * ("/items/0/name" → "items[0].name"); root (empty path) → "body". */
export function pointerToFieldPath(pointer: string): string {
  if (pointer === "") return "body";
  return pointer
    .slice(1)
    .split("/")
    .map((seg, i) => (/^\d+$/.test(seg) ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join("");
}

function fail(schema: TSchema, body: unknown): { ok: false; error: string } {
  const errors = [...Value.Errors(schema, body)];
  if (errors.length === 0) return { ok: false, error: "invalid request body" };
  const shown = errors
    .slice(0, MAX_REPORTED_ERRORS)
    .map((e) => `${pointerToFieldPath(e.path)}: ${e.message}`)
    .join("; ");
  const overflow = errors.length - MAX_REPORTED_ERRORS;
  return { ok: false, error: overflow > 0 ? `${shown} (+${overflow} more)` : shown };
}

export interface IntentPlaneDeps {
  store: IEventWriter;
  /** Run-id minter, injected (§3.3) — production passes `@fragua/store`'s
   * full-entropy ULID `newRunId`; tests/PBT pass a deterministic counter.
   * The uniqueness/import contract lives on the default, never the seam. */
  newRunId: () => string;
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
  /** Record a completed local accept (the git already ran in `@fragua/workspace`;
   * this only constructs the intent the daemon folds into `fact.run_accepted`).
   * Pure — no validation, the inputs come from a typed workspace result. */
  buildAcceptRun(result: { sha: string; replayed: number; tailStaged: boolean }): IntentOf<"intent.accept_run">;
  /** Record a completed local discard (refs already deleted). Pure. */
  buildDiscardRun(result: { refs: string[] }): IntentOf<"intent.discard_run">;
  /** Workflow-identity mint (parse + hash + serialize IR). Pure. */
  buildSaveWorkflow(source: string): WorkflowMint;
  /** Validate input bindings, assemble routing, mint the run id, build the
   * enqueue params. Deterministic given the injected minter. */
  buildEnqueue(input: EnqueueInput): EnqueueBuild;
  /** The single intent write. Adapters never call `store.appendIntent`. */
  commit(runId: string, intent: IntentEvent): { seq: number };
  /** The single workflow write. Adapters never call `store.saveWorkflow`.
   * Content-addressed and idempotent. */
  commitSaveWorkflow(args: { sha: string; name: string; source: string; ir: string; irVersion: number }): void;
  /** The single enqueue write. Adapters never call `store.enqueueRun`. */
  commitEnqueue(params: EnqueueRunParams): void;
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
    buildAcceptRun(result) {
      return {
        type: "intent.accept_run",
        payload: { sha: result.sha, replayed: result.replayed, tailStaged: result.tailStaged },
      };
    },
    buildDiscardRun(result) {
      return { type: "intent.discard_run", payload: { refs: result.refs } };
    },
    buildSaveWorkflow(source) {
      let graph: Graph;
      try {
        graph = parseWorkflow(source);
      } catch (err) {
        return { ok: false, reason: "unparseable", detail: err instanceof Error ? err.message : String(err) };
      }
      const errors = validate(graph).filter((d) => d.severity === "error");
      if (errors.length > 0) {
        return {
          ok: false,
          reason: "invalid",
          detail: errors.map((d) => `${d.code}: ${d.message}`).join("; "),
          diagnostics: errors,
        };
      }
      return { ok: true, sha: sha256Hex(source), ir: serializeGraph(graph), irVersion: CURRENT_IR_VERSION, graph };
    },
    buildEnqueue(input) {
      if (input.inputDecls !== undefined) {
        const errs = validateInputBindings(input.inputDecls, input.inputs ?? {});
        if (errs.length > 0) {
          return { ok: false, error: errs.map((e) => e.message).join("; "), inputErrors: errs };
        }
      }
      // Pre-check the genesis event's 4 KiB payload cap, but ONLY against the
      // non-spillable inputs. String inputs spill via `spillRoutingInputs`, so
      // size-checking them here would reject a payload the spill would shrink;
      // only object / array inputs can't spill yet, so an oversized one gets a
      // clean validation error instead of a raw `PayloadTooLargeError`. Measured
      // in UTF-8 bytes (not `String#length` / UTF-16 units) so multibyte inputs
      // can't slip past the cap.
      if (input.inputs != null) {
        const structured = new Set(
          (input.inputDecls ?? []).filter((d) => d.type === "object" || d.type === "array").map((d) => d.name),
        );
        const nonSpillable: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input.inputs)) {
          if (structured.has(k)) nonSpillable[k] = v;
        }
        if (
          Object.keys(nonSpillable).length > 0 &&
          new TextEncoder().encode(JSON.stringify({ inputs: nonSpillable })).byteLength >= GENESIS_INPUTS_MAX_BYTES
        ) {
          return { ok: false, error: "input payload too large", inputErrors: [] };
        }
      }
      const initialRouting: Record<string, unknown> = { ...(input.routing ?? {}) };
      if (input.inputs != null && initialRouting["inputs"] === undefined) {
        initialRouting["inputs"] = input.inputs;
      }
      const runId = deps.newRunId(); // always minted — no operator/client-supplied ids
      const params: EnqueueRunParams = {
        runId,
        workflowSha: input.workflowSha,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(Object.keys(initialRouting).length > 0 ? { initialRouting } : {}),
        ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
        ...(typeof input.projectId === "string" && input.projectId.length > 0 ? { projectId: input.projectId } : {}),
        ...(typeof input.projectName === "string" && input.projectName.length > 0
          ? { projectName: input.projectName }
          : {}),
        ...(input.workflowName !== undefined ? { workflowName: input.workflowName } : {}),
        ...(input.workflowScope !== undefined ? { workflowScope: input.workflowScope } : {}),
        ...(input.workflowPath !== undefined ? { workflowPath: input.workflowPath } : {}),
        ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
      };
      return { ok: true, runId, params };
    },
    commit(runId, intent) {
      const { seq } = deps.store.appendIntent(runId, intent);
      return { seq };
    },
    commitSaveWorkflow(args) {
      deps.store.saveWorkflow(args.sha, args.name, args.source, args.ir, args.irVersion);
    },
    commitEnqueue(params) {
      deps.store.enqueueRun(params);
    },
  };
}
