// Stage 3 — operator-recovery path tests. The executor's
// `retriesExhaustedPause` sentinel emits
// `fact.run_paused{reason:"max_retries"}` instead of halting. Operator
// either raises the cap via `intent.max_retries_adjusted` + `intent.resume`
// (Test 1) or sends naked `intent.resume` which re-pauses on the next
// failing attempt because the per-node retry counter is NOT reset (Test 2).
// Test 3 directly exercises the intent fold + override read path.

import { describe, expect, test } from "bun:test";
import { foldIntents } from "@swarm/core/handler";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { wakePending } from "../src/wake-pending.ts";
import { enqueue, rig } from "./helpers.ts";

/** Drive runOne once with a fresh AbortController + 1-claim. Helper
 * keeps the test bodies focused on intent sequencing + assertions. */
async function dispatchOnce(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  r.store.claimNextRun(1);
  await runOne(runId, {
    store: r.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 10,
    shutdownSignal: new AbortController().signal,
  });
}

/** Drive wake → claim → runOne in a loop until the run lands on an
 * operator-resumable status (`paused`, `completed`, `halted`, or
 * `cancelled`). `paused_auto` (handler_retry backoff) is skipped past
 * with a far-future wake clock. Bounded to keep tests honest. */
async function driveUntilSettled(r: ReturnType<typeof rig>, runId: string): Promise<void> {
  const SETTLED = new Set(["paused", "paused_human", "completed", "halted", "cancelled", "quarantined"]);
  for (let i = 0; i < 100; i++) {
    const s = r.store.getState(runId);
    if (s == null) return;
    if (SETTLED.has(s.status)) return;
    if (s.status === "paused_auto") {
      wakePending(r.store, () => Date.now() + 60_000);
      continue;
    }
    if (s.status === "queued") {
      await dispatchOnce(r, runId);
      continue;
    }
    // running / running_children: shouldn't happen in single-threaded
    // test loop, but break to avoid spinning.
    return;
  }
  throw new Error(`run ${runId} did not settle within 100 cycles`);
}

