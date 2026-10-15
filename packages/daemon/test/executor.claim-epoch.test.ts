// Claim epoch — a fiber that outlived a crash requeue (the startup sweep run by
// a reaper while the old daemon's fiber is still alive) must not commit a
// single fact for the run once it has been handed to another fiber, so the
// node's handler runs exactly once.

import { describe, expect, test } from "bun:test";
import { ClaimLostError, type IEventStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { bindClaim } from "../src/claim-bound-store.ts";
import { runOne } from "../src/executor.ts";
import { CommittingRecorder } from "../src/recorder.ts";
import { enqueue, rig } from "./helpers.ts";

const YAML = "name: t\nsteps:\n  start: {type: llm, prompt: s}\n  work: {type: llm, prompt: w}\n";

function opts(r: ReturnType<typeof rig>, store: IEventStore): Parameters<typeof runOne>[1] {
  return {
    store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 30,
    shutdownSignal: new AbortController().signal,
  };
}

/** Store view for the stale fiber: the first time it tries to stamp
 * `fact.dispatch_started` on `work`, the reaper's sweep requeues the run and a
 * fresh fiber claims it — exactly the window F7 describes. */
function sweptUnderFiber(inner: IEventStore, onSwept: (claimEpoch: number) => void): IEventStore {
  let swept = false;
  const appendFact: IEventStore["appendFact"] = (runId, facts, expectedVersion, appendOpts) => {
    const dispatchingWork = facts.some(
      (f) => f.type === "fact.dispatch_started" && (f.payload as { nodeId: string }).nodeId === "work",
    );
    if (!swept && dispatchingWork) {
      swept = true;
      inner.startupSweep();
      const claimed = inner.claimNextRun(1);
      if (claimed == null) throw new Error("re-claim failed");
      onSwept(claimed.claimEpoch);
    }
    return inner.appendFact(runId, facts, expectedVersion, appendOpts);
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "appendFact") return appendFact;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as IEventStore;
}

function setup(): { r: ReturnType<typeof rig>; workCalls: () => number } {
  const r = rig({ yaml: YAML });
  let calls = 0;
  r.dispatcher.register(r.workflowSha, "start", {
    kind: "start",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => ({ kind: "transition", nextNode: "work", tokens: 0, costUsd: 0 }),
  });
  r.dispatcher.register(r.workflowSha, "work", {
    kind: "llm",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => {
      calls++;
      return { kind: "transition", nextNode: "__end__", tokens: 0, costUsd: 0 };
    },
  });
  enqueue(r, "f7", "start");
  return { r, workCalls: () => calls };
}

async function staleThenFresh(): Promise<{ r: ReturnType<typeof rig>; workCalls: () => number; stale: number }> {
  const { r, workCalls } = setup();
  const first = r.store.claimNextRun(1)!;
  let fresh: Promise<void> | undefined;
  const stale = sweptUnderFiber(r.store, (claimEpoch) => {
    fresh = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
      runOne("f7", opts(r, r.store), undefined, { epoch: claimEpoch }),
    );
  });
  await runOne("f7", opts(r, stale), undefined, { epoch: first.claimEpoch });
  const staleCalls = workCalls();
  await fresh;
  return { r, workCalls, stale: staleCalls };
}

describe("claim epoch — a stale fiber is fenced after a crash requeue", () => {
  test("a stale fiber after startupSweep cannot commit dispatch_started and the handler runs once", async () => {
    const { r, workCalls, stale } = await staleThenFresh();

    expect(stale).toBe(0);
    expect(workCalls()).toBe(1);
    expect(r.store.getState("f7")!.status).toBe("completed");
    const events = r.store.getEvents("f7");
    const requeueSeq = events.find((e) => e.type === "fact.run_requeued_after_crash")!.seq;
    const workDispatches = events.filter(
      (e) => e.type === "fact.dispatch_started" && (e.payload as { nodeId: string }).nodeId === "work",
    );
    expect(workDispatches).toHaveLength(1);
    expect(workDispatches[0]!.seq).toBeGreaterThan(requeueSeq);
    r.store.close();
  });

  test("a stale fiber exits without halting the run it no longer owns", async () => {
    const { r } = await staleThenFresh();

    const events = r.store.getEvents("f7");
    expect(
      events.some(
        (e) => e.type === "fact.run_terminated" && (e.payload as { reason?: string }).reason === "occ_exhausted",
      ),
    ).toBe(false);
    const terminals = events.filter((e) => e.type === "fact.run_terminated");
    expect(terminals).toHaveLength(1);
    expect((terminals[0]!.payload as { status: string }).status).toBe("completed");
    r.store.close();
  });

  test("a stale fiber's recorder side-effect commit throws ClaimLostError without retrying", async () => {
    const { r } = setup();
    const { claimEpoch } = r.store.claimNextRun(1)!;
    const s0 = r.store.getState("f7")!;
    r.store.appendFact(
      "f7",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: s0.workflowSha, contractVersion: s0.contractVersion, startNode: "start" },
        },
      ],
      s0.version,
      { claimEpoch },
    );
    r.store.startupSweep();
    r.store.claimNextRun(1);
    expect(r.store.getState("f7")!.status).toBe("running");

    let attempts = 0;
    const counting = new Proxy(r.store, {
      get(target, prop, receiver) {
        if (prop === "appendFact") {
          return (...a: Parameters<IEventStore["appendFact"]>) => {
            attempts++;
            return target.appendFact(...a);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as IEventStore;
    const recorder = new CommittingRecorder({
      store: bindClaim(counting, claimEpoch),
      runId: "f7",
      nodeId: "start",
      iteration: 0,
      initialVersion: r.store.getState("f7")!.version,
    });

    expect(() => recorder.recordIntent({ toolName: "t", argsHash: "h", attempt: 0, idempotencyKey: "k" })).toThrow(
      ClaimLostError,
    );
    expect(attempts).toBe(1);
    expect(r.store.getEvents("f7").filter((e) => e.type === "fact.side_effect_intent")).toHaveLength(0);
    r.store.close();
  });

  test("a stale fiber's bound appendMessage and putArtifact throw ClaimLostError without writing", () => {
    const { r } = setup();
    const { claimEpoch } = r.store.claimNextRun(1)!;
    const stale = bindClaim(r.store, claimEpoch);
    const scope = { runId: "f7", nodeId: "start", iteration: 0, key: "out" };
    stale.putArtifact(scope, new TextEncoder().encode("fresh"));
    r.store.startupSweep();
    r.store.claimNextRun(1);
    const messagesBefore = r.store.getMessages("f7").length;
    const artifactsBefore = r.store.listArtifacts("f7").length;

    expect(() =>
      stale.appendMessage("f7", {
        content: { role: "user", content: "late", timestamp: 0 },
        nodeId: "start",
        iteration: 0,
      }),
    ).toThrow(ClaimLostError);
    expect(() => stale.putArtifact(scope, new TextEncoder().encode("stale"), undefined, { replace: true })).toThrow(
      ClaimLostError,
    );

    expect(r.store.getMessages("f7").length).toBe(messagesBefore);
    expect(r.store.listArtifacts("f7").length).toBe(artifactsBefore);
    expect(new TextDecoder().decode(r.store.getArtifact(scope))).toBe("fresh");
    r.store.close();
  });
});
