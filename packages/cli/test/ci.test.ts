// `fragua ci` — the embedded one-shot executor. These drive the real command
// end-to-end against an ephemeral on-disk store with a no-op (exit-only)
// workflow: no provider creds, no network. The pinned `--db` is the artifact,
// so the assertions open it and check the persisted run reached `completed`.
//
// stdout is suppressed during the call (the command streams the event log
// there) to keep the test output clean; the exit code + the `.db` are what we
// assert on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeReadPlane } from "@fragua/core/read-plane";
import { SqliteStore } from "@fragua/store";
import { CLI_EXIT } from "../src/cli-exit.ts";
import { type CiCommandOptions, ciCommand } from "../src/commands/ci.ts";

let dir: string;
let wfPath: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fragua-ci-test-"));
  wfPath = join(dir, "smoke.yaml");
  dbPath = join(dir, "ci.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the command with stdout muted (it streams the event log there). */
async function runCi(opts: CiCommandOptions): Promise<number> {
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await ciCommand(opts);
  } finally {
    process.stdout.write = orig;
  }
}

/** Run the command capturing every stdout chunk, returned as the list of
 *  non-empty lines written (the `--json` event stream + the terminal result
 *  line). */
async function captureCi(opts: CiCommandOptions): Promise<{ code: number; lines: string[] }> {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await ciCommand(opts);
    const lines = buf.split("\n").filter((l) => l.length > 0);
    return { code, lines };
  } finally {
    process.stdout.write = orig;
  }
}

interface ResultLine {
  kind: string;
  runId: string;
  status: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  outputs?: Record<string, unknown>;
}

/** Partition captured `--json` lines into the per-event lines and the single
 *  terminal result line, keyed on the `kind: "fragua.run_result"` tag. */
function partition(lines: string[]): { events: Array<Record<string, unknown>>; results: ResultLine[] } {
  const events: Array<Record<string, unknown>> = [];
  const results: ResultLine[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed["kind"] === "fragua.run_result") results.push(parsed as unknown as ResultLine);
    else events.push(parsed);
  }
  return { events, results };
}

/** Open the pinned `--db` artifact and read the single run's raw lifecycle
 * status + event-type log. (`RunSummary.status` is the projected outcome —
 * "success"/"fail" — so the raw terminal status comes from `getState`.) */
function readArtifact(): { status: string; types: string[] } {
  const store = new SqliteStore({ path: dbPath, migrate: false });
  try {
    const rp = makeReadPlane({ store });
    const runs = rp.runSummaries();
    expect(runs.length).toBe(1);
    const runId = runs[0]!.runId;
    const events = rp.events(runId) ?? [];
    return { status: store.getState(runId)?.status ?? "(absent)", types: events.map((e) => e.type) };
  } finally {
    store.close();
  }
}

describe("ciCommand", () => {
  test("drives a no-op (exit-only) workflow to completed; exit 0; .db holds the terminal fact", async () => {
    writeFileSync(wfPath, "name: ci-smoke\nsteps:\n  done: {type: exit}\n");
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(0);
    const { status, types } = readArtifact();
    expect(status).toBe("completed");
    expect(types).toContain("fact.run_terminated");
  });

  test("a tool step that fails with no fail route halts (aborted_exit) → exit 11", async () => {
    writeFileSync(wfPath, 'name: ci-fail\nsteps:\n  boom:\n    type: tool\n    run: "exit 1"\n    next: exit\n');
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(11); // HALT_EXIT.aborted_exit
    const { status, types } = readArtifact();
    expect(status).toBe("halted");
    expect(types).toContain("fact.run_terminated");
  });

  test("a tool step that fails but routes fail→exit lands gracefully → exit 0", async () => {
    writeFileSync(
      wfPath,
      'name: ci-soft-fail\nsteps:\n  boom:\n    type: tool\n    run: "exit 1"\n    on: {success: exit, fail: exit}\n',
    );
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(0);
    expect(readArtifact().status).toBe("completed");
  });

  test("--input-json end-to-end: enqueued routing.inputs carries the parsed shape", async () => {
    writeFileSync(wfPath, "name: ci-inputs\ninputs:\n  ticket: {type: string}\nsteps:\n  done: {type: exit}\n");
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true, inputJson: '{"ticket":"BUG-1"}' });
    expect(code).toBe(0);
    const store = new SqliteStore({ path: dbPath, migrate: false });
    try {
      const runId = makeReadPlane({ store }).runSummaries()[0]!.runId;
      expect(store.getState(runId)!.routing["inputs"]).toEqual({ ticket: "BUG-1" });
    } finally {
      store.close();
    }
  });

  test("--input end-to-end: number/boolean inputs are coerced into routing.inputs", async () => {
    writeFileSync(
      wfPath,
      "name: ci-nb\ninputs:\n  count: {type: number}\n  flag: {type: boolean}\nsteps:\n  done: {type: exit}\n",
    );
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true, inputs: { count: "3", flag: "true" } });
    expect(code).toBe(0);
    const store = new SqliteStore({ path: dbPath, migrate: false });
    try {
      const runId = makeReadPlane({ store }).runSummaries()[0]!.runId;
      expect(store.getState(runId)!.routing["inputs"]).toEqual({ count: 3, flag: true });
    } finally {
      store.close();
    }
  });

  test("missing workflow → exit 1", async () => {
    const code = await runCi({ workflow: join(dir, "does-not-exist.yaml"), cwd: dir, dbPath, json: true });
    expect(code).toBe(1);
  });

  test("unparseable workflow → exit 1", async () => {
    writeFileSync(wfPath, "this: is: not: a: valid: workflow\n");
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(1);
  });

  test("a live env secret in a TEXT surface (routing input) is scrubbed — does NOT fail CI (exit 80)", async () => {
    // Text surfaces (genesis routing, messages, events) are always scrubbed by
    // exportRunBundle. A literal hit there is non-fatal — liveLiteralHit is
    // reserved for the binary-artifact residual (§13). The binary-gate itself
    // is exercised in packages/store/test/bundle.test.ts (ci profile, tests d/b2).
    const secretVal = "fragua-test-secret-token-ABCDE12345678";
    const exportPath = join(dir, "run.fragua");
    // Declare the input in the workflow so buildEnqueue accepts it.
    writeFileSync(wfPath, "name: ci-leak\ninputs:\n  secret_input:\n    type: string\nsteps:\n  done: {type: exit}\n");
    const prevToken = process.env["FRAGUA_CI_TEST_TOKEN"];
    try {
      process.env["FRAGUA_CI_TEST_TOKEN"] = secretVal;
      const code = await runCi({
        workflow: wfPath,
        cwd: dir,
        dbPath,
        exportPath,
        inputs: { secret_input: secretVal },
        json: true,
      });
      // Text surface — scrubbed, non-fatal: must NOT produce exit 80.
      expect(code).not.toBe(CLI_EXIT.scrubLeak);
    } finally {
      if (prevToken === undefined) delete process.env["FRAGUA_CI_TEST_TOKEN"];
      else process.env["FRAGUA_CI_TEST_TOKEN"] = prevToken;
    }
    // The bundle was written — verify it exists.
    expect(existsSync(exportPath)).toBe(true);
  });
});

