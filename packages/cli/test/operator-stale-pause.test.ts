// Regression: `fragua runs status` must not report a pause reason that a later
// `fact.run_resumed` already consumed. The "why" scan walks the log backwards
// for the last `fact.run_paused`; without a stop at the resume boundary it walks
// straight past it and prints a spent reason on a run that has moved on.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { IEventStore } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { statusCommand } from "../src/commands/operator.ts";

interface Rig {
  dbPath: string;
  store: IEventStore;
  close: () => void;
}

const SRC = "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n";

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-stale-pause-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow("wf", "test-wf", SRC, serializeGraph(parseWorkflow(SRC)), CURRENT_IR_VERSION);
  return {
    dbPath,
    store,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Start a run, then park it on a provider_error pause. */
function seedPaused(store: IEventStore, runId: string): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd: "/tmp/repo" });
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
    [
      {
        type: "fact.run_paused",
        payload: {
          reason: "provider_error",
          nodeId: "n1",
          httpStatus: 401,
          provider: "anthropic",
          errorMessage: "OAuth access token has expired. Re-authenticate to continue.",
        },
      },
    ],
    s1.version,
  );
}

describe("fragua runs status — a consumed pause reason is not reported", () => {
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

  test("pause with no resume → the reason IS reported", async () => {
    seedPaused(r.store, "sp1");
    const code = await statusCommand({ runId: "sp1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("paused:");
    expect(out()).toContain("provider_error");
  });

  test("pause followed by resume → the spent reason is NOT reported", async () => {
    seedPaused(r.store, "sp2");
    const s = r.store.getState("sp2")!;
    r.store.appendFact("sp2", [{ type: "fact.run_resumed", payload: { fromStatus: "paused" } }], s.version);

    const code = await statusCommand({ runId: "sp2", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).not.toContain("paused:");
    expect(out()).not.toContain("provider_error");
    expect(out()).not.toContain("OAuth access token has expired");
  });

  test("pause → resume → pause again reports only the LATEST reason", async () => {
    seedPaused(r.store, "sp3");
    const s1 = r.store.getState("sp3")!;
    r.store.appendFact("sp3", [{ type: "fact.run_resumed", payload: { fromStatus: "paused" } }], s1.version);
    const s2 = r.store.getState("sp3")!;
    r.store.appendFact(
      "sp3",
      [{ type: "fact.run_paused", payload: { reason: "goal_gate", gateNodeId: "arbitrate", currentLimit: 3 } }],
      s2.version,
    );

    const code = await statusCommand({ runId: "sp3", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("goal_gate");
    expect(out()).not.toContain("provider_error");
  });

  test("an answered HITL gate leaves no pause line on the completed run", async () => {
    // The shape a real signoff gate produces, taken off a live run:
    //   fact.run_paused{reason:"human"} → intent.human_input{route}
    //   → fact.run_resumed{fromStatus:"paused_human", inputIntentSeq}
    // `human` is the pause an operator meets most often, and it resumes through
    // a different verb than the operator `resume` the cases above cover.
    r.store.enqueueRun({ runId: "sp4", workflowSha: "wf", cwd: "/tmp/repo" });
    const s0 = r.store.getState("sp4")!;
    r.store.appendFact(
      "sp4",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "n1" },
        },
      ],
      s0.version,
    );
    const s1 = r.store.getState("sp4")!;
    r.store.appendFact(
      "sp4",
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "human",
            nodeId: "signoff",
            text: "Approve the PR, post it as feedback, or keep it local?",
            routes: ["approve", "feedback", "accept"],
          },
        },
      ],
      s1.version,
    );
    const s2 = r.store.getState("sp4")!;
    r.store.appendFact(
      "sp4",
      [{ type: "fact.run_resumed", payload: { fromStatus: "paused_human", inputIntentSeq: 22012 } }],
      s2.version,
    );

    const code = await statusCommand({ runId: "sp4", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).not.toContain("paused:");
    expect(out()).not.toContain("Approve the PR");
  });
});
