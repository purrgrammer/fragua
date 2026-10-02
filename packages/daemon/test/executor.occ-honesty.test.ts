// OCC honesty — a halt or pause that loses an OCC race must never leave the run
// stranded in `running` (SPEC I12 / ARCH §1.6). The pre-dispatch decisions
// (engine_incompatible pause, max_loops pause) now commit through the shared
// `commitParkOrTerminal`, so a conflicted append re-drives (the pause lands next
// turn) or escalates to `occ_exhausted` — the run always leaves `running`.

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AbortRegistry } from "../src/abort-registry.ts";
import { runOne } from "../src/executor.ts";
import { type AppendFaultSchedule, faultStore } from "./fault-store.ts";
import { enqueue, rig } from "./helpers.ts";

function rawDb(store: unknown): Database {
  return (store as { db: Database }).db;
}

function isPause(reason: string): (f: { type: string; payload: unknown }) => boolean {
  return (f) => f.type === "fact.run_paused" && (f.payload as { reason?: string }).reason === reason;
}

async function drive(
  runId: string,
  r: ReturnType<typeof rig>,
  schedule: AppendFaultSchedule,
  opts: { maxLoops?: number } = {},
): Promise<void> {
  const faulted = faultStore(r.store, schedule);
  await runOne(runId, {
    store: faulted.store,
    dispatcher: r.dispatcher,
    registry: new AbortRegistry(),
    tools: r.tools,
    llmCall: r.llmCall,
    maxConcurrentRuns: 1,
    maxTurnsForTesting: 30,
    shutdownSignal: new AbortController().signal,
    ...(opts.maxLoops !== undefined ? { maxLoops: opts.maxLoops } : {}),
  });
}

describe("OCC honesty — pre-dispatch pause/halt never strands the run running", () => {
  test("a conflicted engine-incompatible pause still lands the pause fact", async () => {
    const r = rig();
    enqueue(r, "eng", "start");
    // Skew the contract version out of the daemon's fold window.
    rawDb(r.store).query("UPDATE run_state SET contract_version = ? WHERE run_id = ?").run(999, "eng");
    r.store.claimNextRun(1);

    // Conflict the FIRST engine_incompatible pause append, then let it through.
    let occ = 1;
    await drive("eng", r, (_i, facts) => {
      if (occ > 0 && facts.some(isPause("engine_incompatible"))) {
        occ--;
        return "occ";
      }
      return "ok";
    });

    const state = r.store.getState("eng")!;
    expect(state.status).not.toBe("running");
    expect(state.status).toBe("paused");
    const pause = r.store.getEvents("eng").find(isPause("engine_incompatible"));
    expect(pause).toBeDefined();
    r.store.close();
  });

  test("a conflicted max_loops pause still lands or the run leaves running", async () => {
    const r = rig();
    enqueue(r, "loops", "start");
    r.store.claimNextRun(1);

    let occ = 1;
    // maxLoops:0 trips the ceiling on the first real dispatch turn.
    await drive(
      "loops",
      r,
      (_i, facts) => {
        if (occ > 0 && facts.some(isPause("max_loops"))) {
          occ--;
          return "occ";
        }
        return "ok";
      },
      { maxLoops: 0 },
    );

    const state = r.store.getState("loops")!;
    expect(state.status).not.toBe("running");
    // The transient conflict re-drives, so the pause lands.
    expect(state.status).toBe("paused");
    expect(r.store.getEvents("loops").some(isPause("max_loops"))).toBe(true);
    r.store.close();
  });

  test("a persistently conflicted engine-incompatible pause escalates to occ_exhausted, never stays running", async () => {
    const r = rig();
    enqueue(r, "eng-x", "start");
    rawDb(r.store).query("UPDATE run_state SET contract_version = ? WHERE run_id = ?").run(999, "eng-x");
    r.store.claimNextRun(1);

    // Conflict EVERY engine_incompatible pause append; the occ_exhausted
    // terminal (a different fact) is allowed through so the run can settle.
    await drive("eng-x", r, (_i, facts) => (facts.some(isPause("engine_incompatible")) ? "occ" : "ok"));

    const state = r.store.getState("eng-x")!;
    expect(state.status).not.toBe("running");
    expect(state.status).toBe("halted");
    const halt = r.store
      .getEvents("eng-x")
      .find((e) => e.type === "fact.run_terminated" && (e.payload as { reason?: string }).reason === "occ_exhausted");
    expect(halt).toBeDefined();
    r.store.close();
  });
});