describe("ciCommand --json terminal result envelope", () => {
  test("emits ONE result line tagged kind=fragua.run_result, distinguishable from event lines", async () => {
    writeFileSync(wfPath, "name: ci-result\nsteps:\n  done: {type: exit}\n");
    const { code, lines } = await captureCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(0);
    const { events, results } = partition(lines);
    // Exactly one result line; it is the last line emitted.
    expect(results.length).toBe(1);
    expect(JSON.parse(lines.at(-1)!).kind).toBe("fragua.run_result");
    // Every event line carries seq + type and NO kind; the result line is the
    // inverse — unambiguous in both directions.
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(typeof ev["seq"]).toBe("number");
      expect(typeof ev["type"]).toBe("string");
      expect("kind" in ev).toBe(false);
    }
    const result = results[0]!;
    expect("seq" in result).toBe(false);
    expect("type" in result).toBe(false);
    expect(typeof result.runId).toBe("string");
  });

  test("status=completed for a sanctioned exit; usage carries the run-total rollup", async () => {
    writeFileSync(wfPath, "name: ci-ok\nsteps:\n  done: {type: exit}\n");
    const { results } = partition((await captureCi({ workflow: wfPath, cwd: dir, dbPath, json: true })).lines);
    expect(results[0]!.status).toBe("completed");
    const usage = results[0]!.usage;
    expect(typeof usage.inputTokens).toBe("number");
    expect(typeof usage.outputTokens).toBe("number");
    expect(typeof usage.costUsd).toBe("number");
  });

  test("status=errored when a tool step halts with no fail route", async () => {
    writeFileSync(wfPath, 'name: ci-halt\nsteps:\n  boom:\n    type: tool\n    run: "exit 1"\n    next: exit\n');
    const { results } = partition((await captureCi({ workflow: wfPath, cwd: dir, dbPath, json: true })).lines);
    expect(results.length).toBe(1);
    expect(results[0]!.status).toBe("errored");
  });

  test("outputs omitted (typed-partial) when the workflow declares none", async () => {
    writeFileSync(wfPath, "name: ci-no-out\nsteps:\n  done: {type: exit}\n");
    const { results } = partition((await captureCi({ workflow: wfPath, cwd: dir, dbPath, json: true })).lines);
    expect(results[0]!.outputs).toBeUndefined();
  });

  test("a non-terminal stop-state (paused_human) emits NO result line", async () => {
    writeFileSync(
      wfPath,
      "name: ci-hitl\nsteps:\n  ask:\n    type: human\n    text: pick one\n    routes: {go: exit}\n",
    );
    const { lines } = await captureCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    const { results } = partition(lines);
    expect(results.length).toBe(0);
  });

  test("no result line when --json is off (human render)", async () => {
    writeFileSync(wfPath, "name: ci-plain\nsteps:\n  done: {type: exit}\n");
    const { lines } = await captureCi({ workflow: wfPath, cwd: dir, dbPath });
    expect(lines.some((l) => l.includes("fragua.run_result"))).toBe(false);
  });
});
