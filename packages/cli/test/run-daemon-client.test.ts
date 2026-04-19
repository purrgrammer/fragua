// End-to-end test for `swarm run` in its fire-and-forget daemon-client
// shape: spin up a foreground daemon, call runCommandViaDaemon against
// a real workflow file, verify a row appears in the queue via GET /jobs.
//
// We intentionally don't wait for the worker to finish — the whole point
// of Phase 7 is that `swarm run` returns immediately after POSTing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRendezvous } from "@swarm/server";
import { daemonRunCommand } from "../src/commands/daemon.ts";
import { runCommandViaDaemon } from "../src/commands/run.ts";

// Trivial DOT that passes `validateOrThrow` + has at least one node.
const TRIVIAL_DOT = `digraph g { graph [ goal="noop" ]; start [shape=Mdiamond]; end [shape=doublecircle]; start -> end; }`;

describe("runCommandViaDaemon (fire-and-forget)", () => {
  let cwd: string | undefined;
  let done: Promise<number> | undefined;
  let workflow: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-runcli-"));
    workflow = join(cwd, "noop.dot");
    await writeFile(workflow, TRIVIAL_DOT);
    // Foreground daemon for the duration of the test.
    done = daemonRunCommand({ cwd, port: 0 });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await readRendezvous(cwd)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (!(await readRendezvous(cwd))) throw new Error("daemon failed to come up");
  });

  afterEach(async () => {
    if (done) {
      process.emit("SIGTERM");
      await done;
      done = undefined;
    }
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("enqueues the job via POST /jobs and exits 0", async () => {
    // Capture stdout so we can assert the human-readable confirmation.
    const origLog = console.log;
    let captured = "";
    console.log = (...args: unknown[]) => {
      captured += `${args.join(" ")}\n`;
    };
    try {
      const code = await runCommandViaDaemon({
        workflow: workflow!,
        cwd: cwd!,
        input: "hello",
        noAutostart: true, // daemon is already up
      });
      expect(code).toBe(0);
      // Output should include the `queued:` banner + a runId hint.
      expect(captured).toContain("queued:");
      expect(captured).toMatch(/run:\s+\d+-[a-z0-9]{6}/);
    } finally {
      console.log = origLog;
    }

    // GET /jobs should show exactly one queued or running row.
    const r = await readRendezvous(cwd!);
    expect(r).toBeDefined();
    const res = await fetch(`http://127.0.0.1:${r!.port}/jobs`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ workflow: string; input?: string; status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workflow).toBe(workflow!);
    expect(rows[0]?.input).toBe("hello");
  });

  test("workflow file missing → exit 1 without POSTing", async () => {
    const origErr = console.error;
    let captured = "";
    console.error = (...args: unknown[]) => {
      captured += `${args.join(" ")}\n`;
    };
    try {
      const code = await runCommandViaDaemon({
        workflow: "nonexistent.dot",
        cwd: cwd!,
        noAutostart: true,
      });
      expect(code).toBe(1);
      expect(captured).toContain("workflow not found");
    } finally {
      console.error = origErr;
    }
  });

  test("bare workflow name resolves via ./workflows/<name>.dot", async () => {
    // The UI + GET /workflows speak in bare names ("build-feature");
    // the CLI should accept the same shape, not force users to type
    // `./workflows/build-feature.dot`.
    await mkdir(join(cwd!, "workflows"), { recursive: true });
    await writeFile(join(cwd!, "workflows", "build-feature.dot"), TRIVIAL_DOT);

    const origLog = console.log;
    let captured = "";
    console.log = (...args: unknown[]) => {
      captured += `${args.join(" ")}\n`;
    };
    try {
      const code = await runCommandViaDaemon({
        workflow: "build-feature",
        cwd: cwd!,
        input: "hi",
        noAutostart: true,
      });
      expect(code).toBe(0);
      expect(captured).toContain("queued:");
    } finally {
      console.log = origLog;
    }

    const r = await readRendezvous(cwd!);
    const res = await fetch(`http://127.0.0.1:${r!.port}/jobs`);
    const rows = (await res.json()) as Array<{ workflow: string }>;
    expect(rows.at(-1)?.workflow).toBe(join(cwd!, "workflows", "build-feature.dot"));
  });

  test("--no-autostart + no daemon → exit 1 with a start hint", async () => {
    // Temporarily tear down the daemon so this leg exercises the fence.
    process.emit("SIGTERM");
    await done;
    done = undefined;

    const origErr = console.error;
    let captured = "";
    console.error = (...args: unknown[]) => {
      captured += `${args.join(" ")}\n`;
    };
    try {
      const code = await runCommandViaDaemon({
        workflow: workflow!,
        cwd: cwd!,
        noAutostart: true,
      });
      expect(code).toBe(1);
      expect(captured).toContain("daemon not running");
      // Don't leak mention of --no-autostart here (hint is for the opposite).
    } finally {
      console.error = origErr;
    }
  });
});
