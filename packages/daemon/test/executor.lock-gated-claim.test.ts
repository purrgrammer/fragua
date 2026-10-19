// Lock-gated claims (probe F8). An executor whose daemon lost `daemon_lock`
// must claim nothing, even before its heartbeat notices, and an executor whose
// shutdown signal fired mid-tick must not claim either.

import { describe, expect, test } from "bun:test";
import type { IEventStore } from "@fragua/store";
import { AbortRegistry } from "../src/abort-registry.ts";
import { type ExecutorOpts, runExecutor } from "../src/executor.ts";
import { enqueue, rig, type TestRig } from "./helpers.ts";

function execOpts(
  r: TestRig,
  store: IEventStore,
  signal: AbortSignal,
  extra: Partial<ExecutorOpts> = {},
): ExecutorOpts {
  return {
    store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    pollIntervalMs: 5,
    shutdownDrainMs: 50,
    shutdownSignal: signal,
    ...extra,
  };
}

function countingClaims(inner: IEventStore, onWake?: () => void): { store: IEventStore; claims: () => number } {
  let claims = 0;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "claimNextRun") {
        return (...args: Parameters<IEventStore["claimNextRun"]>) => {
          claims++;
          return target.claimNextRun(...args);
        };
      }
      if (prop === "getWakeCandidates" && onWake !== undefined) {
        return (...args: Parameters<IEventStore["getWakeCandidates"]>) => {
          onWake();
          return target.getWakeCandidates(...args);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as IEventStore;
  return { store, claims: () => claims };
}

describe("lock-gated claims", () => {
  test("an evicted daemon's executor claims no runs", async () => {
    const r = rig();
    expect(r.store.acquireDaemonLock(2, "other-host").acquired).toBe(true);
    enqueue(r, "gated-1", "start");
    enqueue(r, "gated-2", "start");
    const ctrl = new AbortController();
    const { store, claims } = countingClaims(r.store);
    const loop = runExecutor(execOpts(r, store, ctrl.signal, { claimerPid: 1 }));
    await new Promise((res) => setTimeout(res, 60));
    ctrl.abort();
    await loop;

    expect(claims()).toBeGreaterThan(0);
    expect(r.store.getState("gated-1")!.status).toBe("queued");
    expect(r.store.getState("gated-2")!.status).toBe("queued");
    expect(r.store.getClaimEpoch("gated-1")).toBe(0);
    expect(r.store.currentDaemonLock()?.pid).toBe(2);
  });

  test("the executor makes no claim once shutdownSignal is aborted", async () => {
    const r = rig();
    enqueue(r, "late", "start");
    const ctrl = new AbortController();
    const { store, claims } = countingClaims(r.store, () => ctrl.abort());
    await runExecutor(execOpts(r, store, ctrl.signal));

    expect(claims()).toBe(0);
    expect(r.store.getState("late")!.status).toBe("queued");
  });
});
