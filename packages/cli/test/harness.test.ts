// Tests for the `fragua harness` supervisor.
//
// Strategy: bind the in-process HTTP server on port 0 and inject a fake `spawn`
// seam so we control the daemon subprocess lifecycle without launching a real
// one. Fake procs model the real daemon's contract with the store: on spawn
// they acquire `daemon_lock` under their own pid (crashing if a stale lock
// blocks them), and a hard crash leaves that row behind — exactly what the
// supervisor must evict before respawning. We drive `superviseDaemon` directly
// with shortened timing knobs and assert its restart + shutdown policy.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore } from "@fragua/store";
import {
  type DaemonProcess,
  type SpawnDaemon,
  type SupervisorConfig,
  superviseDaemon,
} from "../src/commands/harness.ts";
import { startServer } from "../src/commands/serve.ts";

interface FakeProc extends DaemonProcess {
  pid: number;
  exitCode: number | null;
  killed: boolean;
  lastSignal: number | undefined;
  crash(code: number): void;
}

function makeFakeProc(pid: number): FakeProc {
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const proc: FakeProc = {
    pid,
    exited,
    exitCode: null,
    killed: false,
    lastSignal: undefined,
    kill(signal?: number) {
      this.killed = true;
      this.lastSignal = signal;
      this.exitCode = signal === 9 ? 137 : 143;
      resolveExit(this.exitCode);
    },
    crash(code: number) {
      this.exitCode = code;
      resolveExit(code);
    },
  };
  return proc;
}

/** Model the real daemon boot: acquire `daemon_lock` under `pid`. Returns
 *  whether the lock was taken — a fresh stale row makes this fail. */
function acquireLock(dbPath: string, pid: number): boolean {
  const store = new SqliteStore({ path: dbPath, migrate: false });
  try {
    return store.acquireDaemonLock(pid, "test-host").acquired;
  } finally {
    store.close();
  }
}

