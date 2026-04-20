// Executor fiber — ARCHITECTURE.md §6.
//
// One executor loop per daemon. It repeatedly:
//   1. Polls for the next claimable run (concurrency-capped).
//   2. For each claimed run, walks turns until a terminal or paused state.
//   3. On each turn: fold intents, build handler context, dispatch, map
//      result → facts, commit via appendFact with OCC.
//
// No files, no sockets, no IPC. Just the store.

import { type EdgeSelection, type ExecutionEnvironment, type Graph, parseDotSource, selectEdge } from "@swarm/core";
import * as core from "@swarm/core/handler";
import { ConcurrencyError, CURRENT_SCHEMA_VERSION, type FactEvent, type IEventStore } from "@swarm/store";
import type { AbortRegistry } from "./abort-registry.ts";
import type { AutoTitler, TitleRequest } from "./auto-titler.ts";
import type { Dispatcher } from "./dispatch.ts";
import { CollectingRecorder } from "./recorder.ts";
import { abortResultToFacts, cancelToFacts, resultToFacts } from "./result-to-facts.ts";
import { wakePendingHitl } from "./wake-hitl.ts";
import type { Provisioner } from "./worktree-provisioner.ts";

type HandlerResult = core.HandlerResult;
type LlmCallFn = core.LlmCallFn;

export interface ExecutorOpts {
  store: IEventStore;
  dispatcher: Dispatcher;
  registry: AbortRegistry;
  tools: core.ToolRegistry;
  llmCall: LlmCallFn;
  maxConcurrentRuns: number;
  /** Upper bound on node-less poll waits in ms. Tests inject a smaller value. */
  pollIntervalMs?: number;
  /** Grace period beyond handler maxMs before we treat the node as leaked. */
  leakGraceMs?: number;
  /** Hook for tests to stop after N turns; defaults to ∞. */
  maxTurnsForTesting?: number;
  /** AbortSignal that stops the executor loop. */
  shutdownSignal: AbortSignal;
  /** Optional auto-titler. When set, `titleRun` fires once per run just
   * after `fact.run_started` is durably committed. */
  autoTitler?: AutoTitler;
  /** Optional worktree provisioner. When set, the executor calls
   * `ensure(runId)` before any handler dispatches so the per-run env
   * is ready, and `dispose(runId)` once the run reaches a terminal
   * status. When unset, handlers fall back to their construction-time
   * env (tests, bare-bones daemons). */
  provisioner?: Provisioner;
}

const DEFAULT_POLL_MS = 50;
const DEFAULT_LEAK_GRACE_MS = 5_000;
const ABORT_LOOP_CEILING = 5;

export async function runExecutor(opts: ExecutorOpts): Promise<void> {
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  while (!opts.shutdownSignal.aborted) {
    wakePendingHitl(opts.store);
    const claimed = opts.store.claimNextRun(opts.maxConcurrentRuns);
    if (claimed == null) {
      await sleep(pollMs, opts.shutdownSignal);
      continue;
    }
    await runOne(claimed.runId, opts);
  }
}

