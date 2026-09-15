// Tests for the `fragua harness` supervisor.
//
// Strategy: bind the in-process HTTP server on port 0, pre-seed the
// daemon lock so `waitForLock` resolves immediately, and inject a fake
// `spawn` seam so we control the daemon subprocess lifecycle without
// launching a real one. We drive crashes / signal behaviour through the
// fake proc and assert the supervisor's restart + shutdown policy.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { harnessCommand } from "../src/commands/harness.ts";

interface FakeProc {
  exited: Promise<number>;
  killed: boolean;
  kill(signal?: number): void;
  crash(code: number): void;
  lastSignal: number | undefined;
}

function makeFakeProc(): FakeProc {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const proc: FakeProc = {
    exited,
    killed: false,
    lastSignal: undefined,
    kill(signal?: number) {
      this.killed = true;
      this.lastSignal = signal;
      resolveExit(signal === 9 ? 137 : 143);
    },
    crash(code: number) {
      resolveExit(code);
    },
  };
  return proc;
}

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

describe("harnessCommand", () => {
  let scratch: string | undefined;
  const prevNoBuild = process.env["FRAGUA_NO_WEB_BUILD"];

  afterEach(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
    if (prevNoBuild === undefined) delete process.env["FRAGUA_NO_WEB_BUILD"];
    else process.env["FRAGUA_NO_WEB_BUILD"] = prevNoBuild;
  });

  test("restarts the daemon subprocess after an unexpected crash", async () => {
    process.env["FRAGUA_NO_WEB_BUILD"] = "1";
    scratch = await mkdtemp(join(tmpdir(), "fragua-harness-"));
    const dbPath = join(scratch, "fragua.db");
    // Seed the lock so waitForLock resolves without a real daemon.
    const seed = new SqliteStore({ path: dbPath });
    seed.acquireDaemonLock(1234, "test-host");
    seed.close();

    const procs: FakeProc[] = [];
    const spawn = () => {
      const p = makeFakeProc();
      procs.push(p);
      return p as unknown as ReturnType<typeof Bun.spawn>;
    };

    const done = harnessCommand({
      dbPath,
      port: 0,
      spawn,
      restartInitialBackoffMs: 10,
      maxFastFailures: 5,
    });

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // Simulate a daemon crash — the supervisor must respawn.
    procs[0]!.crash(1);
    expect(await waitFor(() => procs.length >= 2)).toBe(true);

    process.emit("SIGINT");
    const code = await done;
    expect(code).toBe(0);
  });

  test("gives up after N consecutive fast crashes and exits non-zero", async () => {
    process.env["FRAGUA_NO_WEB_BUILD"] = "1";
    scratch = await mkdtemp(join(tmpdir(), "fragua-harness-"));
    const dbPath = join(scratch, "fragua.db");
    const seed = new SqliteStore({ path: dbPath });
    seed.acquireDaemonLock(1234, "test-host");
    seed.close();

    const procs: FakeProc[] = [];
    const spawn = () => {
      const p = makeFakeProc();
      procs.push(p);
      // Crash immediately on every spawn (fast failure).
      queueMicrotask(() => p.crash(1));
      return p as unknown as ReturnType<typeof Bun.spawn>;
    };

    const code = await harnessCommand({
      dbPath,
      port: 0,
      spawn,
      restartInitialBackoffMs: 5,
      maxFastFailures: 5,
    });

    expect(code).toBe(1);
    expect(procs.length).toBe(5);
  });

  test("shutdown escalates to SIGKILL when the daemon ignores SIGTERM", async () => {
    process.env["FRAGUA_NO_WEB_BUILD"] = "1";
    scratch = await mkdtemp(join(tmpdir(), "fragua-harness-"));
    const dbPath = join(scratch, "fragua.db");
    const seed = new SqliteStore({ path: dbPath });
    seed.acquireDaemonLock(1234, "test-host");
    seed.close();

    const procs: FakeProc[] = [];
    const spawn = () => {
      const p = makeFakeProc();
      // Ignore SIGTERM (signal 15): only SIGKILL (9) resolves exited.
      const realKill = p.kill.bind(p);
      p.kill = (signal?: number) => {
        p.killed = true;
        p.lastSignal = signal;
        if (signal === 9) realKill(9);
      };
      procs.push(p);
      return p as unknown as ReturnType<typeof Bun.spawn>;
    };

    const done = harnessCommand({
      dbPath,
      port: 0,
      spawn,
      shutdownGraceMs: 50,
    });

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    process.emit("SIGINT");
    const code = await done;
    expect(code).toBe(0);
    expect(procs[0]!.lastSignal).toBe(9);
  });
});
