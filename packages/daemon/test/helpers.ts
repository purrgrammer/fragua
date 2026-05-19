import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { autoDispatcherResolver } from "../src/auto-dispatcher.ts";
import { Dispatcher } from "../src/dispatch.ts";

export interface TestRig {
  store: SqliteStore;
  dispatcher: Dispatcher;
  tools: handler.InMemoryToolRegistry;
  llmCall: handler.LlmCallFn;
  workflowSha: string;
}

/** Trivial single-step workflow source — when a test doesn't care about
 * graph topology, only the executor / store wiring. */
const TRIVIAL_YAML = "name: t\nsteps:\n  start: {type: llm, prompt: hi}\n";

export function rig(workflow: { sha?: string; name?: string; yaml?: string } = {}): TestRig {
  const store = new SqliteStore({ path: ":memory:" });
  const sha = workflow.sha ?? "wf";
  const source = workflow.yaml ?? TRIVIAL_YAML;
  store.saveWorkflow(sha, workflow.name ?? "t", source);
  const dispatcher = new Dispatcher();
  // Install the auto-dispatcher so synthesized start/exit nodes get default
  // handlers when tests don't explicitly register one. Manual registrations
  // still take precedence (dispatcher.specs is checked first).
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });
  return { store, dispatcher, tools, llmCall, workflowSha: sha };
}

export function registerTerminalEcho(dispatcher: Dispatcher, sha: string, nodeId: string): void {
  dispatcher.register(sha, nodeId, {
    kind: "echo",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => ({
      kind: "transition",
      nextNode: "__end__",
      tokens: 0,
      costUsd: 0,
    }),
  });
}

export function enqueue(rig: TestRig, runId: string, startNode: string, priority = 0): void {
  rig.store.enqueueRun({
    runId,
    workflowSha: rig.workflowSha,
    priority,
    initialRouting: { start_node: startNode },
  });
}

/**
 * Realistic-shaped llm stub for testing per-turn services that
 * react to `cost.recorded` events (budget gates, cost rollup, abort
 * propagation, etc.).
 *
 * The trivial `transitionSpec` stubs in helpers.ts return zero cost in
 * one shot — they bypass the entire cost-bearing path. This stub:
 *
 *   - Emits `agent.start`, per-call `cost.recorded` (with full token
 *     split), then `agent.end` — matching the llm backend's event
 *     shape closely enough for the executor's mirroring to fire.
 *   - Honours `ctx.signal` between calls so cancel / budget-trip /
 *     timeout abort the handler at the next boundary.
 *   - Accumulates the cost + token split into the `HandlerResult`
 *     fields so the parent's reducer-driven rollup paths see realistic
 *     numbers.
 *
 * Used by the test matrix that exercises budget caps, retries, cancel
 * mid-handler, first_success sibling cancellation, cost rollup across
 * sub-runs, etc. Keep this in `daemon/test/helpers.ts` rather than in
 * `core` — it's a test-time fixture, not a public stub.
 */
export interface MockCodergenOpts {
  /** USD per LLM call. Default 0.05 — typical small turn. */
  costPerCall?: number;
  /** Number of `cost.recorded` events the stub emits before returning.
   *  Default 1. Bump to simulate agent-loop runs. */
  calls?: number;
  /** Per-call token split. Defaults to `{input:100, output:100}`. */
  tokensPerCall?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Final transition's nextNode. Default `__end__`. */
  nextNode?: string;
  /** Outcome status on the result. Default `"success"`. */
  outcomeStatus?: "success" | "fail" | "retry";
  /** Delay (ms) between calls. Lets supervisor / wake-pending interleave.
   *  Default 0 (synchronous). */
  delayMs?: number;
  /** Provider/model strings for the cost.recorded payload. Default
   *  `"mock"` / `"mock-model"`. */
  provider?: string;
  modelName?: string;
}

export function mockCodergenSpec(opts: MockCodergenOpts = {}): handler.HandlerSpec {
  const costPerCall = opts.costPerCall ?? 0.05;
  const calls = opts.calls ?? 1;
  const tokens = opts.tokensPerCall ?? { input: 100, output: 100 };
  const provider = opts.provider ?? "mock";
  const modelName = opts.modelName ?? "mock-model";

  return {
    kind: "llm",
    sideEffect: "none",
    maxMs: 60_000,
    handler: async (ctx) => {
      ctx.emit("agent.start", { nodeId: ctx.nodeId, iteration: ctx.iteration });
      const tokensTotal =
        (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);

      let totalCost = 0;
      let totalIn = 0;
      let totalOut = 0;
      let totalCR = 0;
      let totalCW = 0;
      let aborted = false;

      for (let i = 0; i < calls; i++) {
        if (ctx.signal.aborted) {
          aborted = true;
          break;
        }
        ctx.emit("llm.start", {
          nodeId: ctx.nodeId,
          iteration: ctx.iteration,
          provider,
          model: modelName,
        });
        ctx.emit("agent.turn_start", { nodeId: ctx.nodeId, iteration: ctx.iteration });
        ctx.emit("cost.recorded", {
          nodeId: ctx.nodeId,
          iteration: ctx.iteration,
          provider,
          model: modelName,
          stop_reason: "stop",
          input_tokens: tokens.input ?? 0,
          output_tokens: tokens.output ?? 0,
          cache_read_tokens: tokens.cacheRead ?? 0,
          cache_write_tokens: tokens.cacheWrite ?? 0,
          total_tokens: tokensTotal,
          cost_usd: costPerCall,
        });
        totalCost += costPerCall;
        totalIn += tokens.input ?? 0;
        totalOut += tokens.output ?? 0;
        totalCR += tokens.cacheRead ?? 0;
        totalCW += tokens.cacheWrite ?? 0;
        ctx.emit("agent.turn_end", { nodeId: ctx.nodeId, iteration: ctx.iteration });
        if (opts.delayMs != null && opts.delayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
      }
      ctx.emit("agent.end", { nodeId: ctx.nodeId, iteration: ctx.iteration });

      if (aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      const result: handler.HandlerResult = {
        kind: "transition",
        outcomeStatus: opts.outcomeStatus ?? "success",
        tokens: totalIn + totalOut,
        costUsd: totalCost,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheReadTokens: totalCR,
        cacheWriteTokens: totalCW,
        modelName,
      };
      if (opts.nextNode !== undefined) result.nextNode = opts.nextNode;
      return result;
    },
  };
}