export async function runOne(runId: string, opts: ExecutorOpts): Promise<void> {
  const leakGrace = opts.leakGraceMs ?? DEFAULT_LEAK_GRACE_MS;
  const maxTurns = opts.maxTurnsForTesting ?? Number.POSITIVE_INFINITY;
  let consecutiveAborts = 0;
  let turns = 0;
  let runEnv: ExecutionEnvironment | undefined;
  // Lazy per-run graph cache. Parsed once on first edge-selection need.
  let cachedGraph: Graph | null = null;
  const graphFor = (workflowSha: string): Graph | null => {
    if (cachedGraph != null) return cachedGraph;
    const wf = opts.store.getWorkflow(workflowSha);
    if (wf == null) return null;
    try {
      cachedGraph = parseDotSource(wf.dotSource);
      return cachedGraph;
    } catch {
      return null;
    }
  };

  try {
    while (!opts.shutdownSignal.aborted && turns < maxTurns) {
      turns++;
      const state = opts.store.getState(runId);
      if (state == null) return;

      if (
        state.status === "completed" ||
        state.status === "cancelled" ||
        state.status === "halted" ||
        state.status === "paused_hitl" ||
        state.status === "quarantined"
      ) {
        return;
      }

      // Schema drift refusal.
      if (state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_halted",
            payload: { reason: "schema_drift" },
          },
        ]);
        return;
      }

      // Fold unapplied intents into a single decision.
      const unapplied = opts.store.getUnappliedIntents(runId);
      const decision = core.foldIntents(unapplied);

      if (decision.kind === "cancel") {
        await tryAppendFact(opts.store, runId, state.version, cancelToFacts(decision.intentSeq));
        return;
      }

      if (decision.shouldPause) {
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.run_paused_hitl",
            payload: {
              nodeId: state.currentNode ?? "",
              prompt: "paused by operator",
            },
          },
        ]);
        return;
      }

      // Identify the node to run. `claimNextRun` flips status to 'running' but
      // leaves current_node NULL — treat that as the "just-claimed" signal and
      // emit run_started to pin the start node. The start node comes from
      // routing.start_node, defaulting to "start".
      const currentNode = state.currentNode;
      const needsStart = state.currentNode == null && (state.status === "queued" || state.status === "running");

      // Provision the run's worktree before the first fact.run_started
      // commits. If init fails, the run is halted with a clear reason
      // and the provisioner is responsible for any partial-state
      // cleanup. After the first successful provision, runEnv is cached
      // locally and reused on every subsequent turn — `ensure` is
      // idempotent but we avoid the extra lookup.
      if (opts.provisioner && runEnv === undefined) {
        try {
          runEnv = await opts.provisioner.ensure(runId);
        } catch (err) {
          await tryAppendFact(opts.store, runId, state.version, [
            {
              type: "fact.run_halted",
              payload: {
                reason: "error",
                detail: `worktree_provision_failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            },
          ]);
          return;
        }
      }

      if (needsStart) {
        const start = routingString(state.routing, "start_node") ?? "start";
        const startFacts: FactEvent[] = [
          {
            type: "fact.run_started",
            payload: {
              workflowSha: state.workflowSha,
              schemaVersion: state.schemaVersion,
              startNode: start,
            },
          },
        ];
        const ok = await tryAppendFact(opts.store, runId, state.version, startFacts);
        if (!ok) continue; // OCC retry
        if (opts.autoTitler) {
          const input = routingString(state.routing, "input") ?? "";
          const goal = graphFor(state.workflowSha)?.attrs.goal;
          const req: TitleRequest = {
            runId,
            workflowSha: state.workflowSha,
            input,
          };
          if (goal !== undefined) req.goal = goal;
          opts.autoTitler.titleRun(req);
        }
        continue; // Reload state next turn with the new run_started applied.
      }

      if (currentNode == null) return;

      // Dispatch.
      const spec = opts.dispatcher.get(state.workflowSha, currentNode);
      const steerCtrl = new AbortController();
      const signals: AbortSignal[] = [steerCtrl.signal, AbortSignal.timeout(spec.maxMs), opts.shutdownSignal];
      const signal = AbortSignal.any(signals);
      opts.registry.register(runId, steerCtrl);

      const iteration = nodeRetryCount(state.routing);
      const recorder = new CollectingRecorder(currentNode, iteration);
      const observability: { type: string; payload: Record<string, unknown> }[] = [];

      let totalTokens = 0;
      let totalCostUsd = 0;
      let lastModel: string | undefined;
      const accounting: core.LlmAccounting = {
        addUsage: ({ tokens, costUsd, model }) => {
          totalTokens += tokens;
          totalCostUsd += costUsd;
          lastModel = model;
        },
      };

      const ctxOpts: core.BuildContextOpts = {
        runId,
        nodeId: currentNode,
        iteration,
        signal,
        routing: state.routing,
        store: opts.store,
        llm: core.makeLlmClient({
          signal,
          call: opts.llmCall,
          accounting,
        }),
        http: core.makeHttpClient({ signal }),
        tools: opts.tools,
        recorder,
        args: buildSubstitutionArgs(runId, state.routing, runEnv),
        emitObservability: (type, payload) => {
          // Stamp nodeId + iteration so the UI can scope without the
          // handler having to thread it through every payload.
          observability.push({
            type,
            payload: { nodeId: currentNode, iteration, ...payload },
          });
        },
      };
      if (decision.hitlInput !== undefined) ctxOpts.hitlInput = decision.hitlInput;
      if (decision.steering !== undefined) ctxOpts.steering = decision.steering;
      if (runEnv !== undefined) ctxOpts.env = runEnv;
      const ctx = core.buildHandlerContext(ctxOpts);

      let result: HandlerResult;
      let wasAborted = false;
      let leakedTimeout = false;
      try {
        result = await Promise.race([
          spec.handler(ctx),
          timeoutReject(spec.maxMs + leakGrace).then((_) => {
            leakedTimeout = true;
            return { kind: "halt", reason: "error", detail: "timeout_leaked" } as HandlerResult;
          }),
        ]);
      } catch (err) {
        wasAborted = isAbortError(err);
        result = {
          kind: "halt",
          reason: "error",
          detail: errorMessage(err),
        };
      } finally {
        opts.registry.unregister(runId);
      }

      // Flush on abort/leak BEFORE those branches append their terminal
      // fact. The main transition path flushes later, after edge selection
      // has pushed its `edge.selected` event, so all observability for the
      // turn lands in one ordered batch.
      const flushObservability = (): void => {
        if (observability.length === 0) return;
        try {
          opts.store.appendObservabilityEvents(runId, observability);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[executor] observability flush failed for run ${runId}:`, err);
        }
        observability.length = 0;
      };

      if (leakedTimeout) {
        flushObservability();
        await tryAppendFact(opts.store, runId, state.version, [
          {
            type: "fact.handler_timeout_leaked",
            payload: { nodeId: currentNode, leakedAt: Date.now() },
          },
          {
            type: "fact.run_halted",
            payload: { reason: "error", detail: "handler_leaked" },
          },
        ]);
        return;
      }

      if (wasAborted) {
        flushObservability();
        // Reapply partial usage to node_aborted; executor doesn't roll back blobs.
        const facts = abortResultToFacts(
          currentNode,
          iteration,
          "aborted",
          { tokens: totalTokens, costUsd: totalCostUsd },
          recorder.drain(),
        );
        await tryAppendFact(opts.store, runId, state.version, facts);
        consecutiveAborts++;
        if (consecutiveAborts >= ABORT_LOOP_CEILING) {
          await tryAppendFact(
            opts.store,
            runId,
            // version may have shifted after the abort append; re-read.
            opts.store.getState(runId)?.version ?? state.version,
            [
              {
                type: "fact.run_halted",
                payload: { reason: "abort_loop" },
              },
            ],
          );
          return;
        }
        continue;
      } else {
        consecutiveAborts = 0;
      }

      // Attach LLM accounting into the node_completed fact if the handler
      // didn't set these explicitly.
      if (result.kind === "transition") {
        if (result.tokens === 0 && totalTokens > 0) result.tokens = totalTokens;
        if (result.costUsd === 0 && totalCostUsd > 0) result.costUsd = totalCostUsd;
        if (result.modelName == null && lastModel != null) result.modelName = lastModel;

        // Edge selection: when the handler left `nextNode` unset, pick from
        // the current node's outgoing edges via the 5-rule selector (SPEC
        // §3.8). With it set, the handler is bypassing routing on purpose.
        if (result.nextNode == null) {
          const graph = graphFor(state.workflowSha);
          const srcNode = graph?.nodes[currentNode];
          if (graph != null && srcNode != null) {
            const selection = selectEdge({
              graph,
              source: srcNode,
              outcome: {
                status: result.outcomeStatus ?? "success",
                context_updates: {},
                preferred_label: result.preferredLabel ?? "",
                suggested_next_ids: result.suggestedNextIds ?? [],
                notes: "",
              },
              context: state.routing,
            });
            if (selection != null) {
              result.nextNode = selection.edge.to;
              recordEdgeSelected(observability, currentNode, selection);
            } else {
              // No outgoing edges or no viable selection — terminal.
              result.nextNode = "__end__";
            }
          } else {
            // Graph unavailable (already-running test fixtures without a
            // parseable workflow) — terminal by default.
            result.nextNode = "__end__";
          }
        }
      }

      // All observability for this turn is now buffered (handler emissions
      // + any edge.selected from the selector above). Flush before the
      // terminal fact lands so consumers tailing /events see the trail
      // followed by node_completed in causal order.
      flushObservability();

      const factsCtx = {
        state,
        appliedIntentSeqs: decision.appliedSeqs,
        sideEffectFacts: recorder.drain(),
        ...(decision.hitlInput !== undefined && unapplied.length > 0 ? { hitlInputSeq: lastHitlSeq(unapplied) } : {}),
      };
      const facts = resultToFacts(result, factsCtx);
      const routingPatch = mergeRoutingPatches(decision.routingDelta, result);
      const advanceAppliedTo = decision.appliedSeqs.length > 0 ? Math.max(...decision.appliedSeqs) : undefined;
      const appendOpts: {
        routingPatch?: Record<string, unknown>;
        advanceAppliedTo?: number;
      } = {};
      if (routingPatch !== undefined) appendOpts.routingPatch = routingPatch;
      if (advanceAppliedTo !== undefined) appendOpts.advanceAppliedTo = advanceAppliedTo;
      const ok = await tryAppendFact(opts.store, runId, state.version, facts, appendOpts);
      if (!ok) continue; // OCC retry — rebuild from fresh state
    }
  } finally {
    // Only tear down the worktree when the run has durably reached a
    // terminal status (completed / cancelled / halted). paused_hitl
    // + quarantined runs keep the worktree around so the next
    // resume / unquarantine picks up exactly where it left off.
    // Provisioner is expected to be idempotent; double-dispose is
    // handled internally as a no-op.
    if (opts.provisioner) {
      const finalState = opts.store.getState(runId);
      if (
        finalState != null &&
        (finalState.status === "completed" || finalState.status === "cancelled" || finalState.status === "halted")
      ) {
        try {
          await opts.provisioner.dispose(runId);
        } catch (err) {
          // Best-effort — a dispose failure shouldn't cascade into
          // the executor. Log via stderr for post-mortem.
          // eslint-disable-next-line no-console
          console.warn(`[executor] worktree dispose failed for run ${runId}:`, err);
        }
      }
    }
  }
}

