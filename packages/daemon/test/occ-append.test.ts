import { describe, expect, test } from "bun:test";
import { ConcurrencyError, type FactEvent, type IEventStore } from "@fragua/store";
import {
  commitWithOcc,
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
  return { onConflict: async () => ({ halted: false }), onResolved: () => {}, ...over };
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
