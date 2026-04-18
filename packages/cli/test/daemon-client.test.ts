// Tests for `ensureDaemonRunning`. Covers the three outcomes:
//   1. Daemon already up (fast-path probe) → baseUrl.
//   2. Daemon down + autostart: false → `not_running`.
//   3. Stale rendezvous (pid dead) + autostart: false → `not_running`.
//
// The autostart path (ensuring we spawn `daemonStartCommand`) is exercised
// indirectly via the foreground-daemon integration test in daemon.test.ts —
// here we focus on probe semantics to keep tests fast.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRendezvous, writeRendezvous } from "@swarm/server";
import { daemonRunCommand } from "../src/commands/daemon.ts";
import { ensureDaemonRunning } from "../src/lib/daemon-client.ts";

describe("ensureDaemonRunning", () => {
  let cwd: string | undefined;
  let done: Promise<number> | undefined;

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

  test("no rendezvous + autostart=false → not_running", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-client-"));
    const result = await ensureDaemonRunning({ cwd, autostart: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("not_running");
  });

  test("stale rendezvous (pid dead) + autostart=false → not_running", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-client-"));
    await writeRendezvous(cwd, {
      pid: 2147483646,
      port: 1,
      startedAt: new Date().toISOString(),
      version: "stale",
    });
    const result = await ensureDaemonRunning({ cwd, autostart: false });
    expect(result.ok).toBe(false);
  });

  test("live daemon → probe succeeds and returns the baseUrl", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-client-"));
    // Bring up a real foreground daemon.
    done = daemonRunCommand({ cwd, port: 0 });
    // Wait for rendezvous to appear.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await readRendezvous(cwd)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await readRendezvous(cwd);
    expect(r).toBeDefined();

    const result = await ensureDaemonRunning({ cwd, autostart: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.port).toBe(r!.port);
      expect(result.baseUrl).toBe(`http://127.0.0.1:${r!.port}`);
    }
  });
});
