import { describe, expect, test } from "bun:test";
import { ClaimLostError, ConcurrencyError, type FactEvent, type IEventStore, type RunState } from "@fragua/store";
import {
  commitParkOrTerminal,
  commitWithOcc,
  HALT_APPEND_MAX_ATTEMPTS,
  makeOccController,
  type OccCommitPlan,
  type OccController,
  occAppendOnce,
  tryAppendFact,
} from "../src/occ-append.ts";

/** Minimal IEventStore stub exposing only the methods the OCC controller +
 * tryAppendFact touch. Cast through `unknown` since we deliberately don't
 * implement the full surface. */
function stubStore(over: Partial<IEventStore>): IEventStore {
  return over as unknown as IEventStore;
}

const noSignal = new AbortController().signal;

describe("tryAppendFact", () => {
  test("returns true on success, false on ConcurrencyError, rethrows others", async () => {
    expect(await tryAppendFact(stubStore({}), "r", 0, [])).toBe(true); // empty batch short-circuits

    const ok = stubStore({ appendFact: (() => ({}) as never) as unknown as IEventStore["appendFact"] });
    expect(
      await tryAppendFact(ok, "r", 0, [
        { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } },
      ]),
    ).toBe(true);

    const conflict = stubStore({
      appendFact: (() => {
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
    });
    expect(
      await tryAppendFact(conflict, "r", 0, [
        { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } },
      ]),
    ).toBe(false);

    const boom = stubStore({
      appendFact: (() => {
        throw new Error("disk full");
      }) as unknown as IEventStore["appendFact"],
    });
    await expect(
      tryAppendFact(boom, "r", 0, [{ type: "fact.run_terminated", payload: { status: "errored", reason: "error" } }]),
    ).rejects.toThrow("disk full");
  });
});

