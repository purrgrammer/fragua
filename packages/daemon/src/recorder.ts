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

import type * as handler from "@fragua/core/handler";
import { ConcurrencyError, type FactEvent, type IEventStore } from "@fragua/store";

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
    // `currentVersion` is captured at dispatch and can go stale when this is a
    // fan-out BRANCH recorder: concurrent sibling branches advance
    // `run_state.version` through the executor's commit lane while this branch's
    // handler runs. A side-effect commit with the stale token would throw
    // ConcurrencyError and abort the branch. Re-read the live version and retry
    // the APPEND (never re-runs the side effect) — the linearization invariant
    // (concurrency.md). On the linear path no sibling contends, so the retry
    // never trips.
    for (let attempt = 0; ; attempt++) {
      try {
        const result = this.opts.store.appendFact(this.opts.runId, [fact], this.currentVersion);
        this.currentVersion = result.newVersion;
        return;
      } catch (err) {
        if (!(err instanceof ConcurrencyError) || attempt >= RECORDER_COMMIT_ATTEMPTS) throw err;
        const live = this.opts.store.getState(this.opts.runId);
        if (live == null) throw err;
        // The version moves under us for two reasons: a sibling branch's commit
        // (benign — retry the append) or the run leaving `running` (operator
        // pause/cancel, a leak-halt). Only the first may retry: the OCC throw is
        // the fence that stops a zombie handler — one that ignored its abort and
        // outlived a terminal — from landing side-effect facts AFTER
        // fact.run_halted. Same status-vs-OCC split as commitFanoutFact.
        //
        // ACCEPTED TRADE: status is the ONLY fence — there is no dispatch-
        // identity token, so an ORPHANED handler whose run is still `running`
        // under a NEWER dispatch (a bailed branch outliving the bounded
        // drain grace, or a re-claimed run after daemon-lock expiry) retries
        // through and can interleave side-effect facts with the new
        // dispatch's stream under the same (nodeId, iteration). The window
        // is abort-signaled + leakGrace-bounded on the bail path; closing it
        // fully needs a per-dispatch claim token threaded into the recorder.
        if (live.status !== "running") throw err;
        this.currentVersion = live.version;
      }
    }
  }
}

/** Bounded re-reads of the live OCC token before a recorder commit gives up —
 * intra-run sibling contention resolves in one or two tries (single committer). */
const RECORDER_COMMIT_ATTEMPTS = 8;
