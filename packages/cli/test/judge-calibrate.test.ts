// `fragua judge calibrate` — the report reads gate bounds out of the graph a
// run executed and the answers out of that run's judge messages, so a bound
// edited since is still compared against its own runs.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import { judgeCalibrateCommand } from "../src/commands/judge.ts";

const WF = (keepMin: number) => `
name: lens
steps:
  read:
    prompt: p
    outputs:
      findings:
        type: array
        items: {type: object, fields: {claim: {type: string}}}
    next: judge
  judge:
    type: judge
    for-each: \${{ outputs.read.findings }}
    questions:
      present: {type: noul, instructions: Does \`item.claim\` hold?}
    keep: {present: ${keepMin}}
    next: exit
`;

let dir: string;
let dbPath: string;
let lines: string[];
let restore: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fragua-calibrate-"));
  dbPath = join(dir, "t.db");
  lines = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  restore = () => {
    console.log = original;
  };
});

afterEach(async () => {
  restore();
  await rm(dir, { recursive: true, force: true });
});

/** A store holding one run of `lens` whose judge answered `values`. */
function seed(values: number[], keepMin = 0.6): void {
  const store = new SqliteStore({ path: dbPath });
  const src = WF(keepMin);
  store.saveWorkflow("sha", "lens", src, serializeGraph(parseWorkflow(src)), CURRENT_IR_VERSION);
  const runId = "01ktest0000000000000000000";
  store.enqueueRun({ runId, workflowSha: "sha" });
  const answers: Record<string, unknown> = {};
  values.forEach((v, i) => {
    answers[`present__${i}`] = { type: "noul", noul: v };
  });
  store.appendMessage(runId, {
    content: {
      role: "judge_node",
      provider: "typesafe",
      model: "jev-1.13.0",
      statePreview: "",
      stateBytes: 0,
      questions: { present: { type: "noul", instructions: "q" } },
      answers,
      durationMs: 1,
      timestamp: 0,
    } as never,
    nodeId: "judge",
    iteration: 0,
  });
  store.close();
}

describe("fragua judge calibrate", () => {
  test("counts reads near the bound and inside the uncertain band", async () => {
    // 0.59 and 0.62 straddle the 0.6 bound; 0.95 is clear of it.
    seed([0.59, 0.62, 0.95]);
    expect(await judgeCalibrateCommand({ dbPath })).toBe(0);
    const out = lines.join("\n");
    // The run was enqueued without a display name, so the report falls back
    // to the workflow sha.
    expect(out).toContain("sha");
    expect(out).toContain("present");
    expect(out).toContain("keep");
    expect(out).toMatch(/near bound 2 \(67%\)/);
    expect(out).toContain("3 gate read(s)");
    expect(out).toMatch(/2 \(67%\) within 0\.1 of their bound/);
    // 0.59 and 0.62 are both inside 0.3–0.7; 0.95 is not.
    expect(out).toMatch(/2 \(67%\) inside the uncertain band/);
  });

  test("--margin narrows the flip-risk window", async () => {
    // 0.62 is 0.02 from the bound, 0.45 is 0.15 away, 0.95 is clear.
    seed([0.45, 0.62, 0.95]);
    expect(await judgeCalibrateCommand({ dbPath, margin: 0.05 })).toBe(0);
    expect(lines.join("\n")).toMatch(/1 \(33%\) within 0\.05 of their bound/);
  });

  test("an empty store says so instead of printing an empty report", async () => {
    const store = new SqliteStore({ path: dbPath });
    store.close();
    expect(await judgeCalibrateCommand({ dbPath })).toBe(0);
    expect(lines.join("\n")).toContain("no judge answers recorded");
  });

  test("a workflow filter that matches nothing reports the scope", async () => {
    seed([0.8]);
    expect(await judgeCalibrateCommand({ dbPath, workflow: "other" })).toBe(0);
    expect(lines.join("\n")).toContain('workflow "other"');
  });
});