describe("makeOccController", () => {
  test("warns once at OCC_WARN_AT (2nd conflict) and halts at OCC_CEILING (3rd)", async () => {
    const obs: { type: string }[] = [];
    let appends = 0;
    const store = stubStore({
      getState: (() => ({ status: "running", version: 1 })) as unknown as IEventStore["getState"],
      appendFact: (() => {
        appends++;
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: ((_runId: string, events: { type: string }[]) => {
        obs.push(...events);
      }) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });

    expect(await occ.onConflict("fact.node_completed", "n", 0, 1)).toEqual({ halted: false });
    expect(obs).toHaveLength(0); // first conflict: backoff only

    expect(await occ.onConflict("fact.node_completed", "n", 0, 1)).toEqual({ halted: false });
    expect(obs.map((e) => e.type)).toEqual(["occ_conflict_warning"]); // second: one warning

    expect(await occ.onConflict("fact.node_completed", "n", 0, 1)).toEqual({ halted: true }); // third: halt
    expect(appends).toBe(1); // occ_exhausted run_halted committed once
  });

  test("occ_exhausted batch carries the held spend", async () => {
    const batches: FactEvent[][] = [];
    const store = stubStore({
      getState: (() => ({ status: "running", version: 1 })) as unknown as IEventStore["getState"],
      appendFact: ((_r: string, facts: FactEvent[]) => {
        batches.push(facts);
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: (() => {}) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const spend: FactEvent[] = [
      {
        type: "fact.node_aborted",
        payload: { nodeId: "n", iteration: 0, cause: "occ_exhausted", partialTokens: 100, partialCostUsd: 0.25 },
      },
    ];
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });
    await occ.onConflict("fact.node_completed", "n", 0, 1, spend);
    await occ.onConflict("fact.node_completed", "n", 0, 1, spend);
    expect(await occ.onConflict("fact.node_completed", "n", 0, 1, spend)).toEqual({ halted: true });

    expect(batches).toHaveLength(1);
    expect(batches[0]![0]).toEqual(spend[0]!);
    expect(batches[0]![1]?.payload).toMatchObject({ status: "errored", reason: "occ_exhausted" });
  });

  test("pendingSpend reports a held batch's spend until it is released", () => {
    const occ = makeOccController({ store: stubStore({}), runId: "r", shutdownSignal: noSignal });
    const token = occ.holdSpend([
      {
        type: "fact.node_completed",
        payload: { nodeId: "n", iteration: 0, tokens: 100, costUsd: 0.25, nextNode: "m" },
      },
    ]);
    expect(occ.pendingSpend()).toEqual([
      {
        type: "fact.node_aborted",
        payload: { nodeId: "n", iteration: 0, cause: "crash", partialTokens: 100, partialCostUsd: 0.25 },
      },
    ]);
    occ.releaseSpend(token);
    expect(occ.pendingSpend()).toEqual([]);
  });

  test("onConflict returns {halted:false, abandoned:true} when every halt append loses", async () => {
    let appends = 0;
    const store = stubStore({
      getState: (() => ({ status: "running", version: 1 })) as unknown as IEventStore["getState"],
      appendFact: (() => {
        appends++;
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: (() => {}) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });
    await occ.onConflict("fact.node_completed", "n", 0, 1);
    await occ.onConflict("fact.node_completed", "n", 0, 1);
    expect(occ.wasAbandoned()).toBe(false);

    expect(await occ.onConflict("fact.node_completed", "n", 0, 1)).toEqual({ halted: false, abandoned: true });
    expect(appends).toBe(HALT_APPEND_MAX_ATTEMPTS);
    expect(occ.wasAbandoned()).toBe(true);
  });

  test("onConflict returns {halted:true} when the run left running mid-retry", async () => {
    let status = "running";
    const store = stubStore({
      getState: (() => ({ status, version: 1 })) as unknown as IEventStore["getState"],
      appendFact: (() => {
        status = "paused";
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: (() => {}) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });
    await occ.onConflict("fact.node_completed", "n", 0, 1);
    await occ.onConflict("fact.node_completed", "n", 0, 1);
    expect(await occ.onConflict("fact.node_completed", "n", 0, 1)).toEqual({ halted: true });
    expect(occ.wasAbandoned()).toBe(false);
  });

  test("onResolved emits occ_conflict_resolved only after prior conflicts, then resets", async () => {
    const obs: { type: string }[] = [];
    const store = stubStore({
      getState: (() => ({ status: "running", version: 1 })) as unknown as IEventStore["getState"],
      appendObservabilityEvents: ((_runId: string, events: { type: string }[]) => {
        obs.push(...events);
      }) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });

    occ.onResolved("n", 0);
    expect(obs).toHaveLength(0); // no prior conflict → nothing emitted

    await occ.onConflict("fact.node_completed", "n", 0, 1);
    occ.onResolved("n", 0);
    expect(obs.map((e) => e.type)).toEqual(["occ_conflict_resolved"]);

    // Reset: a fresh conflict after resolution starts the count over (no
    // immediate warning, which would only fire on the 2nd conflict).
    obs.length = 0;
    await occ.onConflict("fact.node_completed", "n", 0, 1);
    expect(obs).toHaveLength(0);
  });
});

const pausedFact: FactEvent = { type: "fact.run_paused", payload: { reason: "operator", nodeId: "n" } };

function fakeOcc(over: Partial<OccController> = {}): OccController {
  return {
    onConflict: async () => ({ halted: false }),
    onResolved: () => {},
    wasAbandoned: () => false,
    holdSpend: () => 0,
    releaseSpend: () => {},
    pendingSpend: () => [],
    commitSpend: async () => {},
    ...over,
  };
}

type ConcretePlan = OccCommitPlan & { successOutcome: { kind: "terminal" | "continue" } };

describe("commitWithOcc", () => {
  test("halted conflict returns {kind:'terminal'} identically to the prior inline arm", async () => {
    let onSuccessCalled = false;
    const plan: ConcretePlan = {
      occ: fakeOcc({ onConflict: async () => ({ halted: true }) }),
      nodeId: "n",
      iteration: 0,
      expectedVersion: 1,
      commit: async () => ({ ok: false, reason: "occ" }),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => {
        onSuccessCalled = true;
      },
    };
    expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind: "terminal" });
    expect(onSuccessCalled).toBe(false);
  });

  test("non-halted conflict returns {kind:'continue'} and does not run onSuccess", async () => {
    let onSuccessCalled = false;
    let parked: FactEvent[] | undefined = [];
    const out = await commitWithOcc(
      {
        occ: fakeOcc({ onConflict: async () => ({ halted: false }) }),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async () => ({ ok: false, reason: "occ" }),
        successOutcome: { kind: "terminal" },
        statusOutcome: { kind: "terminal" },
        onSuccess: () => {
          onSuccessCalled = true;
        },
        onPark: (f) => {
          parked = f;
        },
      },
      [pausedFact],
    );
    expect(out).toEqual({ kind: "continue" });
    expect(onSuccessCalled).toBe(false);
    expect(parked).toEqual([pausedFact]);
  });

  test("successful commit runs onSuccess and returns the configured successOutcome", async () => {
    for (const kind of ["terminal", "continue"] as const) {
      let ran = false;
      const plan: ConcretePlan = {
        occ: fakeOcc(),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async () => ({ ok: true }),
        successOutcome: { kind },
        statusOutcome: { kind: "terminal" },
        onSuccess: () => {
          ran = true;
        },
      };
      expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind });
      expect(ran).toBe(true);
    }
  });

  test("onSuccess may override the success outcome (abort-loop pause shape)", async () => {
    const plan: ConcretePlan = {
      occ: fakeOcc(),
      nodeId: "n",
      iteration: 0,
      expectedVersion: 1,
      commit: async () => ({ ok: true }),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onSuccess: () => ({ kind: "terminal" }),
    };
    expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind: "terminal" });
  });

  test("successOutcome undefined yields undefined (fan-out pool keeps draining)", async () => {
    const out = await commitWithOcc(
      {
        occ: fakeOcc(),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async () => ({ ok: true }),
        successOutcome: undefined,
        statusOutcome: { kind: "continue" },
        onSuccess: () => {},
      },
      [pausedFact],
    );
    expect(out).toBeUndefined();
  });

  test("status-stop honors statusOutcome without feeding the conflict counter", async () => {
    let conflictCalls = 0;
    const plan: ConcretePlan = {
      occ: fakeOcc({
        onConflict: async () => {
          conflictCalls++;
          return { halted: true };
        },
      }),
      nodeId: "n",
      iteration: 0,
      expectedVersion: 1,
      commit: async () => ({ ok: false, reason: "status" }),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
    };
    expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind: "continue" });
    expect(conflictCalls).toBe(0);
  });

  test("onFail/onNonHalt side-effects fire on the fan-out-shaped arm; halt skips onNonHalt", async () => {
    const nonHaltOrder: string[] = [];
    await commitWithOcc(
      {
        occ: fakeOcc({ onConflict: async () => ({ halted: false }) }),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async () => ({ ok: false, reason: "occ" }),
        successOutcome: undefined,
        statusOutcome: { kind: "continue" },
        onFail: () => {
          nonHaltOrder.push("abort");
        },
        onNonHalt: () => {
          nonHaltOrder.push("drain");
        },
      },
      [pausedFact],
    );
    expect(nonHaltOrder).toEqual(["abort", "drain"]);

    const haltOrder: string[] = [];
    const out = await commitWithOcc(
      {
        occ: fakeOcc({ onConflict: async () => ({ halted: true }) }),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async () => ({ ok: false, reason: "occ" }),
        successOutcome: undefined,
        statusOutcome: { kind: "continue" },
        onFail: () => {
          haltOrder.push("abort");
        },
        onNonHalt: () => {
          haltOrder.push("drain");
        },
      },
      [pausedFact],
    );
    expect(out).toEqual({ kind: "terminal" });
    expect(haltOrder).toEqual(["abort"]);
  });
});

