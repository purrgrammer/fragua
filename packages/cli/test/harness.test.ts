// Tests for the `fragua harness` supervisor.
//
// Strategy: bind the in-process HTTP server on port 0, pre-seed the daemon
// lock so the readiness gate resolves immediately, and inject a fake `spawn`
// seam so we control the daemon subprocess lifecycle without launching a real
// one. We drive `superviseDaemon` directly with shortened timing knobs and
// assert its restart + shutdown policy.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import {
  type DaemonProcess,
  type SpawnDaemon,
  type SupervisorConfig,
  superviseDaemon,
} from "../src/commands/harness.ts";
import { startServer } from "../src/commands/serve.ts";

interface FakeProc extends DaemonProcess {
  killed: boolean;
  lastSignal: number | undefined;
  crash(code: number): void;
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

/** Emit `SIGINT` only once the supervisor has registered its handler — the
 *  readiness gate is async, so a bare emit can race ahead of it. */
async function emitSigintWhenReady(before: number): Promise<void> {
  await waitFor(() => process.listenerCount("SIGINT") > before);
  process.emit("SIGINT");
}

describe("superviseDaemon", () => {
  let scratch: string | undefined;

  afterEach(async () => {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  /** Fresh scratch dir + store with a pre-seeded daemon lock so the readiness
   *  gate resolves without a real daemon. */
  async function seededDbPath(): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), "fragua-harness-"));
    const dbPath = join(scratch, "fragua.db");
    const seed = new SqliteStore({ path: dbPath });
    seed.acquireDaemonLock(1234, "test-host");
    seed.close();
    return dbPath;
  }

  async function makeConfig(dbPath: string, overrides: Partial<SupervisorConfig> = {}): Promise<SupervisorConfig> {
    const serverHandle = await startServer({ dbPath, port: 0, version: "test" });
    return {
      dbPath,
      serverHandle,
      restartInitialBackoffMs: 10,
      restartMaxBackoffMs: 1_000,
      healthyResetMs: 60_000,
      maxFastFailures: 5,
      shutdownGraceMs: 5_000,
      ...overrides,
    };
  }

  test("restarts the daemon subprocess after an unexpected crash", async () => {
    const dbPath = await seededDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc();
      procs.push(p);
      return p;
    };

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // Simulate a daemon crash — the supervisor must respawn.
    procs[0]!.crash(1);
    expect(await waitFor(() => procs.length >= 2)).toBe(true);

    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
  });

  test("gives up after N consecutive fast crashes and exits non-zero", async () => {
    const dbPath = await seededDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc();
      procs.push(p);
      // Crash immediately on every spawn (fast failure).
      queueMicrotask(() => p.crash(1));
      return p;
    };

    const cfg = await makeConfig(dbPath, { restartInitialBackoffMs: 5, maxFastFailures: 5 });
    const code = await superviseDaemon(spawn, ["dummy"], cfg);

    expect(code).toBe(1);
    expect(procs.length).toBe(5);
  });

  test("resets the failure budget after a daemon survives past healthyResetMs", async () => {
    const dbPath = await seededDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc();
      procs.push(p);
      // Only the first daemon crashes on its own; the replacement stays up
      // past healthyResetMs before the test crashes it by hand.
      if (procs.length === 1) queueMicrotask(() => p.crash(1));
      return p;
    };

    // maxFastFailures=2: the first crash spends one of two allowances. Without
    // a healthy-uptime reset the second crash would trip "giving up"; with the
    // reset it restarts, so a third proc must appear.
    const cfg = await makeConfig(dbPath, {
      restartInitialBackoffMs: 5,
      healthyResetMs: 30,
      maxFastFailures: 2,
    });
    const sigintBefore = process.listenerCount("SIGINT");
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    // First crash → restart → proc[1] comes up healthy.
    expect(await waitFor(() => procs.length >= 2)).toBe(true);
    // Let proc[1] live past healthyResetMs, then crash it: the budget resets,
    // so the supervisor restarts rather than gives up.
    await new Promise((r) => setTimeout(r, 45));
    procs[1]!.crash(1);
    expect(await waitFor(() => procs.length >= 3)).toBe(true);

    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
  });

  test("shutdown escalates to SIGKILL when the daemon ignores SIGTERM", async () => {
    const dbPath = await seededDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc();
      // Ignore SIGTERM (signal 15): only SIGKILL (9) resolves exited.
      const realKill = p.kill.bind(p);
      p.kill = (signal?: number) => {
        p.killed = true;
        p.lastSignal = signal;
        if (signal === 9) realKill(9);
      };
      procs.push(p);
      return p;
    };

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath, { shutdownGraceMs: 50 });
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
    expect(procs[0]!.lastSignal).toBe(9);
  });

  test("shutdown after a natural crash still clears server_endpoint", async () => {
    const dbPath = await seededDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc();
      let dead = false;
      p.exited.then(() => {
        dead = true;
      });
      // Real subprocesses throw ESRCH when killed after exit.
      p.kill = (signal?: number) => {
        if (dead) throw new Error("kill ESRCH");
        p.killed = true;
        p.lastSignal = signal;
      };
      procs.push(p);
      return p;
    };

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath, { restartInitialBackoffMs: 1_000 });
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // Natural crash (no kill()) leaves the proc exited; SIGINT lands in the
    // backoff window before the restart fires.
    procs[0]!.crash(1);
    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);

    const check = new SqliteStore({ path: dbPath, migrate: false });
    const endpoint = check.currentServerEndpoint();
    check.close();
    expect(endpoint).toBeNull();
  });
});