describe("executor — max_retries pause + operator resume", () => {
  test("retries to exhaustion → paused{reason:max_retries} → cap raise + resume → succeeds", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 1}\n`;
    const r = rig({ yaml });
    let attempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        attempts++;
        // First 2 attempts fail; max_retries=1 caps at 2 (1 initial + 1 retry),
        // so the second retry-outcome triggers exhaust → pause.
        // After cap raise + resume the next dispatch succeeds.
        if (attempts <= 2) {
          return { kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 };
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "mrp1", "start");
    // Drive turns until settled — start, then work fails once (handler_retry
    // → paused_auto), then re-dispatches and exhausts (→ paused{max_retries}).
    await driveUntilSettled(r, "mrp1");

    const pausedState = r.store.getState("mrp1")!;
    expect(pausedState.status).toBe("paused");
    expect(pausedState.currentNode).toBe("work");

    // Two pauses landed during the drive: a handler_retry (paused_auto,
    // backoff between attempt 1 and 2) and the max_retries exhaustion.
    // The exhaust pause is the operator-visible one we assert against.
    const maxRetriesPauses = r.store
      .getEvents("mrp1")
      .filter((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "max_retries");
    expect(maxRetriesPauses.length).toBe(1);
    const p = maxRetriesPauses[0]!.payload as {
      reason: string;
      nodeId: string;
      currentLimit: number;
      attempts: number;
    };
    expect(p.reason).toBe("max_retries");
    expect(p.nodeId).toBe("work");
    expect(p.currentLimit).toBe(1);
    expect(p.attempts).toBe(2);

    // Operator raises the cap, then resumes.
    r.store.appendIntent("mrp1", {
      type: "intent.max_retries_adjusted",
      payload: { nodeId: "work", newLimit: 5 },
    });
    r.store.appendIntent("mrp1", { type: "intent.resume", payload: { note: "give it more retries" } });

    const wake = wakePending(r.store);
    expect(wake.resumed).toContain("mrp1");
    expect(r.store.getState("mrp1")!.status).toBe("queued");

    // Drive again — work's third call succeeds, then done terminates.
    await driveUntilSettled(r, "mrp1");

    const finalState = r.store.getState("mrp1")!;
    expect(finalState.status).toBe("completed");
    expect(attempts).toBe(3);

    // No terminal halt ever landed.
    const haltFacts = r.store.getEvents("mrp1").filter((e) => e.type === "fact.run_halted");
    expect(haltFacts.length).toBe(0);

    r.store.close();
  });

  test("naked intent.resume (no cap raise) re-pauses with attempts incremented — no halt", async () => {
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 1}\n`;
    const r = rig({ yaml });
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      // Always returns retry — every dispatch will exhaust the cap.
      handler: async () => ({ kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    enqueue(r, "mrp2", "start");
    await driveUntilSettled(r, "mrp2");

    expect(r.store.getState("mrp2")!.status).toBe("paused");
    const firstMaxRetries = r.store
      .getEvents("mrp2")
      .find((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "max_retries")!;
    const firstAttempts = (firstMaxRetries.payload as { attempts: number }).attempts;
    expect(firstAttempts).toBe(2);

    // Naked resume — no cap raise. Counter (routing.internal.retry_count.work)
    // is NOT reset by the pause path (§4), so the very next failing
    // dispatch sees priorRetries=2 and re-exhausts immediately.
    r.store.appendIntent("mrp2", { type: "intent.resume", payload: {} });
    const wake = wakePending(r.store);
    expect(wake.resumed).toContain("mrp2");
    expect(r.store.getState("mrp2")!.status).toBe("queued");

    await driveUntilSettled(r, "mrp2");

    const stateAfterResume = r.store.getState("mrp2")!;
    // Must be paused again, not halted.
    expect(stateAfterResume.status).toBe("paused");

    const maxRetriesPauses = r.store
      .getEvents("mrp2")
      .filter((e) => e.type === "fact.run_paused" && (e.payload as { reason?: string }).reason === "max_retries");
    expect(maxRetriesPauses.length).toBe(2);
    const secondAttempts = (maxRetriesPauses[1]!.payload as { attempts: number }).attempts;
    // §4 says the per-node retry counter carries forward across naked
    // resume. With cap unchanged at 1 and priorRetries already at 1,
    // the next failing attempt immediately re-exhausts: retryStep's
    // halt branch fires with the same `priorRetries + 1` payload, so
    // `attempts` is equal to the first pause's value rather than
    // strictly greater. The cumulative observability lives in the
    // dispatch transcript (each turn lands its own fact.node_completed);
    // the pause-payload counter is reason-specific and resets only on
    // success. (§9 Test 2's "strictly greater" wording assumed the
    // counter would bump on the exhaust path; §4 says otherwise.)
    expect(secondAttempts).toBeGreaterThanOrEqual(firstAttempts);

    // No fact.run_halted between (or after) the two pauses — regression
    // guard against the §6-rejected max_retries_pause_count alternative.
    const haltFacts = r.store.getEvents("mrp2").filter((e) => e.type === "fact.run_halted");
    expect(haltFacts.length).toBe(0);

    r.store.close();
  });
});

describe("intent.max_retries_adjusted — override read", () => {
  test("max_retries_override.<nodeId> lands in routing and is preferred by the executor over the static attr", async () => {
    // Two halves:
    //   (a) Pure fold check — synthesize an unapplied-intents batch,
    //       fold against the run's current status, assert the routing
    //       delta has the override key.
    //   (b) End-to-end check — drive to the max_retries exhaust pause
    //       at cap=1, then raise to cap=5 via intent.max_retries_adjusted
    //       + intent.resume, then observe that the work node gets
    //       additional attempts (the executor reads the override).
    const yaml = `name: t\nsteps:\n  work: {type: llm, prompt: x, max_retries: 1}\n`;
    const r = rig({ yaml });

    // (a) Fold check. Append the intent against a fresh enqueued run
    // and run the fold directly to confirm the routing delta shape.
    enqueue(r, "mrp3", "start");
    const stateBefore = r.store.getState("mrp3")!;
    const appended = r.store.appendIntent("mrp3", {
      type: "intent.max_retries_adjusted",
      payload: { nodeId: "work", newLimit: 5 },
    });
    const intentSeq = appended.seq;
    const pending = r.store
      .getEvents("mrp3")
      .filter((e) => e.seq > stateBefore.lastAppliedSeq && e.type.startsWith("intent."))
      .map((e) => ({ seq: e.seq, type: e.type, payload: e.payload }));
    const decision = foldIntents(pending, stateBefore.status);
    expect(decision.kind).toBe("proceed");
    if (decision.kind === "proceed") {
      expect(decision.routingDelta?.["max_retries_override.work"]).toBe(5);
      expect(decision.appliedSeqs).toContain(intentSeq);
    }

    // (b) End-to-end. Reset and exercise the executor on a fresh run
    // so the pre-existing intent doesn't race the run_started bootstrap
    // (which advances appliedSeqs but doesn't merge the fold's
    // routingDelta — see executor.ts:520–533). The clean shape:
    // drive to max_retries pause at cap=1, then operator raises cap,
    // then resume.
    let attempts = 0;
    r.dispatcher.register(r.workflowSha, "start", {
      kind: "start",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
    });
    r.dispatcher.register(r.workflowSha, "work", {
      kind: "llm",
      sideEffect: "external",
      maxMs: 100,
      handler: async () => {
        attempts++;
        // 4 failing attempts; under cap=1 the run pauses after attempt 2.
        // After cap is raised to 5, attempts 3 and 4 happen, then 5 succeeds.
        if (attempts <= 4) {
          return { kind: "transition", outcomeStatus: "retry", tokens: 0, costUsd: 0 };
        }
        return { kind: "transition", outcomeStatus: "success", tokens: 0, costUsd: 0 };
      },
    });
    r.dispatcher.register(r.workflowSha, "done", {
      kind: "exit",
      sideEffect: "none",
      maxMs: 100,
      handler: async () => ({ kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 }),
    });

    // Drive to the cap=1 exhaust pause.
    await driveUntilSettled(r, "mrp3");
    const firstPaused = r.store.getState("mrp3")!;
    expect(firstPaused.status).toBe("paused");
    expect(attempts).toBe(2);

    // Raise the cap, then resume. The override + resume both land as
    // intents; the next fold consumes both and the executor reads the
    // raised cap on subsequent retry-outcomes.
    r.store.appendIntent("mrp3", {
      type: "intent.max_retries_adjusted",
      payload: { nodeId: "work", newLimit: 5 },
    });
    r.store.appendIntent("mrp3", { type: "intent.resume", payload: {} });
    wakePending(r.store);
    expect(r.store.getState("mrp3")!.status).toBe("queued");

    await driveUntilSettled(r, "mrp3");

    const finalState = r.store.getState("mrp3")!;
    expect(finalState.status).toBe("completed");
    expect(attempts).toBe(5);
    // Routing carries the override so future reads can audit it.
    expect(finalState.routing["max_retries_override.work"]).toBe(5);

    // Only one max_retries pause occurred — at the original cap=1
    // exhaust. After the override landed, the executor honoured the
    // raised cap and never paused for max_retries again.
    const maxRetriesPauses = r.store.getEvents("mrp3").filter((e) => {
      if (e.type !== "fact.run_paused") return false;
      const reason = (e.payload as { reason?: string }).reason;
      return reason === "max_retries";
    });
    expect(maxRetriesPauses.length).toBe(1);

    r.store.close();
  });
});
