// `fragua runs <verb>` CLI verbs. Writes (steer/pause/cancel/resume/respond/
// unquarantine/priority/budget/max-*/accept/discard) are store-clients: the
// command opens the store by `dbPath` and writes through the plane (accept/
// discard run the workspace git action first). Reads (inbox) still go over
// HTTP against a server bound to the same file-backed store.
//
// Git mutation is covered in @fragua/workspace run-actions.test.ts; the server
// accept/discard route in operator-actions.routes.test.ts. Here we assert the
// CLI wiring: the right intent lands, refusals exit non-zero, validation
// short-circuits before opening the store.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import type { RunSnapshotReader } from "@fragua/server";
import { createServer } from "@fragua/server";
import { type IEventStore, SqliteStore } from "@fragua/store";
import { doctorCommand } from "../src/commands/doctor.ts";
import {
  acceptCommand,
  artifactCommand,
  artifactsCommand,
  budgetCommand,
  cancelCommand,
  discardCommand,
  eventsCommand,
  goalGateCommand,
  inboxCommand,
  lsCommand,
  maxLoopsCommand,
  maxRetriesCommand,
  messagesCommand,
  pauseCommand,
  priorityCommand,
  respondCommand,
  resumeCommand,
  statusCommand,
  steerCommand,
  stepsCommand,
  tailCommand,
  unquarantineCommand,
} from "../src/commands/operator.ts";

// Permissive snapshot reader for the server (inbox/diff routes). The CLI
// store-clients don't use it; the real git lives in @fragua/workspace tests.
const permissiveReader: RunSnapshotReader = {
  lsTree: async () => null,
  showFile: async () => ({ kind: "not_found" }),
  diff: async () => "",
  mergeability: async () => ({ resolved: true, ff: true, conflict: false }),
  refExists: async () => true,
};

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

interface Rig {
  url: string;
  dbPath: string;
  store: IEventStore;
  close: () => Promise<void>;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-op-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow(
    "wf",
    "noop",
    "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  n1: {type: llm, prompt: x}\n")),
    CURRENT_IR_VERSION,
  );
  const app = createServer({ store, ports: { runSnapshotReader: permissiveReader } });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  return {
    url: `http://127.0.0.1:${server.port}`,
    dbPath,
    store,
    close: async () => {
      await server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A queued (non-terminal) run — for gate-refusal paths. */
function seedQueued(store: IEventStore, runId: string): void {
  store.enqueueRun({ runId, workflowSha: "wf", cwd: "/tmp/repo" });
}

/** A terminal run with committed history in the inbox. */
function seedCommitted(store: IEventStore, runId: string): void {
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
  const s2 = store.getState(runId)!;
  store.appendFact(
    runId,
    [
      {
        type: "fact.snapshot_recorded",
        payload: {
          eventIdx: 3,
          treeSha: "t".repeat(40),
          commitSha: "s".repeat(40),
          parentSnap: "",
          headSha: COMMIT,
          headRef: null,
          diffBaseSha: BASE,
          committed: { filesChanged: 1, insertions: 5, deletions: 0 },
          uncommitted: null,
        },
      },
    ],
    s2.version,
  );
}

/** A run paused at a HITL gate with two routes. */
function seedPausedHuman(store: IEventStore, runId: string): void {
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
    [{ type: "fact.run_paused_human", payload: { nodeId: "n1", text: "approve?", routes: ["approve", "reject"] } }],
    s1.version,
  );
}

function lastIntent(store: IEventStore, runId: string): string | undefined {
  const evs = store.getEvents(runId);
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i]!.type.startsWith("intent.")) return evs[i]!.type;
  }
  return undefined;
}

