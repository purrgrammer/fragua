// Side-effect fact recorder.
//
// Each `recordIntent` / `recordDone` / `recordFailed` commits a single
// fact in its own short transaction, advancing `run_state.version` as it
// goes. This is what makes startup-sweep orphan detection work for hard
// crashes (SIGKILL / OOM / panic) mid-`fn`: the intent is durable on disk
// before `fn` ever runs, so the sweep can find an `intent` without a
// matching `done`/`failed` and quarantine the run. See ARCHITECTURE.md
// §1.1.
//
// The recorder also exposes `version()` so the executor's terminal append
// (node_completed / node_aborted) can use the latest OCC token after the
// handler returns.

import type * as handler from "@swarm/core/handler";
import type { FactEvent, IEventStore } from "@swarm/store";

type SideEffectRecorder = handler.SideEffectRecorder;

export interface CommittingRecorderOpts {
  store: IEventStore;
  runId: string;
  nodeId: string;
  iteration: number;
  /** OCC token at the start of the dispatch. The recorder advances this
   * on every commit so the executor can read the latest version after
   * dispatch returns and use it for the terminal node_completed /
   * node_aborted commit. */
  initialVersion: number;
}

export class CommittingRecorder implements SideEffectRecorder {
  private currentVersion: number;

  constructor(private readonly opts: CommittingRecorderOpts) {
    this.currentVersion = opts.initialVersion;
  }

  recordIntent(params: { toolName: string; argsHash: string; attempt: number; idempotencyKey: string }): void {
    this.commit({
      type: "fact.side_effect_intent",
      payload: {
        nodeId: this.opts.nodeId,
        iteration: this.opts.iteration,
        toolName: params.toolName,
        argsHash: params.argsHash,
        attempt: params.attempt,
        idempotencyKey: params.idempotencyKey,
      },
    });
  }

  recordDone(params: { idempotencyKey: string; artifactKey: string; tokens?: number; costUsd?: number }): void {
    const payload: Extract<FactEvent, { type: "fact.side_effect_done" }>["payload"] = {
      idempotencyKey: params.idempotencyKey,
      artifactKey: params.artifactKey,
    };
    if (params.tokens !== undefined) payload.tokens = params.tokens;
    if (params.costUsd !== undefined) payload.costUsd = params.costUsd;
    this.commit({ type: "fact.side_effect_done", payload });
  }

  recordFailed(params: { idempotencyKey: string; errorCode: string; retriable: boolean }): void {
    this.commit({
      type: "fact.side_effect_failed",
      payload: {
        idempotencyKey: params.idempotencyKey,
        errorCode: params.errorCode,
        retriable: params.retriable,
      },
    });
  }

  /** Latest version after all recorder commits. Executor reads this for
   * its terminal append (node_completed / node_aborted / handler_timeout_leaked). */
  version(): number {
    return this.currentVersion;
  }

  private commit(fact: FactEvent): void {
    const result = this.opts.store.appendFact(this.opts.runId, [fact], this.currentVersion);
    this.currentVersion = result.newVersion;
  }
}