async function tryAppendFact(
  store: IEventStore,
  runId: string,
  expectedVersion: number,
  facts: FactEvent[],
  opts?: {
    routingPatch?: Record<string, unknown>;
    advanceAppliedTo?: number;
  },
): Promise<boolean> {
  if (facts.length === 0) return true;
  try {
    store.appendFact(runId, facts, expectedVersion, opts);
    return true;
  } catch (err) {
    if (err instanceof ConcurrencyError) return false;
    throw err;
  }
}

function mergeRoutingPatches(
  fromIntents: Record<string, unknown>,
  result: core.HandlerResult,
): Record<string, unknown> | undefined {
  const fromResult = result.kind === "transition" || result.kind === "yield_hitl" ? result.routingDelta : undefined;
  const merged: Record<string, unknown> = { ...fromIntents, ...fromResult };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutReject(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error(`leaked after ${ms}ms`)), ms);
  });
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === "AbortError" || err.name === "TimeoutError";
  }
  return false;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function routingString(routing: Record<string, unknown>, key: string): string | undefined {
  const v = routing[key];
  return typeof v === "string" ? v : undefined;
}

/** Read the per-node retry counter from routing. Attractor §3.6:
 * bumped each time a backward edge re-enters a node after a
 * non-success outcome. */
function nodeRetryCount(routing: Record<string, unknown>): number {
  const v = routing["retry_count"];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function lastHitlSeq(unapplied: ReadonlyArray<{ type: string; seq: number }>): number {
  for (let i = unapplied.length - 1; i >= 0; i--) {
    const e = unapplied[i]!;
    if (e.type === "intent.hitl_input") return e.seq;
  }
  return 0;
}

/**
 * Assemble the prompt-substitution args the handler bridge feeds into
 * `substitute()`. `$ARGUMENTS` comes from `routing.input` (set by the
 * enqueue surface — POST /runs body or CLI positional). `$RUN_ID` is the
 * stable per-run id. `$WORKTREE_PATH` / `$LOG_DIR` are left for a
 * follow-up commit when the daemon gains worktree provisioning;
 * referencing them in prompts today collapses to "" per substitute()'s
 * missing-token rule, which is still an improvement over the literal
 * placeholder leaking to the LLM.
 */
/**
 * Stamp the selected edge into the observability buffer so the UI and
 * replay tools see exactly which rule picked the traversal. `edge.selected`
 * is in the core EventType union; emitted alongside `fact.node_completed`
 * at commit time.
 */
function recordEdgeSelected(
  buffer: { type: string; payload: Record<string, unknown> }[],
  fromNode: string,
  selection: EdgeSelection,
): void {
  const payload: Record<string, unknown> = {
    from: fromNode,
    to: selection.edge.to,
    rule: selection.rule,
  };
  if (selection.matched !== undefined) {
    if (selection.rule === "condition") payload["matched_condition"] = selection.matched;
    else if (selection.rule === "preferred_label") payload["matched_label"] = selection.matched;
    else payload["matched"] = selection.matched;
  }
  buffer.push({ type: "edge.selected", payload });
}

export function buildSubstitutionArgs(
  runId: string,
  routing: Record<string, unknown>,
  env?: ExecutionEnvironment,
): Record<string, string> {
  const args: Record<string, string> = { $RUN_ID: runId };
  const input = routing["input"];
  if (typeof input === "string") args["$ARGUMENTS"] = input;
  if (env !== undefined) {
    args["$WORKTREE_PATH"] = env.cwd();
    // `$LOG_DIR` only surfaces when the env is a `WorktreeEnvironment`
    // (structural check on the public `logDir` property to avoid a
    // hard dep on @swarm/workspace from @swarm/daemon's exec path).
    const logDir = (env as { logDir?: unknown }).logDir;
    if (typeof logDir === "string" && logDir.length > 0) args["$LOG_DIR"] = logDir;
  }
  return args;
}
