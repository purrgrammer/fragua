// Tests for soft budget warning surfacing in `fragua runs status` and
// `renderEvent` in `run-follow.ts`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { IEventStore, StoredEvent } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { statusCommand } from "../src/commands/operator.ts";
import { renderEvent } from "../src/run-follow.ts";

interface Rig {
  dbPath: string;
  store: IEventStore;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-budget-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(
    "wf",
    "test-wf",
    "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: test-wf\nsteps:\n  n1: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  return {
    dbPath,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BASE = "a".repeat(40);

function seedRunning(store: IEventStore, runId: string): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd: "/tmp/repo" });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: {
          workflowSha: "wf",
          contractVersion: s0.contractVersion,
          startNode: "n1",
          baseGitSha: BASE,
          baseGitRef: "main",
        },
      },
    ],
    s0.version,
  );
}

describe("fragua runs status — soft budget warning surfacing", () => {
  let r: Rig;
  let logs: string[];

  beforeEach(() => {
    r = rig();
    logs = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    r.close();
  });

  const out = (): string => logs.join("\n");

  test("budget.warn present + no later budget.stop → status output contains '80%' and scope:metric", async () => {
    seedRunning(r.store, "bw1");
    r.store.appendObservabilityEvents("bw1", [
      {
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.82, ratio: 0.82 },
      },
    ]);
    const code = await statusCommand({ runId: "bw1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("run:cost");
    // ratio 0.82 → 82%
    expect(out()).toContain("82%");
  });

  test("budget.warn followed by budget.stop for same (scope,metric) → warning suppressed", async () => {
    seedRunning(r.store, "bw2");
    r.store.appendObservabilityEvents("bw2", [
      {
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.82, ratio: 0.82 },
      },
    ]);
    r.store.appendObservabilityEvents("bw2", [
      {
        type: "budget.stop",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 1.05 },
      },
    ]);
    const code = await statusCommand({ runId: "bw2", dbPath: r.dbPath });
    expect(code).toBe(0);
    // The warning is consumed by the hard stop — should NOT show the 80% warn
    expect(out()).not.toContain("run:cost");
    expect(out()).not.toContain("82%");
  });

  test("multiple budget.warn entries for different (scope,metric) all surface", async () => {
    seedRunning(r.store, "bw3");
    r.store.appendObservabilityEvents("bw3", [
      {
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.85, ratio: 0.85 },
      },
    ]);
    r.store.appendObservabilityEvents("bw3", [
      {
        type: "budget.warn",
        payload: { scope: "run", metric: "tokens", limit: 100000, actual: 83000, ratio: 0.83 },
      },
    ]);
    const code = await statusCommand({ runId: "bw3", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("run:cost");
    expect(out()).toContain("run:tokens");
  });
});

describe("renderEvent — budget.warn highlighting", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
  });

  const out = (): string => logs.join("\n");

  test("budget.warn event prefixes ⚠ glyph and shows scope:metric", () => {
    const ev: StoredEvent = {
      seq: 42,
      ts: 1000,
      type: "budget.warn",
      payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.85, ratio: 0.85 },
      runId: "r1",
      writer: "daemon",
    };
    renderEvent(ev);
    expect(out()).toContain("⚠");
    expect(out()).toContain("budget.warn");
    expect(out()).toContain("run:cost");
    expect(out()).toContain("85%");
  });

  test("non-budget event renders normally (no ⚠)", () => {
    const ev: StoredEvent = {
      seq: 1,
      ts: 1000,
      type: "fact.run_completed",
      payload: { finalNode: "n1" },
      runId: "r1",
      writer: "daemon",
    };
    renderEvent(ev);
    expect(out()).not.toContain("⚠");
    expect(out()).toContain("fact.run_completed");
  });
});