describe("commitWithOcc — claim lost", () => {
  test("commitWithOcc treats claim_lost as terminal without feeding the controller", async () => {
    let conflicts = 0;
    let parked: FactEvent[] | undefined | "unset" = "unset";
    const plan: ConcretePlan = {
      occ: fakeOcc({
        onConflict: async () => {
          conflicts++;
          return { halted: false };
        },
      }),
      nodeId: "n",
      iteration: 0,
      expectedVersion: 1,
      commit: occAppendOnce(
        stubStore({
          appendFact: (() => {
            throw new ClaimLostError(1, 2, 1, 1);
          }) as unknown as IEventStore["appendFact"],
        }),
        "r",
        1,
      ),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onPark: (f) => {
        parked = f;
      },
    };
    expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind: "terminal" });
    expect(conflicts).toBe(0);
    expect(parked).toBeUndefined();
  });

  test("an abandoned conflict is terminal and clears the park", async () => {
    let parked: FactEvent[] | undefined | "unset" = "unset";
    const plan: ConcretePlan = {
      occ: fakeOcc({ onConflict: async () => ({ halted: false, abandoned: true }) }),
      nodeId: "n",
      iteration: 0,
      expectedVersion: 1,
      commit: async () => ({ ok: false, reason: "occ" }),
      successOutcome: { kind: "continue" },
      statusOutcome: { kind: "continue" },
      onPark: (f) => {
        parked = f;
      },
    };
    expect(await commitWithOcc(plan, [pausedFact])).toEqual({ kind: "terminal" });
    expect(parked).toBeUndefined();
  });
});

