// parallel.fan_in handler.
//
// Consumes `parallel.<parallelNodeId>.results` from routing (written by
// the parallel handler in the preceding node), feeds the candidates to
// either a deterministic heuristic or an LLM delegate, and publishes the
// winner back into routing under `fan_in.<nodeId>.winner` so downstream
// codergen/tool nodes can reference it via `${context.fan_in.*}`
// substitution.
//
// Two evaluation paths (attractor §4.9):
//
//   Heuristic (prompt= absent/empty):
//     `foldFanIn` ranks candidates by (status, -score, branchId) and
//     picks the top. Zero cost; deterministic; replay-safe.
//
//   LLM (prompt= set):
//     A delegate function (supplied by the daemon layer via
//     `FanInHandlerConfig.evaluator`) synthesises the branch outputs
//     into a prompt and calls an LLM. The LLM must call `emit_output`
//     with `{winner: <branchId>}`. The delegate also has access to
//     `context_set` so it can publish cross-cutting findings the
//     downstream codergen consumes via `${context.<key>}`.

import { FAN_IN_VERSION, type FanInCandidate, foldFanIn } from "../../engine/fan-in.ts";
import { substitute } from "../../engine/substitution.ts";
import type { NodeAttrs } from "../../types/graph.ts";
import type { Handler, HandlerResult, HandlerSpec } from "../types.ts";

// ── LLM delegate types (no agent import — dep direction: core ← agent) ──

export interface LlmFanInInput {
  /** The fan-in node's own id. */
  nodeId: string;
  /** All branch candidates (same slice that heuristic foldFanIn would see). */
  candidates: FanInCandidate[];
  /** Resolved `$<branchId>.output` text for each candidate, keyed by branchId. */
  branchOutputs: ReadonlyMap<string, string>;
  /** The substituted fan-in prompt. */
  prompt: string;
  /** Raw node attrs of the tripleoctagon (carries llm_model, llm_provider, etc.). */
  nodeAttrs: NodeAttrs;
  /** Composed abort signal. */
  signal: AbortSignal;
}

export interface LlmFanInSuccess {
  winner: string;
  contextWrites?: Array<{
    key: string;
    value: string | number | boolean | null;
    prevValue?: string | number | boolean | null;
  }>;
  tokens?: number;
  costUsd?: number;
  modelName?: string;
}

export interface LlmFanInFailure {
  failure: {
    reason: "fan_in_llm_emit_missing" | "fan_in_llm_picked_unknown_branch" | "fan_in_llm_provider_error";
    detail: string;
  };
}

export type LlmFanInResult = LlmFanInSuccess | LlmFanInFailure;

export type LlmFanInDelegate = (input: LlmFanInInput) => Promise<LlmFanInResult>;

// ── Handler config ───────────────────────────────────────────────────────

export interface FanInHandlerConfig {
  /** Id of the `parallel` node whose results we consume. The parallel
   * handler writes to `parallel.<parallelNodeId>.results`, which this
   * handler reads back. */
  parallelNodeId: string;
  /** When set, short-circuits edge selection. Leave unset to defer to
   * the executor's 5-rule priority on outgoing unconditional edges. */
  nextNode?: string;
  /** Hard timeout. 1 second is plenty for the heuristic path. LLM path
   * is unbounded — it inherits the run's budget/signal instead. */
  maxMs?: number;
  /** When present, use an LLM delegate to pick the winner instead of the
   * deterministic heuristic. The delegate is supplied by the daemon layer
   * so `@swarm/core` stays free of `@swarm/agent` imports. */
  evaluator?: {
    kind: "llm";
    /** Raw `prompt=` value from the tripleoctagon node (not yet substituted). */
    prompt: string;
    /** The delegate that calls the LLM. */
    delegate: LlmFanInDelegate;
    /** Raw node attrs of the tripleoctagon, used to thread llm_model etc. */
    nodeAttrs: NodeAttrs;
  };
}

const DEFAULT_MAX_MS = 1_000;

