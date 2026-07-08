// Human handler — operator-gate pauses with route-discriminated resume.
// The operator picks one of the node's declared `routes=` names; the
// route vocabulary is shared with LLM-directed routing (D6).
//
// First call (no `ctx.humanInput`): the executor's first dispatch of a
// `kind=human` node returns `yield_human { text, routes }`. The
// daemon's result-to-facts emits `fact.run_paused { reason:"human", nodeId,
// text, routes }`; the reducer projects `run_state.status` to
// `paused_human`; the executor frees the slot.
//
// Second call (after `intent.human_input` arrives): the executor folds
// the intent into `ctx.humanInput = { route, note? }` and re-dispatches
// the same node. The handler validates the route against its declared
// list (defense-in-depth — the server-side endpoint validates the same
// enum, but a hand-crafted intent could bypass that) and returns a
// transition with `route` set to the chosen route name. The engine's
// route-case edge selector (packages/core/src/engine/edge-selection.ts)
// fires the edge whose `attrs.route` matches the chosen value. A
// non-empty note rides the transition as `operatorNote`; the planner
// stages it in routing for the next llm step's prompt (SPEC §3.4).
//
// Per D6 the per-edge `label=` is pure UX (button text) and never
// participates in selection.

import { UnpopulatedOutputError } from "../../engine/outputs-substitution.ts";
import { substitute } from "../../engine/substitution.ts";
import type { Handler, HandlerResult, HandlerSpec, HumanInput } from "../types.ts";

export interface HumanHandlerEdge {
  /** Route name (must appear in `routes`). */
  route: string;
  /** Target node id for validation/error reporting. */
  to: string;
  /** Per-edge `label=` override — pure-UX button text (D6). Surfaced to
   * the operator UI via `fact.run_paused{reason:"human"}.payload.routeLabels`;
   * never participates in selection. */
  label?: string;
}

export interface HumanHandlerConfig {
  /** Operator-facing prompt rendered above the buttons. */
  text: string;
  /** Declared route names. Each name must have exactly one matching
   * edge in `edges`. */
  routes: string[];
  /** Outgoing route-keyed edges from the human node. */
  edges: HumanHandlerEdge[];
  /** Node id, for error-detail formatting. Defaults to "<unknown>". */
  nodeId?: string;
}

export function makeHumanHandler(cfg: HumanHandlerConfig): HandlerSpec {
  const nodeId = cfg.nodeId ?? "<unknown>";
  const routeToTarget = validateAndBuildMap(nodeId, cfg.routes, cfg.edges);
  const text = cfg.text;
  const routes = cfg.routes;
  const routeLabels: Record<string, string> = {};
  for (const e of cfg.edges) {
    if (e.label !== undefined) routeLabels[e.route] = e.label;
  }
  const hasLabels = Object.keys(routeLabels).length > 0;

  const handler: Handler = async (ctx) => {
    if (ctx.humanInput === undefined) {
      // Interpolate `${{ inputs.x }}` / `${{ outputs.X.f }}` so the operator
      // sees real values, not literal tokens (rule 13: human `text:` consumes).
      // No shell-escape and no output-wrap — a person reads this, it's not an
      // LLM prompt. An unpopulated output ref FAILS CLOSED as a node `fail`
      // (not an uncaught throw the executor would turn into a fatal halt).
      let resolvedText: string;
      try {
        resolvedText = substitute(text, { args: ctx.args });
      } catch (err) {
        if (err instanceof UnpopulatedOutputError) {
          return { kind: "transition", outcomeStatus: "fail", failureReason: err.message, tokens: 0, costUsd: 0 };
        }
        throw err;
      }
      return {
        kind: "yield_human",
        text: resolvedText,
        routes,
        ...(hasLabels ? { routeLabels } : {}),
      } satisfies HandlerResult;
    }

    const route = normaliseRoute(ctx.humanInput);
    const target = routeToTarget.get(route);
    if (target === undefined) {
      return {
        kind: "halt",
        reason: "error",
        detail: `human node "${nodeId}": unknown route "${route}" (expected one of: ${routes.join(", ")})`,
      } satisfies HandlerResult;
    }

    const note = typeof ctx.humanInput === "object" ? ctx.humanInput.note : undefined;
    return {
      kind: "transition",
      route,
      ...(note !== undefined && note.length > 0 ? { operatorNote: note } : {}),
      tokens: 0,
      costUsd: 0,
    } satisfies HandlerResult;
  };

  return { kind: "human", sideEffect: "none", maxMs: 1_000, handler };
}

function validateAndBuildMap(nodeId: string, routes: string[], edges: HumanHandlerEdge[]): Map<string, string> {
  if (routes.length === 0) {
    throw new Error(`human node "${nodeId}": at least one route is required`);
  }

  const declared = new Set(routes);
  const map = new Map<string, string>();

  for (const e of edges) {
    if (!declared.has(e.route)) {
      throw new Error(
        `human node "${nodeId}": edge route="${e.route}" is not in declared routes (${routes.join(", ")})`,
      );
    }
    if (map.has(e.route)) {
      throw new Error(`human node "${nodeId}": duplicate edge for route "${e.route}"`);
    }
    map.set(e.route, e.to);
  }

  for (const r of routes) {
    if (!map.has(r)) {
      throw new Error(`human node "${nodeId}": route "${r}" declared but no outgoing edge has route=${r}`);
    }
  }

  return map;
}

function normaliseRoute(raw: HumanInput | string): string {
  if (typeof raw === "string") return raw;
  return raw.route;
}