describe("commitWithOcc — in-turn re-plan", () => {
  const running = (version: number): RunState => ({ status: "running", version }) as unknown as RunState;
  const replanned: FactEvent = { type: "fact.run_paused", payload: { reason: "operator", nodeId: "replanned" } };

  test("a replan hook re-commits re-planned facts on a version-only conflict and never returns continue", async () => {
    const committed: Array<{ facts: FactEvent[]; version: number }> = [];
    let replans = 0;
    let landed: FactEvent[] | undefined;
    const out = await commitWithOcc(
      {
        occ: fakeOcc(),
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: async (f) => {
          committed.push({ facts: f, version: 1 });
          return { ok: false, reason: "occ" };
        },
        successOutcome: { kind: "continue" },
        statusOutcome: { kind: "terminal" },
        readState: () => running(2),
        replan: (fresh) => {
          replans++;
          return {
            facts: [replanned],
            expectedVersion: fresh.version,
            commit: async (f) => {
              committed.push({ facts: f, version: fresh.version });
              return { ok: true };
            },
          };
        },
        onSuccess: (f) => {
          landed = f;
          return { kind: "terminal" };
        },
      },
      [pausedFact],
    );
    expect(out).toEqual({ kind: "terminal" });
    expect(replans).toBe(1);
    expect(committed).toEqual([
      { facts: [pausedFact], version: 1 },
      { facts: [replanned], version: 2 },
    ]);
    expect(landed).toEqual([replanned]);
  });

  test("replan still escalates to occ_exhausted at the ceiling", async () => {
    const appended: FactEvent[][] = [];
    const store = stubStore({
      getState: (() => running(5)) as unknown as IEventStore["getState"],
      appendFact: ((_r: string, facts: FactEvent[]) => {
        appended.push(facts);
        if (facts.some((f) => f.type === "fact.run_terminated")) return {} as never;
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: (() => []) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });
    const out = await commitWithOcc(
      {
        occ,
        nodeId: "n",
        iteration: 0,
        expectedVersion: 1,
        commit: occAppendOnce(store, "r", 1),
        successOutcome: { kind: "continue" },
        statusOutcome: { kind: "continue" },
        readState: () => store.getState("r"),
        replan: (fresh) => ({
          facts: [pausedFact],
          expectedVersion: fresh.version,
          commit: occAppendOnce(store, "r", fresh.version),
        }),
      },
      [pausedFact],
    );
    expect(out).toEqual({ kind: "terminal" });
    const halt = appended.flat().find((f) => f.type === "fact.run_terminated");
    expect((halt?.payload as { reason?: string }).reason).toBe("occ_exhausted");
    expect(appended.filter((b) => b.includes(pausedFact))).toHaveLength(3);
  });

  test("commitParkOrTerminal retries a version-only conflict against the fresh version", async () => {
    const versions: number[] = [];
    let current = 1;
    const store = stubStore({
      getState: (() => running(current)) as unknown as IEventStore["getState"],
      appendFact: ((_r: string, _f: FactEvent[], expected: number) => {
        versions.push(expected);
        if (expected !== 2) {
          current = 2;
          throw new ConcurrencyError(expected, 2);
        }
        return {} as never;
      }) as unknown as IEventStore["appendFact"],
      appendObservabilityEvents: (() => []) as unknown as IEventStore["appendObservabilityEvents"],
    });
    const occ = makeOccController({ store, runId: "r", shutdownSignal: noSignal });
    const out = await commitParkOrTerminal({ store, runId: "r", occ, nodeId: "n", iteration: 0, expectedVersion: 1 }, [
      pausedFact,
    ]);
    expect(out).toEqual({ kind: "terminal" });
    expect(versions).toEqual([1, 2]);
  });
});

describe("occAppendOnce", () => {
  test("maps a successful append to ok, a ConcurrencyError to reason 'occ' (never status)", async () => {
    const ok = stubStore({ appendFact: (() => ({}) as never) as unknown as IEventStore["appendFact"] });
    expect(await occAppendOnce(ok, "r", 0)([pausedFact])).toEqual({ ok: true });

    const conflict = stubStore({
      appendFact: (() => {
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
    });
    expect(await occAppendOnce(conflict, "r", 0)([pausedFact])).toEqual({ ok: false, reason: "occ" });
  });
});
