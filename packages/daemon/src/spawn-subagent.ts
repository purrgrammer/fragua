// makeSpawnSubagent — the per-call factory that runs a sub-agent
// inline as a codergen call against the parent's event stream.
//
// A sub-agent is NOT a run. It can't be enqueued, can't be paused or
// resumed independently, and has no `run_state` row. It is a tool
// implementation that happens to use a separate LLM context window.
// All of its observability (`llm.start`, `llm.toolcall_*`,
// `cost.recorded`, `agent.turn_*`) flows onto the PARENT's event
// stream with a `subagent_id` discriminator stamped on the payload.
// Cost flows naturally into the parent's `metrics` because the
// parent's handler-bridge accumulates every `cost.recorded` event the
// emit channel sees, regardless of `subagent_id`.
//
// Two new observability event types bracket the slice:
//
//   subagent.start { subagent_id, parent_node_id, iteration, name?, provider, model }
//   subagent.end   { subagent_id, status, summary_chars, total_tool_calls, halt_reason? }
//
// No `fact.*` events for sub-agents — `fact.run_*` and `fact.node_*`
// carry run-level / node-level semantics that fire long tails of
// reducer / dispatcher / sweep / analytics logic on something that
// isn't a run or a node.

import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { materialiseForChild } from "@swarm/agent";
import type { CodergenBackend, ContextMap, EventType, ExecutionEnvironment, Node, Outcome } from "@swarm/core";
import { fail } from "@swarm/core";
import type { IEventStore } from "@swarm/store";
import type { AnyTool, Skill, SubagentResult, SubagentSpec, ToolRegistry } from "@swarm/workspace";
import { stripAgentTool } from "@swarm/workspace";

export interface SpawnSubagentDeps {
  store: IEventStore;
  registry: ToolRegistry;
  backend: CodergenBackend;
  shutdownSignal: AbortSignal;
}

export interface SpawnSubagentParentCtx {
  parentRunId: string;
  parentNodeId: string;
  parentIteration: number;
  parentSystemPrompt: string;
  /** Pre-rendered `<project-conventions>` block from the parent's
   *  `loadContextFiles` pass. Reused verbatim by the sub-agent so the
   *  child sees the same project primer (AGENTS.md and friends).
   *  Optional for back-compat with hand-rolled test fixtures; the
   *  spawner falls back to an empty block. */
  parentContextBlock?: string;
  /** Per-run isolation facts (cwd, bootstrap, runId) the parent saw.
   *  Sub-agents inherit verbatim — same worktree, same bootstrap. */
  parentRunEnv?: import("@swarm/agent").RunEnvironment;
  parentSkills: readonly Skill[];
  /** Provider/model the parent codergen call resolved to. The child
   *  inherits both verbatim — no per-call model selection from the LLM. */
  parentProvider: string;
  parentModel: string;
  /** Execution environment from the parent codergen call. The child's
   *  tool pool runs against the same env (no per-call worktree
   *  isolation in V1). */
  parentEnv: ExecutionEnvironment;
  /** Forwards every observability event the sub-agent emits onto the
   *  parent's stream with `subagent_id` stamped on the payload. The
   *  parent's handler-bridge supplies this — typically wraps
   *  `appendObservabilityEvents(parentRunId, …)`. Cost events flow
   *  through unchanged so the parent's terminal `fact.node_completed`
   *  rolls them in. */
  parentEmit: (type: EventType, data: Record<string, unknown>) => Promise<void>;
  parentAllowedTools?: readonly string[];
  parentDeniedTools?: readonly string[];
}

/** Distinct nodeId namespace for sub-agent transcript rows in the
 *  parent's `messages` table. Keeps the parent's main-thread
 *  `priorMessages` load uncontaminated by sub-agent turns. */
const SUBAGENT_NODE_PREFIX = "__subagent:";

/** Build a `spawnSubagent` closure scoped to one parent codergen call.
 *  Wired by the daemon into `PiCodergenBackend.spawnSubagentFactory`
 *  so `swarmContext.spawnSubagent` resolves per call. */
