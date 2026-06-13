// Tests for `--json` on `fragua runs ls`, `fragua runs status`, and
// `fragua runs inbox`.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { RunDetail, RunSummary } from "@fragua/core/read-plane";
import type { IEventStore } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { inboxCommand, lsCommand, statusCommand } from "../src/commands/operator.ts";

const BASE = "a".repeat(40);

interface Rig {
  dbPath: string;
  store: IEventStore;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-json-flags-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(
    "wf",
    "test-wf",
    "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n",
    serializeGraph(parseWorkflow("name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n")),
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

function seedCompleted(store: IEventStore, runId: string, cwd = "/tmp/repo"): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd });
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

function seedPausedHuman(store: IEventStore, runId: string, cwd = "/tmp/repo"): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd });
  const s0 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_started",
        payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "n1" },
      },
    ],
    s0.version,
  );
  const s1 = store.getState(runId)!;
  store.appendFact(
    runId,
    [{ type: "fact.run_paused_human", payload: { nodeId: "n1", text: "approve?", routes: ["approve", "reject"] } }],
    s1.version,
  );
}

describe("fragua runs --json flags", () => {
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

  // ── ls --json ──────────────────────────────────────────────────────────

  test("ls --json emits a JSON array of RunSummary rows", async () => {
    seedCompleted(r.store, "ls1", "/tmp/jrepo");
    seedCompleted(r.store, "ls2", "/tmp/jrepo");
    const code = await lsCommand({ json: true, cwd: "/tmp/jrepo", dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunSummary[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    const ids = parsed.map((r) => r.runId);
    expect(ids).toContain("ls1");
    expect(ids).toContain("ls2");
  });

  test("ls --json with no runs emits an empty array", async () => {
    const code = await lsCommand({ json: true, cwd: "/tmp/nobody", dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunSummary[];
    expect(parsed).toEqual([]);
  });

  test("ls --json includes runStatus field", async () => {
    seedCompleted(r.store, "lsj", "/tmp/jrepo2");
    await lsCommand({ json: true, cwd: "/tmp/jrepo2", dbPath: r.dbPath });
    const parsed = JSON.parse(out()) as RunSummary[];
    expect(parsed[0]!.runStatus).toBe("completed");
  });

  // ── status --json ─────────────────────────────────────────────────────

  test("status --json emits a RunDetail object with runId", async () => {
    seedCompleted(r.store, "stj1");
    const code = await statusCommand({ runId: "stj1", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunDetail & { budgetWarns: unknown[] };
    expect(parsed.runId).toBe("stj1");
    expect(parsed.runStatus).toBe("completed");
    expect(Array.isArray(parsed.budgetWarns)).toBe(true);
  });

  test("status --json includes budgetWarns array", async () => {
    seedCompleted(r.store, "stj2");
    // Append a budget.warn observability event
    r.store.appendObservabilityEvents("stj2", [
      {
        type: "budget.warn",
        payload: { scope: "run", metric: "cost", limit: 1.0, actual: 0.85, ratio: 0.85 },
      },
    ]);
    const code = await statusCommand({ runId: "stj2", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { budgetWarns: Array<{ scope: string; metric: string }> };
    expect(parsed.budgetWarns).toHaveLength(1);
    expect(parsed.budgetWarns[0]!.scope).toBe("run");
    expect(parsed.budgetWarns[0]!.metric).toBe("cost");
  });

  test("status --json includes crashRequeues", async () => {
    seedCompleted(r.store, "stj3");
    const s = r.store.getState("stj3")!;
    r.store.appendFact(
      "stj3",
      [{ type: "fact.run_requeued_after_crash", payload: { prevNode: "n1", lastAliveAt: 999_500 } }],
      s.version,
    );
    const code = await statusCommand({ runId: "stj3", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as RunDetail;
    expect(parsed.crashRequeues).toHaveLength(1);
    expect(parsed.crashRequeues![0]!.prevNode).toBe("n1");
    expect(parsed.crashRequeues![0]!.lastAliveAt).toBe(999_500);
    expect(typeof parsed.crashRequeues![0]!.at).toBe("number");
  });

  test("status --json: unknown run → exit 1", async () => {
    const code = await statusCommand({ runId: "nope", json: true, dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ── inbox --json ─────────────────────────────────────────────────────

  test("inbox --json emits {needsInput, readyToLand}", async () => {
    seedPausedHuman(r.store, "ib1", "/tmp/inboxjrepo");
    seedCompleted(r.store, "ib2", "/tmp/inboxjrepo");
    // mark ib2 as inbox pending (it has a snapshot so inbox picks it up)
    const s2 = r.store.getState("ib2")!;
    r.store.appendFact(
      "ib2",
      [
        {
          type: "fact.snapshot_recorded",
          payload: {
            eventIdx: 3,
            treeSha: "t".repeat(40),
            commitSha: "s".repeat(40),
            parentSnap: "",
            headSha: "c".repeat(40),
            headRef: null,
            diffBaseSha: BASE,
            committed: { filesChanged: 1, insertions: 1, deletions: 0 },
            uncommitted: null,
          },
        },
      ],
      s2.version,
    );
    const code = await inboxCommand({ json: true, cwd: "/tmp/inboxjrepo", dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { needsInput: unknown[]; readyToLand: unknown[] };
    expect(Array.isArray(parsed.needsInput)).toBe(true);
    expect(Array.isArray(parsed.readyToLand)).toBe(true);
    // paused_human run is in needsInput
    const inputIds = (parsed.needsInput as Array<{ runId: string }>).map((r) => r.runId);
    expect(inputIds).toContain("ib1");
  });

  test("inbox --json empty → both arrays empty", async () => {
    const code = await inboxCommand({ json: true, cwd: "/tmp/nobody2", dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { needsInput: unknown[]; readyToLand: unknown[] };
    expect(parsed.needsInput).toEqual([]);
    expect(parsed.readyToLand).toEqual([]);
  });
});
