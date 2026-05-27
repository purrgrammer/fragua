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
    expect(types).toContain("fact.run_completed");
  });

  test("a tool step that fails with no fail route halts (aborted_exit) → exit 11", async () => {
    writeFileSync(wfPath, 'name: ci-fail\nsteps:\n  boom:\n    type: tool\n    run: "exit 1"\n    next: exit\n');
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(11); // HALT_EXIT.aborted_exit
    const { status, types } = readArtifact();
    expect(status).toBe("halted");
    expect(types).toContain("fact.run_halted");
  });

  test("a tool step that fails but routes fail→exit lands gracefully → exit 0", async () => {
    writeFileSync(
      wfPath,
      'name: ci-soft-fail\nsteps:\n  boom:\n    type: tool\n    run: "exit 1"\n    on: {fail: exit}\n',
    );
    const code = await runCi({ workflow: wfPath, cwd: dir, dbPath, json: true });
    expect(code).toBe(0);
    expect(readArtifact().status).toBe("completed");
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

  test("exits non-zero when a live env secret reaches the bundle (perimeter leak)", async () => {
    // Strategy: set a *_TOKEN env var whose value is also passed as a run
    // input. The CI profile captures the env secret at seed time and adds it
    // as an extraLiteral to the registry. The input value is embedded in the
    // genesis event routing, so exportRunBundle finds the literal, sets
    // liveLiteralHit=true, and ciCommand returns non-zero.
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
      expect(code).toBe(CLI_EXIT.scrubLeak);
    } finally {
      if (prevToken === undefined) delete process.env["FRAGUA_CI_TEST_TOKEN"];
      else process.env["FRAGUA_CI_TEST_TOKEN"] = prevToken;
    }
    // The bundle was still written even on a leak — verify it exists.
    expect(existsSync(exportPath)).toBe(true);
  });
});