export function makeSpawnSubagent(
  deps: SpawnSubagentDeps,
  parentCtx: SpawnSubagentParentCtx,
): (spec: SubagentSpec) => Promise<SubagentResult> {
  return async (spec) => {
    const subagentId = randomUUID();
    const subagentNodeId = `${SUBAGENT_NODE_PREFIX}${subagentId}`;

    // Materialise the child's system prompt + filter parent skills by
    // `spec.skills` (intersection by name). System-prompt override on
    // the spec wins outright.
    const { systemPrompt: childSystemPrompt, effectiveSkills } = materialiseForChild(
      {
        ...(spec.system_prompt !== undefined ? { system_prompt: spec.system_prompt } : {}),
        ...(spec.skills !== undefined ? { skills: spec.skills } : {}),
      },
      {
        contextBlock: parentCtx.parentContextBlock ?? "",
        ...(parentCtx.parentRunEnv !== undefined ? { runEnv: parentCtx.parentRunEnv } : {}),
      },
      parentCtx.parentSkills,
    );

    // Tool pool: parent's pool, narrowed by `spec.allowed_tools` /
    // `spec.disallowed_tools`, then strip `agent` so children can't
    // recursively spawn. Parent-default keeps the "child ≤ parent"
    // invariant — the universal capability/process-tree shape; widen
    // the parent or pass `spec.allowed_tools` to opt out.
    const allow = spec.allowed_tools ?? parentCtx.parentAllowedTools;
    const deny = spec.disallowed_tools ?? parentCtx.parentDeniedTools;
    const childPool: AnyTool[] = stripAgentTool(
      deps.registry.select({
        ...(allow !== undefined ? { allow: [...allow] } : {}),
        ...(deny !== undefined ? { deny: [...deny] } : {}),
      }),
    );

    // Guard against degenerate configs: a parent that exposes only
    // `agent` (a pure spawn-only pool) leaves the child with nothing
    // after stripAgentTool. Don't burn tokens reasoning about how to
    // make progress with no tools — surface a clear halt to the LLM.
    if (childPool.length === 0) {
      const allowDesc = allow ? `[${[...allow].join(", ")}]` : "(unconstrained)";
      return {
        summary:
          `agent tool: cannot spawn sub-agent — resolved tool pool is empty (allowed_tools=${allowDesc}). ` +
          "Widen the parent's `allowed_tools` (it likely lists only `agent`), or pass an explicit " +
          "`allowed_tools: [...]` on the call.",
        subagentId: randomUUID(),
        status: "halted" as const,
        haltReason: "empty_tool_pool",
        totalToolCalls: 0,
      };
    }

    // Provider/model: a named-profile def (resolved by the `agent`
    // tool) can carry `model` / `provider` frontmatter, surfaced on
    // the spec as overrides. When unset the child inherits the
    // parent's choice verbatim.
    const childProvider = spec.provider ?? parentCtx.parentProvider;
    const childModel = spec.model ?? parentCtx.parentModel;

    // Synthetic node passed to the codergen backend. The backend
    // reads `system_prompt`, `allowed_tools`, `skills`, `llm_provider`,
    // `llm_model` off `node.attrs`. The nodeId itself isn't stored
    // anywhere persistent — it's only used to namespace messages in
    // the parent's transcript table.
    const node: Node = {
      id: subagentNodeId,
      shape: "box",
      classes: [],
      attrs: {
        ...(childSystemPrompt.length > 0 ? { system_prompt: childSystemPrompt } : {}),
        allowed_tools: childPool.map((t) => t.name),
        ...(effectiveSkills.length > 0 ? { skills: effectiveSkills.map((s) => s.name) } : {}),
        llm_provider: childProvider,
        llm_model: childModel,
        // No AGENTS.md auto-load — the parent's system prompt already
        // framed the persona; layering the project primer on top would
        // just inflate context.
        context_files: [],
      },
    };

    // Subagent-boundary marker on the parent's stream. Two independent
    // labels: `name` is the free-form caller label from inline
    // `agent({ name: <label> })`; `agent_def` is the resolved profile
    // name from `agent({ agent: <def-name> })`. Both can coexist
    // (`agent({ agent: "reviewer", name: "reviewer-1" })`), either
    // alone, or neither (a bare `agent({ prompt })` spawn). See
    // SubagentStartData in @swarm/core/types/events for the schema.
    await parentCtx.parentEmit("subagent.start", {
      subagent_id: subagentId,
      parent_node_id: parentCtx.parentNodeId,
      iteration: parentCtx.parentIteration,
      provider: childProvider,
      model: childModel,
      ...(spec.name !== undefined ? { name: spec.name } : {}),
      ...(spec.agentName !== undefined ? { agent_def: spec.agentName } : {}),
      ...(spec.tool_call_id !== undefined ? { tool_call_id: spec.tool_call_id } : {}),
    });

    // Forward every observability event the sub-agent emits to the
    // parent's stream. Two payload stamps happen here:
    //
    //   - `subagent_id` discriminates this sub-agent's slice from the
    //     parent's own events and from any sibling sub-agents running
    //     in parallel.
    //   - `nodeId` is set to `subagentNodeId` (overriding whatever the
    //     handler context's emit wrapper would default-stamp). Without
    //     this override, the sub-agent's `llm.start` / `cost.recorded`
    //     events would carry the PARENT'S nodeId, get folded into the
    //     parent's step in `getStepAggregates`, and silently inflate
    //     the parent step's totals with the sub-agent's spend. With
    //     the override, the sub-agent gets its own row in the steps
    //     view; the parent's calling node still sees the cost rolled
    //     up via the handler-bridge's per-turn accumulator.
    // Per-spawn cost rollup. Every `cost.recorded` the child forwards
    // increments these locals; we read them at `subagent.end` to stamp
    // the bracketed slice's totals onto the close marker. Cost still
    // flows through to the parent's handler-bridge accumulator (that's
    // what feeds the parent's terminal `fact.node_completed` /
    // `run_state.metrics`); this is a per-spawn view of the same
    // stream, not a duplicate accounting path. Field shape mirrors
    // `fact.node_aborted.partial*` for symmetry.
    let localCostUsd = 0;
    let localTotalTokens = 0;
    let localInputTokens = 0;
    let localOutputTokens = 0;
    let localCacheReadTokens = 0;
    let localCacheWriteTokens = 0;

    const subagentEmit = async (type: EventType, data: Record<string, unknown>): Promise<void> => {
      if (type === "cost.recorded") {
        // Payload shape from `packages/agent/src/event-bridge.ts:costPayload`.
        // Defensive `Number(... ?? 0)` keeps a malformed event from
        // poisoning the running totals — a NaN here would cascade onto
        // every subsequent spawn's rollup.
        const num = (v: unknown): number => {
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? n : 0;
        };
        localCostUsd += num(data["cost_usd"]);
        localTotalTokens += num(data["total_tokens"]);
        localInputTokens += num(data["input_tokens"]);
        localOutputTokens += num(data["output_tokens"]);
        localCacheReadTokens += num(data["cache_read_tokens"]);
        localCacheWriteTokens += num(data["cache_write_tokens"]);
      }
      await parentCtx.parentEmit(type, {
        ...data,
        nodeId: subagentNodeId,
        subagent_id: subagentId,
      });
    };

    // Capture the sub-agent's last assistant message + tool-call count
    // off the persistMessage stream as it lands. Each sub-agent
    // message also lands in the parent's `messages` table under the
    // distinct `subagentNodeId` so it doesn't pollute the parent's
    // main-thread `priorMessages` on subsequent dispatches.
    let lastAssistantSummary = "";
    let totalToolCalls = 0;
    const persistMessage = (message: AgentMessage): void => {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        const blocks = message.content as Array<{ type: string; text?: string }>;
        const text = blocks
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("\n");
        if (text.length > 0) lastAssistantSummary = text;
        for (const b of blocks) if (b.type === "toolCall") totalToolCalls += 1;
      }
      deps.store.appendMessage(parentCtx.parentRunId, {
        content: message,
        nodeId: subagentNodeId,
        iteration: 0,
      });
    };

    // Cancellation: thread the tool's signal + the daemon shutdown
    // signal into a fresh AbortController that the codergen call
    // listens on. No DB intent — there's no child run to cancel via
    // the standard fold; abort propagation is purely in-process.
    const childCtrl = new AbortController();
    const onParentAbort = () => childCtrl.abort();
    if (spec.signal) {
      if (spec.signal.aborted) childCtrl.abort();
      else spec.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    const onShutdown = () => childCtrl.abort();
    if (deps.shutdownSignal.aborted) childCtrl.abort();
    else deps.shutdownSignal.addEventListener("abort", onShutdown, { once: true });

    let outcome: Outcome;
    try {
      outcome = await deps.backend.run({
        node,
        prompt: spec.prompt,
        // Sub-agent gets a fresh context — no inherited routing
        // substitutions. The LLM constructed the prompt to be
        // self-contained.
        context: {} as ContextMap,
        // Distinct thread keeps the sub-agent's pi-ai message store
        // separate from the parent's main thread. The backend keys its
        // in-process MessageStore by (runId, threadId).
        thread_id: subagentNodeId,
        fidelity: "full",
        signal: childCtrl.signal,
        run_id: parentCtx.parentRunId,
        // No workflow document for a sub-agent. Empty string is the
        // backend's accepted sentinel for "no workflow context".
        workflow_sha: "",
        // The caller (the parent's LLM) constructed the tool call
        // expecting a specific context shape. Suppress framework
        // injection (`<protocol>`, skills catalog, env-info, global
        // persona) so the sub-agent's system prompt is exactly what
        // the caller passed via `spec.system_prompt` — or empty when
        // omitted. The skills filter still drives the sub-agent's
        // available skill files / tool surface; nothing auto-renders
        // into the system prompt.
        skipFrameworkSystemPrompt: true,
        // Persist the system prompt as a `role:'system'` message — the
        // operator wants to see the sub-agent's full transcript
        // (system + user + assistant + tool turns) inside the
        // embedded card on the parent's conversation view. Backend
        // skips this write when the system prompt is empty, so a
        // no-system-prompt spawn naturally produces no system row.
        env: parentCtx.parentEnv,
        emit: subagentEmit,
        persistMessage,
        ...(spec.max_iterations !== undefined ? { iteration: { n: 0, max: spec.max_iterations } } : {}),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcome = fail(detail);
    } finally {
      if (spec.signal) spec.signal.removeEventListener("abort", onParentAbort);
      deps.shutdownSignal.removeEventListener("abort", onShutdown);
    }

    const status = mapOutcomeStatus(outcome, childCtrl.signal.aborted);
    const haltReason = deriveHaltReason(outcome, status);

    await parentCtx.parentEmit("subagent.end", {
      subagent_id: subagentId,
      status,
      summary_chars: lastAssistantSummary.length,
      total_tool_calls: totalToolCalls,
      costUsd: localCostUsd,
      totalTokens: localTotalTokens,
      inputTokens: localInputTokens,
      outputTokens: localOutputTokens,
      cacheReadTokens: localCacheReadTokens,
      cacheWriteTokens: localCacheWriteTokens,
      ...(haltReason !== undefined ? { halt_reason: haltReason } : {}),
    });

    const result: SubagentResult = {
      summary: lastAssistantSummary,
      subagentId,
      status,
      totalToolCalls,
    };
    if (haltReason !== undefined) result.haltReason = haltReason;
    return result;
  };
}

function mapOutcomeStatus(outcome: Outcome, aborted: boolean): SubagentResult["status"] {
  if (aborted) return "cancelled";
  if (outcome.status === "success" || outcome.status === "partial_success") return "completed";
  return "halted";
}

function deriveHaltReason(outcome: Outcome, status: SubagentResult["status"]): string | undefined {
  if (status === "completed") return undefined;
  if (outcome.provider_error) return "provider_exhausted";
  return outcome.failure_reason ?? undefined;
}
