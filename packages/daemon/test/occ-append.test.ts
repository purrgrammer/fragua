import { describe, expect, test } from "bun:test";
import { ConcurrencyError, type IEventStore } from "@fragua/store";
import { makeOccController, tryAppendFact } from "../src/occ-append.ts";

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
    expect(await tryAppendFact(ok, "r", 0, [{ type: "fact.run_halted", payload: { reason: "error" } }])).toBe(true);

    const conflict = stubStore({
      appendFact: (() => {
        throw new ConcurrencyError(1, 2);
      }) as unknown as IEventStore["appendFact"],
    });
    expect(await tryAppendFact(conflict, "r", 0, [{ type: "fact.run_halted", payload: { reason: "error" } }])).toBe(
      false,
    );

    const boom = stubStore({
      appendFact: (() => {
        throw new Error("disk full");
      }) as unknown as IEventStore["appendFact"],
    });
    await expect(
      tryAppendFact(boom, "r", 0, [{ type: "fact.run_halted", payload: { reason: "error" } }]),
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