export function makeFanInHandler(cfg: FanInHandlerConfig): HandlerSpec {
  const handler: Handler = async (ctx) => {
    const resultsKey = `parallel.${cfg.parallelNodeId}.results`;
    const raw = ctx.routing[resultsKey];
    if (!Array.isArray(raw) || raw.length === 0) {
      return {
        kind: "halt",
        reason: "error",
        detail: `fan_in "${ctx.nodeId}": no results under routing.${resultsKey}`,
      } satisfies HandlerResult;
    }

    const candidates: FanInCandidate[] = [];
    for (const r of raw) {
      if (r == null || typeof r !== "object") continue;
      const branchId = (r as { branchId?: unknown }).branchId;
      const status = (r as { status?: unknown }).status;
      if (typeof branchId !== "string" || typeof status !== "string") continue;
      const score = (r as { score?: unknown }).score;
      const cand: FanInCandidate = { branchId, status: status as FanInCandidate["status"] };
      if (typeof score === "number") cand.score = score;
      candidates.push(cand);
    }

    // ── LLM evaluation path ────────────────────────────────────────────
    if (cfg.evaluator?.kind === "llm") {
      const ev = cfg.evaluator;

      // Build branchOutputs map from nodeOutputs.
      const branchOutputs = new Map<string, string>();
      for (const cand of candidates) {
        const no = ctx.nodeOutputs.get(cand.branchId);
        branchOutputs.set(cand.branchId, no?.output ?? "");
      }

      // Substitute the prompt so ${context.*} / $ARGUMENTS / $node.output tokens resolve.
      const substitutedPrompt = substitute(ev.prompt, {
        args: ctx.args,
        context: buildContext(ctx.routing),
        nodeOutputs: ctx.nodeOutputs,
      });

      let delegateResult: LlmFanInResult;
      try {
        delegateResult = await ev.delegate({
          nodeId: ctx.nodeId,
          candidates,
          branchOutputs,
          prompt: substitutedPrompt,
          nodeAttrs: ev.nodeAttrs,
          signal: ctx.signal,
        });
      } catch (err) {
        return {
          kind: "halt",
          reason: "error",
          detail: `fan_in "${ctx.nodeId}": delegate threw — ${err instanceof Error ? err.message : String(err)}`,
        } satisfies HandlerResult;
      }

      // Failure discriminator.
      if ("failure" in delegateResult) {
        return {
          kind: "halt",
          reason: "error",
          detail: `fan_in "${ctx.nodeId}": ${delegateResult.failure.reason} — ${delegateResult.failure.detail}`,
        } satisfies HandlerResult;
      }

      const { winner: chosenId, contextWrites, tokens = 0, costUsd = 0, modelName } = delegateResult;

      // Validate winner is in candidate set.
      const candidateIds = candidates.map((c) => c.branchId);
      if (!candidateIds.includes(chosenId)) {
        return {
          kind: "halt",
          reason: "error",
          detail: `fan_in "${ctx.nodeId}": fan_in_llm_picked_unknown_branch — chose "${chosenId}", candidates: ${candidateIds.join(", ")}`,
        } satisfies HandlerResult;
      }

      const allFailed = candidates.every((c) => c.status === "fail");
      const outcomeStatus: "success" | "fail" = allFailed ? "fail" : "success";

      // Ranked order: winner first, then remaining candidates in their
      // original order (LLM doesn't provide a full ranking).
      const rankedOrder = [chosenId, ...candidateIds.filter((id) => id !== chosenId)];

      ctx.emit("fan_in.completed", {
        fanInNodeId: ctx.nodeId,
        parallelNodeId: cfg.parallelNodeId,
        winner: chosenId,
        allFailed,
        rankedOrder,
        evaluator: "llm",
        tokens,
        costUsd,
        ...(modelName !== undefined ? { modelName } : {}),
      });

      const winnerKey = `fan_in.${ctx.nodeId}.winner`;
      const allFailedKey = `fan_in.${ctx.nodeId}.all_failed`;
      const routingDelta: Record<string, unknown> = {
        [winnerKey]: chosenId,
        [allFailedKey]: allFailed,
      };

      // Fold context_set writes into routingDelta.
      if (contextWrites != null) {
        for (const entry of contextWrites) {
          routingDelta[entry.key] = entry.value;
        }
      }

      const result: HandlerResult = {
        kind: "transition",
        outcomeStatus,
        tokens,
        costUsd,
        routingDelta,
        ...(contextWrites != null && contextWrites.length > 0 ? { contextWriteLog: contextWrites } : {}),
        ...(modelName !== undefined ? { modelName } : {}),
      };
      if (cfg.nextNode !== undefined) result.nextNode = cfg.nextNode;
      return result;
    }

    // ── Heuristic path (no prompt / no evaluator) ─────────────────────

    // Read the version the parallel handler pinned. Pre-pinning runs
    // (no key written) default to v1 — the only version that existed
    // before pinning. Replay of an old run thus stays byte-identical
    // even if FAN_IN_VERSION has been bumped since.
    const versionKey = `parallel.${cfg.parallelNodeId}.fan_in_version`;
    const pinnedRaw = ctx.routing[versionKey];
    const pinnedVersion = typeof pinnedRaw === "number" && pinnedRaw > 0 ? pinnedRaw : 1;

    let winner: FanInCandidate | null;
    let ranked: FanInCandidate[];
    let allFailed: boolean;
    try {
      ({ winner, ranked, allFailed } = foldFanIn(candidates, pinnedVersion));
    } catch (err) {
      return {
        kind: "halt",
        reason: "error",
        detail: `fan_in "${ctx.nodeId}": ${err instanceof Error ? err.message : String(err)}`,
      } satisfies HandlerResult;
    }
    const outcomeStatus: "success" | "fail" = allFailed ? "fail" : "success";

    ctx.emit("fan_in.completed", {
      fanInNodeId: ctx.nodeId,
      parallelNodeId: cfg.parallelNodeId,
      winner: winner?.branchId ?? null,
      allFailed,
      rankedOrder: ranked.map((r) => r.branchId),
      version: pinnedVersion,
      currentVersion: FAN_IN_VERSION,
      evaluator: "heuristic",
      tokens: 0,
      costUsd: 0,
    });

    const winnerKey = `fan_in.${ctx.nodeId}.winner`;
    const allFailedKey = `fan_in.${ctx.nodeId}.all_failed`;
    const result: HandlerResult = {
      kind: "transition",
      outcomeStatus,
      tokens: 0,
      costUsd: 0,
      routingDelta: {
        [winnerKey]: winner?.branchId ?? null,
        [allFailedKey]: allFailed,
      },
    };
    if (cfg.nextNode !== undefined) result.nextNode = cfg.nextNode;
    return result;
  };

  return {
    kind: "parallel.fan_in",
    sideEffect: "none",
    // When LLM evaluation is configured, the operation is effectively
    // unbounded (inherits run budget / signal). Omit maxMs so the
    // executor applies no AbortSignal.timeout. Heuristic path stays at
    // the 1-second backstop — it's a pure reducer, no I/O.
    ...(cfg.evaluator?.kind === "llm" ? {} : { maxMs: cfg.maxMs ?? DEFAULT_MAX_MS }),
    handler,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Build a `ContextMap` from raw routing (mirror of handler-bridge's mergeContext). */
function buildContext(routing: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(routing)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}
