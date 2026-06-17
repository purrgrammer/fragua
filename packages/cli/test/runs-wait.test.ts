// `fragua runs wait` — the fleet-wait read-loop. Drives a file-backed store
// with runs in mixed lifecycle states and asserts both the aggregate exit code
// (through the shared cli-exit map) and the one-line-per-transition output.
//
// The loop is a store-client poll: `waitCommand` opens its own connection to
// the same db path the test seeds, so flipping a run's status mid-wait (from a
// scheduled timer that fires during the loop's `sleep`) is observed on the next
// poll — exercising the real transition path without mocking the read plane.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { type IEventStore, SqliteStore } from "@fragua/store";
import type { HaltReason } from "@fragua/types";
import { CLI_EXIT, HALT_EXIT, PAUSE_EXIT, QUARANTINE_EXIT } from "../src/cli-exit.ts";
import { waitCommand } from "../src/commands/wait.ts";

const CWD = "/tmp/wait-repo";

interface Rig {
  dir: string;
  dbPath: string;
  store: IEventStore;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-wait-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  const src = "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n";
  store.saveWorkflow("wfa", "alpha", src, serializeGraph(parseWorkflow(src)), CURRENT_IR_VERSION);
  store.saveWorkflow("wfb", "beta", src, serializeGraph(parseWorkflow(src)), CURRENT_IR_VERSION);
  return {
    dir,
    dbPath,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function started(store: IEventStore, runId: string, workflowSha = "wfa"): void {
  store.enqueueRun({ runId, workflowSha, cwd: CWD });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.run_started", payload: { workflowSha, contractVersion: s0.contractVersion, startNode: "n1" } }],
    s0.version,
  );
}

function complete(store: IEventStore, runId: string, workflowSha = "wfa"): void {
  started(store, runId, workflowSha);
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
    s.version,
  );
}

function halt(store: IEventStore, runId: string, reason: HaltReason = "error", workflowSha = "wfa"): void {
  started(store, runId, workflowSha);
  const s = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_terminated", payload: { status: "errored", reason } }], s.version);
}

function quarantine(store: IEventStore, runId: string): void {
  started(store, runId);
  const s = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_quarantined", payload: { reason: "other" } }], s.version);
}

function pausedHuman(store: IEventStore, runId: string): void {
  started(store, runId);
  const s = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.run_paused", payload: { reason: "human", nodeId: "n1", text: "ok?", routes: ["yes", "no"] } }],
    s.version,
  );
}

function pause(store: IEventStore, runId: string): void {
  started(store, runId);
  const s = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_paused", payload: { reason: "operator", nodeId: "n1" } }], s.version);
}

describe("runs wait", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });
  afterEach(() => {
    r.close();
  });

  test("exits 0 when all selected runs completed", async () => {
    complete(r.store, "r1");
    complete(r.store, "r2");
    const code = await waitCommand({ ids: ["r1", "r2"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(CLI_EXIT.ok);
  });

  test("exits with the halt-band code when a selected run halted", async () => {
    complete(r.store, "r1");
    halt(r.store, "r2", "error");
    const code = await waitCommand({ ids: ["r1", "r2"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(HALT_EXIT.error);
  });

  test("exits with the quarantine-band code when a run is quarantined", async () => {
    quarantine(r.store, "r1");
    const code = await waitCommand({ ids: ["r1"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(QUARANTINE_EXIT.other);
  });

  test("exits needsHuman when a run is blocked on a HITL gate (default --settle blocked)", async () => {
    pausedHuman(r.store, "r1");
    const code = await waitCommand({ ids: ["r1"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(CLI_EXIT.needsHuman);
  });

  test("default --settle blocked treats an operator pause as settled (PAUSE_EXIT.operator)", async () => {
    pause(r.store, "r1");
    const code = await waitCommand({ ids: ["r1"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(PAUSE_EXIT.operator);
  });

  test("--settle terminal keeps waiting through paused and exits on the terminal status", async () => {
    pause(r.store, "r1"); // starts paused — not terminal
    // Flip to completed mid-wait, after the loop has observed `paused`.
    const t = setTimeout(() => {
      const s = r.store.getState("r1")!;
      r.store.appendFact("r1", [{ type: "fact.run_resumed", payload: { fromStatus: "paused" } }], s.version);
      const s2 = r.store.getState("r1")!;
      r.store.appendFact(
        "r1",
        [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
        s2.version,
      );
    }, 25);
    const code = await waitCommand({ ids: ["r1"], dbPath: r.dbPath, settle: "terminal", pollMs: 5 });
    clearTimeout(t);
    expect(code).toBe(CLI_EXIT.ok);
  });

  test("prints one transition line per run per status change", async () => {
    started(r.store, "r1"); // running
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const p = waitCommand({ ids: ["r1"], dbPath: r.dbPath, pollMs: 5 });
    const t = setTimeout(() => {
      const s = r.store.getState("r1")!;
      r.store.appendFact(
        "r1",
        [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
        s.version,
      );
    }, 25);
    const code = await p;
    clearTimeout(t);
    spy.mockRestore();
    expect(code).toBe(CLI_EXIT.ok);
    const transitions = logs.filter((l) => l.includes("r1") && l.includes("→ completed"));
    expect(transitions).toHaveLength(1);
  });

  test("--timeout expiry exits CLI_EXIT.timeout while a run is still running", async () => {
    started(r.store, "r1"); // stays running forever
    const code = await waitCommand({ ids: ["r1"], dbPath: r.dbPath, timeout: "15ms", pollMs: 5 });
    expect(code).toBe(CLI_EXIT.timeout);
  });

  test("--workflow selects every active run of that workflow", async () => {
    complete(r.store, "done-a", "wfa"); // already settled → excluded
    halt(r.store, "halt-a", "error", "wfa"); // settled-failed → excluded
    started(r.store, "live-a", "wfa"); // active alpha → selected
    started(r.store, "live-b", "wfb"); // active beta → ignored
    // Flip the one selected alpha run to halted mid-wait.
    const t = setTimeout(() => {
      const s = r.store.getState("live-a")!;
      r.store.appendFact(
        "live-a",
        [{ type: "fact.run_terminated", payload: { status: "errored", reason: "budget" } }],
        s.version,
      );
    }, 25);
    const code = await waitCommand({ workflow: "alpha", cwd: CWD, dbPath: r.dbPath, pollMs: 5 });
    clearTimeout(t);
    expect(code).toBe(HALT_EXIT.budget);
  });

  test("--all-running selects only currently-active runs", async () => {
    complete(r.store, "old"); // terminal → excluded
    started(r.store, "live"); // active → selected
    const t = setTimeout(() => {
      const s = r.store.getState("live")!;
      r.store.appendFact(
        "live",
        [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
        s.version,
      );
    }, 25);
    const code = await waitCommand({ allRunning: true, cwd: CWD, dbPath: r.dbPath, pollMs: 5 });
    clearTimeout(t);
    expect(code).toBe(CLI_EXIT.ok);
  });

  test("errors (exit 1) when no selector is given", async () => {
    const code = await waitCommand({ dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(1);
  });

  test("errors (exit 1) when an explicit id is unknown", async () => {
    const code = await waitCommand({ ids: ["nope"], dbPath: r.dbPath, pollMs: 5 });
    expect(code).toBe(1);
  });
});