function currentLockPid(dbPath: string): number | null {
  const store = new SqliteStore({ path: dbPath, migrate: false });
  try {
    return store.currentDaemonLock()?.pid ?? null;
  } finally {
    store.close();
  }
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

  /** Fresh scratch dir + migrated store with no daemon lock: fake procs take
   *  the lock themselves, so the readiness gate reflects a real acquisition. */
  async function freshDbPath(): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), "fragua-harness-"));
    const dbPath = join(scratch, "fragua.db");
    new SqliteStore({ path: dbPath }).close();
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
      lockWaitMs: 5_000,
      ...overrides,
    };
  }

  /** A lock-aware spawn: each child acquires `daemon_lock` under its own pid,
   *  crashing (exit 1) if a stale row blocks it — the real daemon's
   *  `DaemonAlreadyRunningError` path. */
  function lockAwareSpawn(dbPath: string, procs: FakeProc[]): SpawnDaemon {
    let nextPid = 5_000;
    return () => {
      const p = makeFakeProc(nextPid++);
      if (!acquireLock(dbPath, p.pid)) queueMicrotask(() => p.crash(1));
      procs.push(p);
      return p;
    };
  }

  test("restarts the daemon subprocess after an unexpected crash", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn = lockAwareSpawn(dbPath, procs);

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // Simulate a daemon crash — the supervisor must respawn.
    procs[0]!.crash(1);
    expect(await waitFor(() => procs.length >= 2)).toBe(true);
    // The replacement must be the live daemon (never self-crashed on a blocked
    // acquire, never cycled through fast failures) before we signal shutdown.
    expect(await waitFor(() => currentLockPid(dbPath) === procs[1]!.pid)).toBe(true);
    expect(procs[1]!.exitCode).toBeNull();

    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
  });

  test("evicts a stale daemon_lock left by a hard crash and restarts", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn = lockAwareSpawn(dbPath, procs);

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // Hard crash: proc[0] exits WITHOUT releasing the lock — the stale row
    // remains, fresh enough to block a naive re-acquire.
    procs[0]!.crash(1);
    expect(await waitFor(() => procs.length >= 2)).toBe(true);
    // The replacement must actually hold the lock under its own pid — proof the
    // supervisor evicted the stale row before spawning it.
    expect(await waitFor(() => currentLockPid(dbPath) === procs[1]!.pid)).toBe(true);
    // And the replacement stays up (never self-crashed on a blocked acquire).
    expect(procs[1]!.exitCode).toBeNull();

    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
  });

  test("evicts a stale lock before the initial spawn", async () => {
    const dbPath = await freshDbPath();
    // A prior harness/daemon hard-crashed within the TTL: a fresh stale row is
    // left behind under a dead pid. The FIRST child must still acquire cleanly.
    const seed = new SqliteStore({ path: dbPath, migrate: false });
    seed.forceAcquireDaemonLock(999_999, "dead-host");
    seed.close();

    const procs: FakeProc[] = [];
    const spawn = lockAwareSpawn(dbPath, procs);

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // The initial child holds the lock under its own pid — proof the stale row
    // was evicted before the initial spawn, not only on restart.
    expect(await waitFor(() => currentLockPid(dbPath) === procs[0]!.pid)).toBe(true);
    expect(procs[0]!.exitCode).toBeNull();

    await emitSigintWhenReady(sigintBefore);
    expect(await done).toBe(0);
  });

  test("runs the startup sweep during the initial eviction, requeuing an orphan", async () => {
    const dbPath = await freshDbPath();

    // A run was in-flight ("running") when the prior daemon hard-crashed,
    // leaving a stale lock. Eviction must run the sweep (crediting the stale
    // lock's heartbeat as priorHeartbeatAt) — not merely clear the lock — so
    // the orphan is requeued rather than left stuck "running" forever.
    const wf = "name: t\nsteps:\n  work: {type: llm, prompt: x}\n";
    const seed = new SqliteStore({ path: dbPath, migrate: false });
    seed.saveWorkflow("wf", "t", wf, serializeGraph(parseWorkflow(wf)), CURRENT_IR_VERSION);
    seed.enqueueRun({ runId: "orphan-run", workflowSha: "wf" });
    seed.claimNextRun(1); // status → running
    seed.forceAcquireDaemonLock(999_999, "dead-host");
    seed.close();

    const procs: FakeProc[] = [];
    const spawn = lockAwareSpawn(dbPath, procs);

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);

    const check = new SqliteStore({ path: dbPath, migrate: false });
    const state = check.getState("orphan-run");
    check.close();
    // The eviction's startupSweep requeued the orphan — the old
    // force-acquire+release compound never ran a sweep at all.
    expect(state?.status).toBe("queued");

    await emitSigintWhenReady(sigintBefore);
    expect(await done).toBe(0);
  });

  test("SIGKILL escalation tolerates ESRCH without an unhandled rejection", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      acquireLock(dbPath, p.pid);
      // Ignore SIGTERM; then raise ESRCH on the SIGKILL escalation, modelling
      // the child exiting between the grace timeout and the kill(9).
      p.kill = (signal?: number) => {
        p.lastSignal = signal;
        if (signal === 9) {
          p.crash(137);
          throw new Error("kill ESRCH");
        }
      };
      procs.push(p);
      return p;
    };

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath, { shutdownGraceMs: 50 });
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    await emitSigintWhenReady(sigintBefore);
    // The ESRCH from kill(9) must be swallowed: shutdown still completes and
    // the harness resolves 0 rather than defeating the bounded shutdown.
    expect(await done).toBe(0);
    expect(procs[0]!.lastSignal).toBe(9);
  });

  test("fails fast when the daemon never acquires within lockWaitMs", async () => {
    const dbPath = await freshDbPath();
    // Hold the lock under a live-looking pid so no child can ever acquire it.
    const seed = new SqliteStore({ path: dbPath, migrate: false });

    const procs: FakeProc[] = [];
    // A spawn that never acquires (its acquire always loses to the held lock).
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      procs.push(p);
      return p;
    };

    // Re-assert the blocking lock after the initial eviction so gateReady can
    // never see the child's pid, forcing the lockWaitMs deadline.
    const cfg = await makeConfig(dbPath, { lockWaitMs: 120 });
    seed.forceAcquireDaemonLock(4242, "other-host");
    // The initial eviction clears it; re-hold it on a microtask so the child's
    // pid never appears under the lock.
    const reHold = setInterval(() => seed.forceAcquireDaemonLock(4242, "other-host"), 10);

    const startedAt = Date.now();
    const code = await superviseDaemon(spawn, ["dummy"], cfg);
    clearInterval(reHold);
    seed.close();

    expect(code).toBe(1);
    // Bounded by lockWaitMs, not the module-level default (5s).
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("gives up after N consecutive fast crashes and exits non-zero", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      acquireLock(dbPath, p.pid);
      procs.push(p);
      // Crash immediately on every spawn (fast failure), leaving a stale lock
      // the supervisor must evict before the next attempt.
      queueMicrotask(() => p.crash(1));
      return p;
    };

    const cfg = await makeConfig(dbPath, { restartInitialBackoffMs: 5, maxFastFailures: 5 });
    const code = await superviseDaemon(spawn, ["dummy"], cfg);

    expect(code).toBe(1);
    expect(procs.length).toBe(5);
  });

  test("resets the failure budget after a daemon survives past healthyResetMs", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      acquireLock(dbPath, p.pid);
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
    const startedAt = Date.now();
    // Let proc[1] live past healthyResetMs, then crash it: the budget resets,
    // so the supervisor restarts rather than gives up. Wait on wall-clock
    // rather than a fixed sleep so scheduler jitter can't skip the reset path.
    expect(await waitFor(() => Date.now() - startedAt >= cfg.healthyResetMs + 20)).toBe(true);
    procs[1]!.crash(1);
    expect(await waitFor(() => procs.length >= 3)).toBe(true);

    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
  });

  test("shutdown escalates to SIGKILL when the daemon ignores SIGTERM", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      acquireLock(dbPath, p.pid);
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

  test("shutdown tolerates ESRCH when the daemon dies between the gate and the signal", async () => {
    const dbPath = await freshDbPath();

    const procs: FakeProc[] = [];
    const spawn: SpawnDaemon = () => {
      const p = makeFakeProc(5_000 + procs.length);
      acquireLock(dbPath, p.pid);
      // Stay alive (exitCode === null) through the liveness gate, then model
      // the TOCTOU: the process dies just as the signal is sent, so `kill`
      // raises ESRCH. The ESRCH branch must be swallowed and the server closed.
      p.kill = (signal?: number) => {
        p.killed = true;
        p.lastSignal = signal;
        p.crash(1);
        throw new Error("kill ESRCH");
      };
      procs.push(p);
      return p;
    };

    const sigintBefore = process.listenerCount("SIGINT");
    const cfg = await makeConfig(dbPath);
    const done = superviseDaemon(spawn, ["dummy"], cfg);

    expect(await waitFor(() => procs.length >= 1)).toBe(true);
    // The daemon is still alive (exitCode null) when shutdown runs, so the
    // kill branch — and its ESRCH throw — is exercised.
    await emitSigintWhenReady(sigintBefore);
    const code = await done;
    expect(code).toBe(0);
    // The SIGTERM branch fired (kill invoked, raising ESRCH) before the server
    // was closed — `killed` proves the branch ran, unlike the vacuous
    // `killed === false` it replaces.
    expect(procs[0]!.killed).toBe(true);
    expect(procs[0]!.exitCode).toBe(1);

    const check = new SqliteStore({ path: dbPath, migrate: false });
    const endpoint = check.currentServerEndpoint();
    check.close();
    expect(endpoint).toBeNull();
  });
});
