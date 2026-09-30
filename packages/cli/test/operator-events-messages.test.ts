// `fragua runs events` / `runs messages` forensic reads must emit complete,
// parseable JSON regardless of run size. Two failure modes are pinned here:
//
//  1. Undrained stdout. Both verbs wrote their JSON with a fire-and-forget
//     `console.log` and then let `main` call `process.exit`. On a pipe that
//     discards node's buffered stdout past the ~64KB kernel buffer, so a
//     multi-MB event log or a 200KB assistant message came out truncated
//     (`jq` reported "Unfinished JSON term at EOF"). The round-trip tests
//     spawn the real bin through a genuine shell pipe — the only way to
//     reproduce the truncation — and assert `JSON.parse` succeeds.
//  2. No way to ask for the whole log + a `fact.*` glob filter. Exercised
//     in-process: `--all` lifts the default-50 window, `--type 'fact.*'`
//     narrows to facts, and the human render closes with a
//     "showing last N of M" footer only when the window elided events.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { newRunId, SqliteStore } from "@fragua/store";
import { eventsCommand } from "../src/commands/operator.ts";

setDefaultTimeout(30_000);

const BIN = join(import.meta.dir, "..", "bin", "fragua.ts");
const WF_SRC = "name: test-wf\nsteps:\n  n1: {type: llm, prompt: x, next: exit}\n";

interface Rig {
  dir: string;
  dbPath: string;
  store: SqliteStore;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-events-msgs-"));
  const dbPath = join(dir, "t.db");
  const store = new SqliteStore({ path: dbPath });
  store.saveWorkflow("wf", "test-wf", WF_SRC, serializeGraph(parseWorkflow(WF_SRC)), CURRENT_IR_VERSION);
  return { dir, dbPath, store };
}

/** Seed a started run and return its id. */
function seedStarted(store: SqliteStore): string {
  const runId = newRunId();
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
  return runId;
}

/** Run the real bin through a genuine shell pipe (`| cat`), returning stdout.
 * The pipe is what forces the truncation on an undrained write. */
function pipeBin(args: string): string {
  const cmd = `bun ${JSON.stringify(BIN)} ${args} 2>/dev/null | cat`;
  return execFileSync("sh", ["-c", cmd], { maxBuffer: 512 * 1024 * 1024 }).toString();
}

describe("runs events / messages — forensic JSON reads", () => {
  let r: Rig;

  beforeEach(() => {
    r = rig();
  });

  afterEach(() => {
    r.store.close();
    rmSync(r.dir, { recursive: true, force: true });
  });

  test("events --json --all round-trips a 25k-event run through JSON.parse", () => {
    const runId = seedStarted(r.store);
    const TARGET = 25_000;
    for (let i = 0; i < TARGET; i += 1_000) {
      const batch = Array.from({ length: 1_000 }, (_, k) => ({
        type: "llm.text_delta" as const,
        payload: { nodeId: "n1", iteration: 0, content_index: 0, text: `chunk ${i + k}` },
      }));
      r.store.appendObservabilityEvents(runId, batch);
    }
    r.store.close();

    const out = pipeBin(`runs events ${runId} --json --all --db ${JSON.stringify(r.dbPath)}`);
    const parsed = JSON.parse(out) as Array<{ type: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    // 25k deltas + run_started + intent.run_enqueued.
    expect(parsed.length).toBeGreaterThanOrEqual(TARGET);
  });

  test("events --type 'fact.*' returns only fact events", async () => {
    const runId = seedStarted(r.store);
    r.store.appendObservabilityEvents(runId, [
      { type: "llm.start", payload: { nodeId: "n1", iteration: 0, prompt: "p" } },
      { type: "cost.recorded", payload: { nodeId: "n1", iteration: 0, cost_usd: 0.01 } },
    ]);
    const s1 = r.store.getState(runId)!;
    r.store.appendFact(
      runId,
      [{ type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } }],
      s1.version,
    );

    const chunks: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array, cb?: unknown) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      if (typeof cb === "function") (cb as () => void)();
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await eventsCommand({ runId, type: "fact.*", all: true, json: true, dbPath: r.dbPath });
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(chunks.join("")) as Array<{ type: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((e) => e.type.startsWith("fact."))).toBe(true);
    // The mixed observability events are excluded.
    expect(parsed.some((e) => e.type === "llm.start")).toBe(false);
  });

  test("events human output prints the 'showing last N of M' footer when truncated; --all suppresses it", async () => {
    const runId = seedStarted(r.store);
    // 120 observability events → well past the default 50-event window.
    for (let i = 0; i < 120; i++) {
      r.store.appendObservabilityEvents(runId, [
        { type: "llm.text_delta", payload: { nodeId: "n1", iteration: 0, content_index: 0, text: `d${i}` } },
      ]);
    }

    const errs: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errs.push(a.join(" "));
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await eventsCommand({ runId, dbPath: r.dbPath });
      const footer = errs.join("\n");
      expect(footer).toMatch(/showing last 50 of \d+ events/);
      expect(footer).toMatch(/--all for everything/);

      errs.length = 0;
      await eventsCommand({ runId, all: true, dbPath: r.dbPath });
      expect(errs.join("\n")).not.toMatch(/showing last/);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test("messages --json parses on a run with a 200 KB assistant message", () => {
    const runId = seedStarted(r.store);
    const big = "x".repeat(200 * 1024);
    r.store.appendMessage(runId, {
      content: { role: "assistant", content: [{ type: "text", text: big }] } as never,
      nodeId: "n1",
      iteration: 0,
    });
    r.store.close();

    const out = pipeBin(`runs messages ${runId} --json --db ${JSON.stringify(r.dbPath)}`);
    const parsed = JSON.parse(out) as Array<{ content: { content: Array<{ text?: string }> } }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content.content[0]!.text!.length).toBe(big.length);
  });
});
