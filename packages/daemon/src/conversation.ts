// runConversation — the executor entry point for `kind='conversation'`
// runs (sub-agents spawned by the `agent` tool).
//
// A conversation run has no DOT graph: the spec was constructed by the
// LLM in the parent's codergen turn and lives entirely on
// `run_state.routing` keys (`agent.system_prompt`, `agent.tool_pool`,
// `agent.skills`, `agent.max_iterations`, `agent.label`, plus the
// usual `input`). This entry point loads those, drives a single
// codergen call against `CodergenBackend.run`, and writes terminal
// facts to the child run's stream.
//
// No graph walk, no edge selection, no handler dispatcher. The
// existing `PiCodergenBackend` already knows how to drive an
// `Agent.prompt(...) + waitForIdle()` to terminal — we lean on it
// rather than duplicating the loop.

import type { CodergenBackend, ContextMap, Node, Outcome } from "@swarm/core";
import { fail } from "@swarm/core";
import type { FactEvent, IEventStore } from "@swarm/store";
import { ConcurrencyError } from "@swarm/store";

export interface RunConversationDeps {
  store: IEventStore;
  backend: CodergenBackend;
  shutdownSignal: AbortSignal;
  /** Optional clock override for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** Synthesises the codergen input for a conversation run from its
 *  routing snapshot, calls the backend, and writes the terminal fact.
 *  Throws nothing on agent error — errors collapse to
 *  `fact.run_halted{reason:"error"}` so the child reaches a terminal
 *  status the parent can read. */
export async function runConversation(runId: string, deps: RunConversationDeps): Promise<void> {
  const state = deps.store.getState(runId);
  if (state == null) return;
  if (state.kind !== "conversation") {
    throw new Error(`runConversation called on non-conversation run ${runId} (kind=${state.kind})`);
  }
  if (state.status !== "queued" && state.status !== "running") {
    return;
  }

  const routing = state.routing;
  const prompt = readString(routing, "input") ?? "";
  const systemPrompt = readString(routing, "agent.system_prompt") ?? "";
  const allowedTools = readStringArray(routing, "agent.tool_pool");
  const skillNames = readStringArray(routing, "agent.skills");
  const maxIterations = readNumber(routing, "agent.max_iterations");
  const label = readString(routing, "agent.label");

  // Synthetic node: the codergen backend keys off attrs to derive the
  // tool pool, skills filter, and per-node system prompt.
  const node: Node = {
    id: "agent",
    shape: "box",
    classes: [],
    attrs: {
      ...(systemPrompt.length > 0 ? { system_prompt: systemPrompt } : {}),
      ...(allowedTools.length > 0 ? { allowed_tools: [...allowedTools] } : {}),
      ...(skillNames.length > 0 ? { skills: [...skillNames] } : {}),
      // Conversation runs don't auto-load AGENTS.md — the parent's
      // system prompt already framed the persona; layering the project
      // primer on top would just inflate context.
      context_files: [],
    },
  };

  // Mark the run started so the projection flips to `running`.
  // Conversation runs carry no workflow_sha; pass null per the v5
  // schema.
  await tryAppendFact(deps.store, runId, state.version, [
    {
      type: "fact.run_started",
      payload: {
        workflowSha: null,
        schemaVersion: state.schemaVersion,
        startNode: "agent",
      },
    },
  ]);

  // Re-read state for the post-`run_started` version.
  const startedState = deps.store.getState(runId);
  if (startedState == null) return;

  const context: ContextMap = {};
  for (const [k, v] of Object.entries(routing)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      context[k] = v as ContextMap[string];
    }
  }

  const iteration = typeof maxIterations === "number" ? { n: 0, max: maxIterations } : undefined;

  let outcome: Outcome;
  try {
    outcome = await deps.backend.run({
      node,
      prompt,
      context,
      thread_id: undefined,
      fidelity: "full",
      signal: deps.shutdownSignal,
      run_id: runId,
      // Conversation runs have no workflow_sha; pass empty string —
      // the fidelity layer already accepts "" as a sentinel.
      workflow_sha: "",
      ...(iteration !== undefined ? { iteration } : {}),
      persistMessage: (message) => {
        deps.store.appendMessage(runId, {
          content: message,
          nodeId: "agent",
          iteration: 0,
        });
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    outcome = fail(detail);
  }

  // Map outcome → terminal fact on the child stream.
  const terminal: FactEvent = mapOutcomeToTerminal(outcome);
  await tryAppendFact(deps.store, runId, startedState.version, [terminal]);

  // `label` is observability-only; surface it on the run's own stream
  // for replay/UI. Use the observability writer (no version bump).
  if (label !== undefined && label.length > 0) {
    deps.store.appendObservabilityEvents(runId, [{ type: "agent.info", payload: { label } }]);
  }
}

function mapOutcomeToTerminal(outcome: Outcome): FactEvent {
  // Outcome.status discriminates success / fail / retry / skipped.
  // Conversation runs collapse retry/skipped into halt because they
  // have no graph to retarget against — the parent's `agent` tool sees
  // the failure and decides what to do next.
  if (outcome.status === "success" || outcome.status === "partial_success") {
    return { type: "fact.run_completed", payload: { finalNode: "agent" } };
  }
  // failProvider() stuffs the transport error into outcome.provider_error;
  // surface that as a clear halt reason so the parent's tool result
  // distinguishes "sub-agent provider died" from "sub-agent task failed".
  if (outcome.provider_error) {
    return {
      type: "fact.run_halted",
      payload: {
        reason: "provider_exhausted",
        detail: `provider error in sub-agent: ${outcome.provider_error.errorMessage}`,
      },
    };
  }
  return {
    type: "fact.run_halted",
    payload: {
      reason: "error",
      detail: outcome.failure_reason ?? `sub-agent terminated with status=${outcome.status}`,
    },
  };
}

async function tryAppendFact(
  store: IEventStore,
  runId: string,
  expectedVersion: number,
  facts: FactEvent[],
): Promise<boolean> {
  if (facts.length === 0) return true;
  try {
    store.appendFact(runId, facts, expectedVersion);
    return true;
  } catch (err) {
    if (err instanceof ConcurrencyError) return false;
    throw err;
  }
}

function readString(routing: Record<string, unknown>, key: string): string | undefined {
  const v = routing[key];
  return typeof v === "string" ? v : undefined;
}

function readNumber(routing: Record<string, unknown>, key: string): number | undefined {
  const v = routing[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readStringArray(routing: Record<string, unknown>, key: string): readonly string[] {
  const v = routing[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}