describe("fragua operator verbs", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await r.close();
  });

  // ─── accept / discard: CLI wiring + gate refusals (git happy-path elsewhere)

  const wrote = (runId: string, type: string): boolean => r.store.getEvents(runId).some((e) => e.type === type);

  test("accept: non-terminal run → refused (not_terminal), exit 1, no accept_run", async () => {
    seedQueued(r.store, "rq1");
    const code = await acceptCommand({ runId: "rq1", dbPath: r.dbPath });
    expect(code).toBe(1);
    expect(wrote("rq1", "intent.accept_run")).toBe(false);
  });

  test("discard: non-terminal run → refused, exit 1, no discard_run", async () => {
    seedQueued(r.store, "rq2");
    const code = await discardCommand({ runId: "rq2", dbPath: r.dbPath });
    expect(code).toBe(1);
    expect(wrote("rq2", "intent.discard_run")).toBe(false);
  });

  test("accept: unknown run → exit 1", async () => {
    const code = await acceptCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ─── status / tail (read verbs)

  test("status: prints the run's id + lifecycle status", async () => {
    seedCommitted(r.store, "rst");
    const logs: string[] = [];
    (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const code = await statusCommand({ runId: "rst", dbPath: r.dbPath });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("rst");
    expect(out).toContain("completed");
  });

  test("status: unknown run → exit 1", async () => {
    const code = await statusCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ─── title fallback: no auto-title → workflow name, never "(untitled)"

  test("status: untitled run falls back to workflow name", async () => {
    // No summariser ran → run_state.title is null. Falls back to workflow name
    // (the read-plane resolves the name from the workflow table, which stores
    // the name as 'noop' in the test rig).
    r.store.enqueueRun({
      runId: "rwn",
      workflowSha: "wf",
      cwd: "/tmp/repo",
      initialRouting: {},
    });
    const logs: string[] = [];
    (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const code = await statusCommand({ runId: "rwn", dbPath: r.dbPath });
    expect(code).toBe(0);
    const out = logs.join("\n");
    // 'noop' is the workflow name stored in the test rig's workflow table.
    expect(out).toContain("noop");
    expect(out).not.toContain("(untitled)");
  });

  test("ls: run with no title and no input falls back to the workflow name", async () => {
    r.store.enqueueRun({ runId: "rwf", workflowSha: "wf", cwd: "/tmp/repo", workflowName: "nightly-sweep" });
    const logs: string[] = [];
    (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const code = await lsCommand({ dbPath: r.dbPath, cwd: "/tmp/repo" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("nightly-sweep");
    expect(out).not.toContain("(untitled)");
  });

  test("tail: unknown run → exit 1 (no live loop)", async () => {
    const code = await tailCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ─── control intents through the plane

  test("resume: exit 0, appends intent.resume", async () => {
    seedCommitted(r.store, "rr");
    const code = await resumeCommand({ runId: "rr", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rr")).toBe("intent.resume");
  });

  test("cancel: exit 0, appends intent.cancel_requested", async () => {
    seedCommitted(r.store, "rc");
    const code = await cancelCommand({ runId: "rc", reason: "qa", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rc")).toBe("intent.cancel_requested");
  });

  test("unquarantine: missing --resolution → exit 1, store untouched", async () => {
    seedCommitted(r.store, "rq");
    const code = await unquarantineCommand({ runId: "rq", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("steer: exit 0, appends intent.steering_requested", async () => {
    seedCommitted(r.store, "rs");
    const code = await steerCommand({ runId: "rs", text: "skip the migration", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rs")).toBe("intent.steering_requested");
  });

  test("steer: empty text → exit 1, store untouched", async () => {
    const code = await steerCommand({ runId: "rs", text: "  ", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("steer: unknown run → exit 1", async () => {
    const code = await steerCommand({ runId: "ghost", text: "x", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("pause: exit 0, appends intent.pause_requested", async () => {
    seedCommitted(r.store, "rp");
    const code = await pauseCommand({ runId: "rp", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rp")).toBe("intent.pause_requested");
  });

  test("priority: exit 0, appends intent.priority_adjusted", async () => {
    seedCommitted(r.store, "rpr");
    const code = await priorityCommand({ runId: "rpr", newPriority: 10, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rpr")).toBe("intent.priority_adjusted");
  });

  test("priority: non-numeric → exit 1, store untouched", async () => {
    const code = await priorityCommand({ runId: "rpr", newPriority: Number.NaN, dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("budget: exit 0, appends intent.budget_adjusted", async () => {
    seedCommitted(r.store, "rb");
    const code = await budgetCommand({ runId: "rb", scope: "run", metric: "cost", newLimit: 5, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rb")).toBe("intent.budget_adjusted");
  });

  test("budget: missing flags → exit 1, store untouched", async () => {
    const code = await budgetCommand({ runId: "rb", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("max-retries: exit 0, appends intent.max_retries_adjusted", async () => {
    seedCommitted(r.store, "rmr");
    const code = await maxRetriesCommand({ runId: "rmr", nodeId: "n1", newLimit: 5, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rmr")).toBe("intent.max_retries_adjusted");
  });

  test("max-retries: missing --node → exit 1, store untouched", async () => {
    const code = await maxRetriesCommand({ runId: "rmr", newLimit: 5, dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("goal-gate: exit 0, appends intent.goal_gate_adjusted", async () => {
    seedCommitted(r.store, "rgg");
    const code = await goalGateCommand({ runId: "rgg", newLimit: 3, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rgg")).toBe("intent.goal_gate_adjusted");
  });

  test("goal-gate: non-numeric → exit 1, store untouched", async () => {
    const code = await goalGateCommand({ runId: "rgg", newLimit: Number.NaN, dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("max-loops: exit 0, appends intent.max_loops_adjusted", async () => {
    seedCommitted(r.store, "rml");
    const code = await maxLoopsCommand({ runId: "rml", newLimit: 20, dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rml")).toBe("intent.max_loops_adjusted");
  });

  test("max-loops: non-numeric → exit 1, store untouched", async () => {
    const code = await maxLoopsCommand({ runId: "rml", newLimit: Number.NaN, dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ─── respond: reads the HITL gate from events, writes intent.human_input

  test("respond: valid route → exit 0, appends intent.human_input", async () => {
    seedPausedHuman(r.store, "rh1");
    const code = await respondCommand({ runId: "rh1", route: "approve", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(lastIntent(r.store, "rh1")).toBe("intent.human_input");
  });

  test("respond: off-list route → exit 1", async () => {
    seedPausedHuman(r.store, "rh2");
    const code = await respondCommand({ runId: "rh2", route: "bogus", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("respond: run not at a HITL gate → exit 1", async () => {
    seedCommitted(r.store, "rh3"); // terminal, not paused_human
    const code = await respondCommand({ runId: "rh3", route: "approve", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  // ─── inbox: HTTP read against the server bound to the same store

  test("inbox: lists pending runs by id, filters cwd, exit 0", async () => {
    seedCommitted(r.store, "in-1"); // committed-history → inbox_status=pending, cwd=/tmp/repo
    const logs: string[] = [];
    (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const code = await inboxCommand({ dbPath: r.dbPath, cwd: "/tmp/repo" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("in-1");
    expect(out).toContain("+5"); // committed stat round-trips server → CLI
  });
});

// ─── Forensics (read) verbs: events / steps / messages / artifacts / artifact

describe("fragua forensics verbs", () => {
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
  afterEach(async () => {
    await r.close();
  });
  const out = (): string => logs.join("\n");

  test("events: seedCommitted → exit 0, output has a fact. line", async () => {
    seedCommitted(r.store, "ev1");
    const code = await eventsCommand({ runId: "ev1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("fact.run_completed");
  });

  test("events: --type filters to the matching prefix", async () => {
    seedCommitted(r.store, "ev2");
    const code = await eventsCommand({ runId: "ev2", type: "fact.run_completed", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("fact.run_completed");
    expect(out()).not.toContain("fact.run_started");
  });

  test("events: --json emits an array of stored events", async () => {
    seedCommitted(r.store, "ev3");
    const code = await eventsCommand({ runId: "ev3", json: true, dbPath: r.dbPath });
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as Array<{ type: string }>;
    expect(parsed.some((e) => e.type === "fact.run_completed")).toBe(true);
  });

  test("events: unknown run → exit 1", async () => {
    const code = await eventsCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("steps: seedCommitted (no llm.start) → (no LLM steps), exit 0", async () => {
    seedCommitted(r.store, "st1");
    const code = await stepsCommand({ runId: "st1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("(no LLM steps)");
  });

  test("steps: unknown run → exit 1", async () => {
    const code = await stepsCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("messages: seedCommitted → exit 0", async () => {
    seedCommitted(r.store, "ms1");
    const code = await messagesCommand({ runId: "ms1", dbPath: r.dbPath });
    expect(code).toBe(0);
  });

  test("messages: a seeded message renders a preview line", async () => {
    seedCommitted(r.store, "ms2");
    r.store.appendMessage("ms2", {
      content: { role: "user", content: "hello forensics", timestamp: new Date().toISOString() } as never,
      nodeId: "n1",
      iteration: 0,
    });
    const code = await messagesCommand({ runId: "ms2", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("hello forensics");
    expect(out()).toContain("user");
  });

  test("messages: unknown run → exit 1", async () => {
    const code = await messagesCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("artifacts: lists a put artifact; empty run → (no artifacts)", async () => {
    seedCommitted(r.store, "ar1");
    const empty = await artifactsCommand({ runId: "ar1", dbPath: r.dbPath });
    expect(empty).toBe(0);
    expect(out()).toContain("(no artifacts)");

    logs.length = 0;
    r.store.putArtifact(
      { runId: "ar1", nodeId: "n1", key: "report.md", iteration: 0 },
      new TextEncoder().encode("# Report\nbody"),
      "text/markdown",
    );
    const code = await artifactsCommand({ runId: "ar1", dbPath: r.dbPath });
    expect(code).toBe(0);
    expect(out()).toContain("report.md");
    expect(out()).toContain("n1#0");
  });

  test("artifacts: unknown run → exit 1", async () => {
    const code = await artifactsCommand({ runId: "nope", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("artifact: prints the body of a text artifact", async () => {
    seedCommitted(r.store, "ar2");
    r.store.putArtifact(
      { runId: "ar2", nodeId: "n1", key: "out.txt", iteration: 0 },
      new TextEncoder().encode("forensic body"),
      "text/plain",
    );
    const written: Uint8Array[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(chunk as Uint8Array);
      return true;
    });
    const code = await artifactCommand({ runId: "ar2", nodeId: "n1", key: "out.txt", dbPath: r.dbPath });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(new TextDecoder().decode(written[0])).toBe("forensic body");
  });

  test("artifact: binary content → exit 1, refuses to garble stdout", async () => {
    seedCommitted(r.store, "ar3");
    r.store.putArtifact(
      { runId: "ar3", nodeId: "n1", key: "blob.bin", iteration: 0 },
      new Uint8Array([1, 2, 0, 3]),
      "application/octet-stream",
    );
    const code = await artifactCommand({ runId: "ar3", nodeId: "n1", key: "blob.bin", dbPath: r.dbPath });
    expect(code).toBe(1);
  });

  test("artifact: missing key → exit 1", async () => {
    seedCommitted(r.store, "ar4");
    const code = await artifactCommand({ runId: "ar4", nodeId: "n1", key: "ghost", dbPath: r.dbPath });
    expect(code).toBe(1);
  });
});

// ─── doctor: liveness check

describe("fragua doctor", () => {
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
  afterEach(async () => {
    await r.close();
  });

  test("doctor: exit 0, mentions store path + daemon state", async () => {
    const code = await doctorCommand({ dbPath: r.dbPath });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(r.dbPath);
    expect(out).toContain("no daemon");
  });
});
