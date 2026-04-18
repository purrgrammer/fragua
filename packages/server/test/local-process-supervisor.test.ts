// Tests for createLocalProcessSupervisor — the daemon's ProcessSupervisor
// default. Uses a stub worker script that absorbs its argv and exits
// with a configured code, so we exercise Bun.spawn's pid/exited semantics
// without standing up a real workflow.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalProcessSupervisor } from "../src/adapters/local-process-supervisor.ts";
import type { JobRow } from "../src/ports.ts";

const STUB = join(import.meta.dir, "fixtures/stub-worker.ts");

function makeJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: overrides.id ?? "j1",
    runId: overrides.runId ?? "r1",
    workflow: overrides.workflow ?? "w.dot",
    status: overrides.status ?? "queued",
    priority: overrides.priority ?? 0,
    enqueuedAt: overrides.enqueuedAt ?? new Date().toISOString(),
    worktree: overrides.worktree ?? true,
    ...(overrides.inputJson !== undefined ? { inputJson: overrides.inputJson } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
  };
}

describe("createLocalProcessSupervisor", () => {
  let runsDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "swarm-sup-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  test("spawn returns a pid and an exited promise that resolves with exit code", async () => {
    const supervisor = createLocalProcessSupervisor({
      argv0: process.execPath,
      swarmScript: STUB,
      cwd: process.cwd(),
      runsDir,
    });
    // Drive the stub to exit with 0 via env; Bun.spawn inherits process.env.
    process.env["FAKE_EXIT_CODE"] = "0";
    process.env["FAKE_SLEEP_MS"] = "0";
    try {
      const { pid, exited } = await supervisor.spawn(makeJob());
      expect(typeof pid).toBe("number");
      expect(pid).toBeGreaterThan(0);
      const code = await exited;
      expect(code).toBe(0);
    } finally {
      delete process.env["FAKE_EXIT_CODE"];
      delete process.env["FAKE_SLEEP_MS"];
    }
  });

  test("propagates non-zero exit codes", async () => {
    const supervisor = createLocalProcessSupervisor({
      argv0: process.execPath,
      swarmScript: STUB,
      cwd: process.cwd(),
      runsDir,
    });
    process.env["FAKE_EXIT_CODE"] = "7";
    process.env["FAKE_SLEEP_MS"] = "0";
    try {
      const { exited } = await supervisor.spawn(makeJob());
      expect(await exited).toBe(7);
    } finally {
      delete process.env["FAKE_EXIT_CODE"];
      delete process.env["FAKE_SLEEP_MS"];
    }
  });

  test("terminate(pid) SIGTERMs a running child; exited resolves", async () => {
    const supervisor = createLocalProcessSupervisor({
      argv0: process.execPath,
      swarmScript: STUB,
      cwd: process.cwd(),
      runsDir,
    });
    process.env["FAKE_SLEEP_MS"] = "60000"; // won't self-exit in the test window
    process.env["FAKE_EXIT_CODE"] = "0";
    try {
      const { pid, exited } = await supervisor.spawn(makeJob());
      const ok = await supervisor.terminate(pid, "SIGTERM");
      expect(ok).toBe(true);
      const code = await exited;
      // Stub installs a SIGTERM handler that exits 143.
      expect(code).toBe(143);
    } finally {
      delete process.env["FAKE_SLEEP_MS"];
      delete process.env["FAKE_EXIT_CODE"];
    }
  });

  test("terminate returns false for a dead pid", async () => {
    const supervisor = createLocalProcessSupervisor({
      argv0: process.execPath,
      swarmScript: STUB,
      cwd: process.cwd(),
      runsDir,
    });
    // 2^31 - 2, effectively impossible.
    expect(await supervisor.terminate(2147483646)).toBe(false);
  });

  test("terminate refuses non-integer / non-positive pids", async () => {
    const supervisor = createLocalProcessSupervisor({
      argv0: process.execPath,
      swarmScript: STUB,
      cwd: process.cwd(),
      runsDir,
    });
    expect(await supervisor.terminate(0)).toBe(false);
    expect(await supervisor.terminate(-5)).toBe(false);
    expect(await supervisor.terminate(NaN)).toBe(false);
  });
});
