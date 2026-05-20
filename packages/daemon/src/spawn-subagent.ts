// makeSpawnSubagent — the per-call factory that runs a sub-agent
// inline as a llm call against the parent's event stream.
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

import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { materialiseForChild } from "@swarm/agent";
import type { EventType, ExecutionEnvironment, LlmBackend, Node, Outcome } from "@swarm/core";
import { fail } from "@swarm/core";
import type { IEventStore } from "@swarm/store";
import type { AnyTool, Skill, SubagentResult, SubagentSpec, ToolRegistry } from "@swarm/workspace";
import { stripAgentTool } from "@swarm/workspace";

export interface SpawnSubagentDeps {
  store: IEventStore;
  registry: ToolRegistry;
  backend: LlmBackend;
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
  /** Provider/model the parent llm call resolved to. The child
   *  inherits both verbatim — no per-call model selection from the LLM. */
  parentProvider: string;
  parentModel: string;
  /** Execution environment from the parent llm call. The child's
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

/** Build a `spawnSubagent` closure scoped to one parent llm call.
 *  Wired by the daemon into `PiLlmBackend.spawnSubagentFactory`
 *  so `swarmContext.spawnSubagent` resolves per call. */
export function makeSpawnSubagent(
  deps: SpawnSubagentDeps,
  parentCtx: SpawnSubagentParentCtx,
): (spec: SubagentSpec) => Promise<SubagentResult> {
  return async (spec) => {
    // Subagent identity, two paths:
    //
    //   1. Content-addressed pending-resume lookup. When `spec.args_hash`
    //      is set, look for a prior bracket in this parent's
    //      `(parent_node_id, iteration)` scope whose `subagent.start`
    //      carries a matching `args_hash` AND whose latest terminal is
    //      `subagent.end{status:"cancelled"}` with no subsequent
    //      `subagent.resumed`. Pop the OLDEST such bracket — its
    //      `subagent_id` becomes ours, so the existing hydration path
    //      below replays its transcript and the spawn emits
    //      `subagent.resumed` instead of `subagent.start`. This is what
    //      lets a parent retry that uses byte-identical agent-tool args
    //      automatically resume the sub-agent's work-so-far after a
    //      budget pause / provider error / operator pause, without the
    //      LLM having to remember a resume id.
    //
    //   2. Fresh deterministic id: sha256(parentRunId, parentNodeId,
    //      parentIteration, tool_call_id) truncated to 32 hex chars.
    //      Survives a daemon crash because pi-ai preserves `tool_call_id`
    //      byte-identically on the wire (anthropic.js:847), and the other
    //      inputs are stable across restarts. Two parallel siblings on
    //      one assistant message share parentIteration but get distinct
    //      tool_call_ids from pi-ai, so they hash to distinct ids
    //      without collision-handling.
    const resumeCandidateId =
      spec.args_hash !== undefined ? findPendingResumeCandidate(deps.store, parentCtx, spec.args_hash) : undefined;
    const freshSubagentId = createHash("sha256")
      .update(
        `${parentCtx.parentRunId}\u0000${parentCtx.parentNodeId}\u0000${parentCtx.parentIteration}\u0000${spec.tool_call_id}`,
      )
      .digest("hex")
      .slice(0, 32);
    const subagentId = resumeCandidateId ?? freshSubagentId;
    const subagentNodeId = `${SUBAGENT_NODE_PREFIX}${subagentId}`;

    // Crash-resilience: hydrate the prior transcript for this
    // deterministic subagent_id. On a fresh spawn the lookup returns
    // [] and the backend runs from zero. On a respawn after a daemon
    // crash, the messages table holds the pre-crash turns under
    // `__subagent:<id>`; the backend feeds them into pi-agent-core's
    // initialState so the child picks up where it left off. System
    // rows are stripped — pi-ai carries the system prompt separately
    // (PiLlmBackend rebuilds it per call) and double-feeding
    // would inject a stray turn into the transcript.
    const priorMessages: AgentMessage[] = deps.store
      .getMessages(parentCtx.parentRunId, { nodeId: subagentNodeId })
      .map((r) => r.content as AgentMessage)
      .filter((m) => m.role !== "system");

    // Cumulative cost rollup baseline. On a fresh spawn the lookup
    // returns [] and the seeds stay 0. On a respawn after a daemon
    // crash, every prior `subagent.end` for this deterministic
    // `subagent_id` carries the partial cost from its bracket; the
    // resumed bracket's `subagent.end.costUsd` is **cumulative** —
    // operators reading the latest bracket get the truthful end-to-end
    // cost of the logical sub-agent's work without scanning siblings.
    // Consumers summing across `subagent.end` rows MUST dedupe by
    // `subagent_id` and take the terminal (non-cancelled) bracket;
    // see ARCH §3 and `docs/proposals/sub-agent-crash-resilience.md`.
    const priorEnds = deps.store
      .getEventsByType(parentCtx.parentRunId, "subagent.end")
      .filter((e) => (e.payload as { subagent_id?: string }).subagent_id === subagentId);
    const priorNum = (v: unknown): number => {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const seedCostUsd = priorEnds.reduce((s, e) => s + priorNum((e.payload as Record<string, unknown>)["costUsd"]), 0);
    const seedTotalTokens = priorEnds.reduce(
      (s, e) => s + priorNum((e.payload as Record<string, unknown>)["totalTokens"]),
      0,
    );
    const seedInputTokens = priorEnds.reduce(
      (s, e) => s + priorNum((e.payload as Record<string, unknown>)["inputTokens"]),
      0,
    );
    const seedOutputTokens = priorEnds.reduce(
      (s, e) => s + priorNum((e.payload as Record<string, unknown>)["outputTokens"]),
      0,
    );
    const seedCacheReadTokens = priorEnds.reduce(
      (s, e) => s + priorNum((e.payload as Record<string, unknown>)["cacheReadTokens"]),
      0,
    );
    const seedCacheWriteTokens = priorEnds.reduce(
      (s, e) => s + priorNum((e.payload as Record<string, unknown>)["cacheWriteTokens"]),
      0,
    );

    // Resume decision: either we matched a content-addressed pending
    // candidate (resumeCandidateId) or this id already has a persisted
    // transcript (crash-resilience). Emit `subagent.resumed` once,
    // EAGERLY — before any await that could let a parallel sibling's
    // findPendingResumeCandidate observe this bracket as still
    // pending. bun:sqlite writes are synchronous, so the resumed
    // event lands in the store inside the call below; sibling
    // findPendingResumeCandidate calls running on the next microtask
    // see it as consumed (subagentIdsConsumed) and pick a different
    // candidate or fall back to a fresh id.
    const isAlreadyComplete = priorMessages.length > 0 && isTranscriptComplete(priorMessages);
    const isResume = resumeCandidateId !== undefined || priorMessages.length > 0;
    if (isResume) {
      await parentCtx.parentEmit("subagent.resumed", {
        subagent_id: subagentId,
        reason: isAlreadyComplete ? "already_completed" : "transcript_hydrated",
      });
    }

    // Already-completed short-circuit: the sub-agent finished pre-crash
    // (last assistant message has stopReason ∈ {stop, endTurn} and no
    // pending toolCalls), but the daemon died before the parent's tool-
    // execute promise resolved. Skip the LLM call entirely; synthesise
    // SubagentResult from the persisted transcript and emit the close
    // marker. `subagent.resumed` already fired above. We do NOT emit
    // `subagent.start` — the original start is still in the event log
    // from the pre-crash bracket; the new resumed→end pair closes the
    // gap and the new end carries the cumulative totals.
    if (isAlreadyComplete) {
      const summary = extractAssistantText(priorMessages[priorMessages.length - 1]!);
      const totalToolCalls = countToolCalls(priorMessages);
      await parentCtx.parentEmit("subagent.end", {
        subagent_id: subagentId,
        status: "completed",
        summary_chars: summary.length,
        total_tool_calls: totalToolCalls,
        costUsd: seedCostUsd,
        totalTokens: seedTotalTokens,
        inputTokens: seedInputTokens,
        outputTokens: seedOutputTokens,
        cacheReadTokens: seedCacheReadTokens,
        cacheWriteTokens: seedCacheWriteTokens,
      });
      return {
        summary,
        subagentId,
        status: "completed",
        totalToolCalls,
      };
    }

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
        subagentId,
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

    // Synthetic node passed to the llm backend. The backend
    // reads `system_prompt`, `allowed_tools`, `skills`, `llm_provider`,
    // `llm_model` off `node.attrs`. The nodeId itself isn't stored
    // anywhere persistent — it's only used to namespace messages in
    // the parent's transcript table.
    const node: Node = {
      id: subagentNodeId,
      type: "llm",
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
    //
    // Skipped on resume (content-addressed pending-resume match OR
    // crash-resilience rehydrate): the original `subagent.start` is
    // already in the event log from the pre-resume bracket carrying
    // this same `subagent_id`, and the `subagent.resumed` event
    // emitted above closes the gap. Emitting a second `subagent.start`
    // would create the appearance of two distinct spawns sharing an
    // id, which UI grouping + cumulative-cost folds aren't designed
    // to handle.
    if (!isResume) {
      await parentCtx.parentEmit("subagent.start", {
        subagent_id: subagentId,
        parent_node_id: parentCtx.parentNodeId,
        iteration: parentCtx.parentIteration,
        provider: childProvider,
        model: childModel,
        ...(spec.name !== undefined ? { name: spec.name } : {}),
        ...(spec.agentName !== undefined ? { agent_def: spec.agentName } : {}),
        tool_call_id: spec.tool_call_id,
        ...(spec.args_hash !== undefined ? { args_hash: spec.args_hash } : {}),
      });
    }

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
    let localCostUsd = seedCostUsd;
    let localTotalTokens = seedTotalTokens;
    let localInputTokens = seedInputTokens;
    let localOutputTokens = seedOutputTokens;
    let localCacheReadTokens = seedCacheReadTokens;
    let localCacheWriteTokens = seedCacheWriteTokens;

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
    // signal into a fresh AbortController that the llm call
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
        // Distinct thread keeps the sub-agent's pi-ai message store
        // separate from the parent's main thread. The backend keys its
        // in-process MessageStore by (runId, threadId).
        thread_id: subagentNodeId,
        signal: childCtrl.signal,
        run_id: parentCtx.parentRunId,
        // No workflow document for a sub-agent. Empty string is the
        // backend's accepted sentinel for "no workflow context".
        workflow_sha: "",
        // The caller (the parent's LLM) constructed the tool call
        // expecting a specific context shape. Suppress framework
        // injection (skills catalog, env-info, global persona) so the
        // sub-agent's system prompt is exactly what
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
        ...(priorMessages.length > 0 ? { priorMessages } : {}),
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
  if (outcome.status === "success") return "completed";
  return "halted";
}

function deriveHaltReason(outcome: Outcome, status: SubagentResult["status"]): string | undefined {
  if (status === "completed") return undefined;
  if (outcome.provider_error) return "provider_exhausted";
  return outcome.failure_reason ?? undefined;
}

/** True when a persisted sub-agent transcript represents a finished
 *  conversation: last message is an assistant with `stopReason ===
 *  "stop"` (pi-ai's universal terminal-without-toolcall reason — see
 *  pi-ai/dist/providers/*.js) and no toolCall blocks pending. The
 *  pre-crash spawn produced a final answer; the only thing missing
 *  from the parent's stream is the toolResult — which we synthesise
 *  on resume without burning another LLM turn. */
function isTranscriptComplete(messages: readonly AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (last.stopReason !== "stop") return false;
  if (!Array.isArray(last.content)) return true;
  return !last.content.some((b: { type: string }) => b.type === "toolCall");
}

/** Concatenate every text block in an assistant message. Mirrors the
 *  reduction the spawn-side `persistMessage` does inline so a resumed
 *  bracket's `summary` matches the value the original (pre-crash)
 *  `SubagentResult.summary` would have carried. */
function extractAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

/** Count toolCall blocks across every assistant message in a
 *  transcript. Matches the in-flight `totalToolCalls` accumulator
 *  the live-run path maintains so resumed brackets surface the same
 *  count the original spawn would have. */
function countToolCalls(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string }>) {
      if (b.type === "toolCall") n += 1;
    }
  }
  return n;
}

/** Find the oldest cancelled-pending sub-agent bracket for this
 *  parent's `(parent_node_id, iteration)` scope whose `subagent.start`
 *  carries a matching `args_hash`. "Cancelled-pending" = latest
 *  terminal is `subagent.end{status:"cancelled"}` with no subsequent
 *  `subagent.resumed{subagent_id}` consuming it.
 *
 *  Returns the matched `subagent_id` so the caller can reuse it as
 *  the new spawn's id — the existing hydration path then replays the
 *  prior transcript and emits `subagent.resumed`, which makes the
 *  next call see this bracket as consumed.
 *
 *  Same-args parallel siblings: each consumes ONE pending entry per
 *  spawn (FIFO). The caller's existing fresh-id path handles the
 *  overflow when more new spawns arrive than there are pending ones
 *  to match. */
function findPendingResumeCandidate(
  store: IEventStore,
  parentCtx: SpawnSubagentParentCtx,
  argsHash: string,
): string | undefined {
  const starts = store.getEventsByType(parentCtx.parentRunId, "subagent.start");
  const ends = store.getEventsByType(parentCtx.parentRunId, "subagent.end");
  const resumes = store.getEventsByType(parentCtx.parentRunId, "subagent.resumed");
  // Per subagent_id, track:
  //   - latest `subagent.end` (status + seq) — the bracket's current
  //     terminal disposition;
  //   - latest `subagent.resumed` seq — whether the most-recent
  //     cancellation has already been claimed by a re-spawn.
  // A bracket is pending iff its latest end is "cancelled" AND no
  // subagent.resumed has fired SINCE that end. The previous "any
  // resumed → forever consumed" check broke multi-pause cycles: a
  // bracket that gets resumed, then re-cancelled by a second pause,
  // should be pending again (its latest end is a fresh cancellation
  // with no following resumed). Without the seq-relative check,
  // every retry past the first mints fresh ids and the sub-agent's
  // accumulated transcript is silently abandoned each subsequent
  // pause/resume cycle (operator-resume AND raise-and-resume).
  const latestEnd = new Map<string, { status: string; seq: number }>();
  for (const e of ends) {
    const p = e.payload as { subagent_id?: string; status?: string };
    if (typeof p.subagent_id !== "string" || typeof p.status !== "string") continue;
    const prior = latestEnd.get(p.subagent_id);
    if (prior === undefined || e.seq > prior.seq) {
      latestEnd.set(p.subagent_id, { status: p.status, seq: e.seq });
    }
  }
  const latestResumedSeq = new Map<string, number>();
  for (const r of resumes) {
    const sid = (r.payload as { subagent_id?: string }).subagent_id;
    if (typeof sid !== "string") continue;
    const prior = latestResumedSeq.get(sid);
    if (prior === undefined || r.seq > prior) latestResumedSeq.set(sid, r.seq);
  }
  // Walk starts in seq order (getEventsByType returns ASC) so the
  // FIRST pending match is the oldest — the FIFO semantic.
  for (const s of starts) {
    const p = s.payload as {
      subagent_id?: string;
      parent_node_id?: string;
      iteration?: number;
      args_hash?: string;
    };
    if (typeof p.subagent_id !== "string") continue;
    if (p.parent_node_id !== parentCtx.parentNodeId) continue;
    if (p.iteration !== parentCtx.parentIteration) continue;
    if (p.args_hash !== argsHash) continue;
    const end = latestEnd.get(p.subagent_id);
    if (end === undefined || end.status !== "cancelled") continue;
    const resumedSeq = latestResumedSeq.get(p.subagent_id) ?? 0;
    if (resumedSeq > end.seq) continue; // claimed since last cancel → consumed
    return p.subagent_id;
  }
  return undefined;
}
