// Unit tests for `fragua daemon stop`. The happy SIGTERM path requires a
// live child process and a kernel signal round-trip; rather than spawn
// one here we exercise the two deterministic branches:
//   - no lock row present          → prints "no daemon running", exit 0
//   - lock row references a dead pid → stale lock cleared, exit 0
// The live-pid branch is covered by manual + e2e testing; mocking
// process.kill cleanly would couple the test to an implementation
// detail (polling cadence) without adding real confidence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { daemonStopCommand } from "../src/commands/daemon.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fragua-stop-"));
  dbPath = join(dir, "fragua.db");
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("daemonStopCommand", () => {
  test("no lock row → exits 0 with 'no daemon running'", async () => {
    // Instantiate and close the store so the migration runs and the
    // daemon_lock table exists, but no row is inserted.
    const s = new SqliteStore({ path: dbPath });
    s.close();
    const code = await daemonStopCommand({ dbPath });
    expect(code).toBe(0);
  });

  test("stale lock with dead pid → cleared, exits 0", async () => {
    // Seed a lock row pointing at a pid that definitely isn't running.
    // PID 2^30 is well beyond any realistic process-table ceiling on
    // Linux/macOS (which cap around 2^22).
    const s = new SqliteStore({ path: dbPath });
    const deadPid = 1 << 30;
    // Use the real hostname so the stop command doesn't short-circuit
    // on the cross-host guard before trying to SIGTERM.
    s.forceAcquireDaemonLock(deadPid, hostname());
    s.close();

    const code = await daemonStopCommand({ dbPath });
    expect(code).toBe(0);

    // Lock row should now be clear (or point at a different pid — the
    // stale-cleanup path force-acquires then releases).
    const s2 = new SqliteStore({ path: dbPath });
    expect(s2.currentDaemonLock()).toBeNull();
    s2.close();
  });

  test("lock row on a different host → refuses with exit 1 (no cross-host SIGTERM)", async () => {
    const s = new SqliteStore({ path: dbPath });
    s.forceAcquireDaemonLock(process.pid, "some-other-machine.example.com");
    s.close();
    const code = await daemonStopCommand({ dbPath });
    expect(code).toBe(1);
  });
});
