// `fragua runs explain` CLI verb tests.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { RunExplanation } from "@fragua/core/read-plane";
import type { IEventStore } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { explainCommand } from "../src/commands/operator.ts";

const BASE = "a".repeat(40);

interface Rig {
  dbPath: string;
  store: IEventStore;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-explain-"));
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

function seedCompleted(store: IEventStore, runId: string): void {
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
  const s1 = store.getState(runId)!;
  store.appendFact(runId, [{ type: "fact.run_completed", payload: { finalNode: "n1" } }], s1.version);
}

function seedCompletedWithCachedCost(store: IEventStore, runId: string): void {
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
      {
        type: "fact.node_started",
        payload: {
          nodeId: "n1",
          iteration: 0,
        },
      },
    ],
    s0.version,
  );
  store.appendObservabilityEvents(runId, [
    {
      type: "llm.start",
      payload: {
        nodeId: "n1",
        iteration: 0,
        model: "claude-sonnet",
      },
    },
    {
      type: "cost.recorded",
      payload: {
        nodeId: "n1",
        iteration: 0,
        input_tokens: 24,
        output_tokens: 4171,
        cache_read_tokens: 10000,
        cache_write_tokens: 200,
        total_tokens: 14395,
        cost_usd: 0.5002,
      },
    },
  ]);
  const s1 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.node_completed",
        payload: {
          nodeId: "n1",
          iteration: 0,
          tokens: 14395,
          costUsd: 0.5002,
          inputTokens: 24,
          outputTokens: 4171,
          cacheReadTokens: 10000,
          cacheWriteTokens: 200,
          nextNode: "exit",
          outcomeStatus: "success",
        },
      },
      { type: "fact.run_completed", payload: { finalNode: "n1" } },
    ],
    s1.version,
  );
}

function seedHalted(store: IEventStore, runId: string): void {
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
  const s1 = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.run_halted", payload: { reason: "budget", detail: "run cost budget exhausted" } }],
    s1.version,
  );
}

describe("fragua runs explain", () => {
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

  test("seedCompleted → exit 0, human render mentions completed + run id", async () => {
    seedCompleted(r.store, "ex1");
    const code = await explainCommand({ runId: "ex1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("ex1");
    expect(out()).toContain("completed");
  });

  test("human render shows outcome label", async () => {
    seedHalted(r.store, "ex2");
    const code = await explainCommand({ runId: "ex2", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("halted");
    expect(out()).toContain("budget");
  });

  test("--json prints a parseable RunExplanation", async () => {
    seedCompleted(r.store, "ex3");
    const code = await explainCommand({ runId: "ex3", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunExplanation;
    expect(parsed.runId).toBe("ex3");
    expect(parsed.outcome.kind).toBe("completed");
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(Array.isArray(parsed.path)).toBe(true);
    expect(Array.isArray(parsed.budgetWarnings)).toBe(true);
  });

  test("--json includes totals", async () => {
    seedCompleted(r.store, "ex4");
    const code = await explainCommand({ runId: "ex4", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunExplanation;
    expect(typeof parsed.totals.costUsd).toBe("number");
    expect(typeof parsed.totals.inputTokens).toBe("number");
    expect(typeof parsed.totals.outputTokens).toBe("number");
  });

  test("--json totals include cache tokens", async () => {
    seedCompletedWithCachedCost(r.store, "ex-cache-json");
    const code = await explainCommand({ runId: "ex-cache-json", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunExplanation;
    expect(parsed.totals.inputTokens).toBe(24);
    expect(parsed.totals.outputTokens).toBe(4171);
    expect(parsed.totals.cacheReadTokens).toBe(10000);
    expect(parsed.totals.cacheWriteTokens).toBe(200);
    expect(parsed.totals.billedTokens).toBe(14395);
    expect(parsed.steps[0]!.billedTokens).toBe(14395);
  });

  test("human render includes cache tokens in the total", async () => {
    seedCompletedWithCachedCost(r.store, "ex-cache-human");
    const code = await explainCommand({ runId: "ex-cache-human", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("(24+4171+10200 cached = 14395 tok)");
  });

  test("unknown run → exit 1", async () => {
    const code = await explainCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });
});
