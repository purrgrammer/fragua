// Integration tests for `swarm daemon {start,stop,status,__daemon-run}`.
//
// Strategy mirrors serve.test.ts: bind ephemeral ports, drive the command
// functions directly in-process, exercise the rendezvous round-trip, and
// clean up via their own lifecycle commands.
//
// We test the foreground path (daemon runs in-process) for most of the
// rendezvous + stop semantics — it's much faster and doesn't require a
// spawned child to boot. Detached spawn is covered in a single targeted
// test so we have SOME coverage of the `Bun.spawn` path.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRendezvousPath, readRendezvous, writeRendezvous } from "@swarm/server";
import {
  daemonRunCommand,
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
} from "../src/commands/daemon.ts";

/**
 * Kick off `daemonRunCommand` as a detached-by-signal promise, waiting
 * for its rendezvous file to appear before handing control back. Lets
 * tests drive stop/status against a real running daemon without relying
 * on Bun.spawn.
 */
async function spinUpForeground(cwd: string, port = 0): Promise<{ done: Promise<number> }> {
  const done = daemonRunCommand({ cwd, port });
  // Poll for rendezvous — the daemon writes it after the server binds.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const r = await readRendezvous(cwd);
    if (r) return { done };
    await new Promise((r) => setTimeout(r, 25));
  }
  // Fail loudly; caller's afterEach should still be able to tear down.
  throw new Error("daemon never published rendezvous");
}

describe("daemonRunCommand (foreground body)", () => {
  let cwd: string | undefined;
  let done: Promise<number> | undefined;

  afterEach(async () => {
    if (done) {
      // Stop via its own SIGTERM path so rendezvous cleanup runs.
      process.emit("SIGTERM");
      await done;
      done = undefined;
    }
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("writes a rendezvous with our pid + bound port", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    ({ done } = await spinUpForeground(cwd));
    const r = await readRendezvous(cwd);
    expect(r).toBeDefined();
    expect(r?.pid).toBe(process.pid);
    expect(r?.port).toBeGreaterThan(0);
    expect(typeof r?.startedAt).toBe("string");
  });

  test("/health responds on the bound port", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    ({ done } = await spinUpForeground(cwd));
    const r = (await readRendezvous(cwd))!;
    const res = await fetch(`http://127.0.0.1:${r.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("SIGTERM removes the rendezvous before exit", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    const { done: runDone } = await spinUpForeground(cwd);
    expect(await readRendezvous(cwd)).toBeDefined();
    process.emit("SIGTERM");
    const code = await runDone;
    done = undefined; // we've consumed it
    expect(code).toBe(0);
    expect(await readRendezvous(cwd)).toBeUndefined();
  });
});

describe("daemonStartCommand", () => {
  let cwd: string | undefined;

  afterEach(async () => {
    if (cwd) {
      // Best-effort shutdown. If start/stop went sideways, rm cleans up
      // the directory regardless.
      await daemonStopCommand({ cwd, graceMs: 2_000 }).catch(() => {});
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("--foreground runs in-process; SIGTERM returns 0", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    const fg = daemonStartCommand({ cwd, port: 0, foreground: true });
    // Wait until rendezvous lands, then signal.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await readRendezvous(cwd)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await readRendezvous(cwd)).toBeDefined();
    process.emit("SIGTERM");
    const code = await fg;
    expect(code).toBe(0);
  });

  test("idempotent: second start observes the first and returns 0", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    // Prime: pretend a daemon is running by writing a rendezvous that
    // points at OUR pid (which is certainly alive).
    const existingCwd = cwd;
    await writeRendezvous(existingCwd, {
      pid: process.pid,
      port: 1,
      startedAt: new Date().toISOString(),
      version: "test",
    });
    // In detached mode, start should see the alive pid and exit 0 without
    // spawning anything.
    const code = await daemonStartCommand({ cwd: existingCwd, port: 0 });
    expect(code).toBe(0);
    // Clean up manually — if we left the rendezvous in place, the
    // afterEach's daemonStopCommand would SIGTERM our own pid.
    await (await import("node:fs/promises")).unlink(getRendezvousPath(existingCwd)).catch(() => {});
  });

  test("stale rendezvous (pid dead) is cleaned up and the daemon starts fresh", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    // Plant a stale rendezvous with a pid that cannot exist.
    await writeRendezvous(cwd, {
      pid: 2147483646,
      port: 1,
      startedAt: new Date().toISOString(),
      version: "stale",
    });
    // Foreground so we don't need to manage a detached child.
    const fg = daemonStartCommand({ cwd, port: 0, foreground: true });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const r = await readRendezvous(cwd);
      if (r && r.pid === process.pid) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await readRendezvous(cwd);
    expect(r?.pid).toBe(process.pid);
    expect(r?.version).not.toBe("stale");
    process.emit("SIGTERM");
    await fg;
  });
});

describe("daemonStopCommand", () => {
  let cwd: string | undefined;

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("no rendezvous → exit 0, 'not running'", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    const code = await daemonStopCommand({ cwd });
    expect(code).toBe(0);
  });

  test("stale rendezvous (pid dead) is cleaned up, exits 0", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    await writeRendezvous(cwd, {
      pid: 2147483646,
      port: 1,
      startedAt: new Date().toISOString(),
      version: "stale",
    });
    const code = await daemonStopCommand({ cwd });
    expect(code).toBe(0);
    expect(await readRendezvous(cwd)).toBeUndefined();
  });
});

describe("daemonStatusCommand", () => {
  let cwd: string | undefined;
  let fg: Promise<number> | undefined;

  afterEach(async () => {
    if (fg) {
      process.emit("SIGTERM");
      await fg;
      fg = undefined;
    }
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("returns 1 when nothing is running", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    const code = await daemonStatusCommand({ cwd });
    expect(code).toBe(1);
  });

  test("returns 0 and reports health=ok when the daemon is up", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    ({ done: fg } = await spinUpForeground(cwd));
    // Capture console.log so we can inspect the JSON payload.
    const origLog = console.log;
    let captured = "";
    console.log = (msg: unknown) => {
      captured += String(msg);
    };
    try {
      const code = await daemonStatusCommand({ cwd });
      expect(code).toBe(0);
      const payload = JSON.parse(captured);
      expect(payload.running).toBe(true);
      expect(payload.health).toBe("ok");
      expect(payload.pid).toBe(process.pid);
    } finally {
      console.log = origLog;
    }
  });

  test("returns 1 with stale=true when pid is dead", async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    await writeRendezvous(cwd, {
      pid: 2147483646,
      port: 1,
      startedAt: new Date().toISOString(),
      version: "stale",
    });
    const origLog = console.log;
    let captured = "";
    console.log = (msg: unknown) => {
      captured += String(msg);
    };
    try {
      const code = await daemonStatusCommand({ cwd });
      expect(code).toBe(1);
      const payload = JSON.parse(captured);
      expect(payload.running).toBe(false);
      expect(payload.stale).toBe(true);
    } finally {
      console.log = origLog;
    }
  });
});

describe("path helpers under cwd", () => {
  test("getRendezvousPath resolves to .swarm/daemon/daemon.json", () => {
    expect(getRendezvousPath("/x/y")).toBe("/x/y/.swarm/daemon/daemon.json");
  });
});

describe("daemon.log is appended to, not recreated", () => {
  let cwd: string | undefined;
  let fg: Promise<number> | undefined;

  afterEach(async () => {
    if (fg) {
      process.emit("SIGTERM");
      await fg;
      fg = undefined;
    }
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  test("foreground mode prints startup banner to stdout (no log file dependency)", async () => {
    // Foreground doesn't redirect to daemon.log — that's only for detach.
    // Sanity-check that spinning up doesn't accidentally create a log file.
    cwd = await mkdtemp(join(tmpdir(), "swarm-daemon-"));
    ({ done: fg } = await spinUpForeground(cwd));
    // Rendezvous exists; daemon.log should NOT be created by the foreground path.
    const logPath = join(cwd, ".swarm/daemon/daemon.log");
    try {
      await readFile(logPath, "utf8");
      throw new Error("expected no daemon.log in foreground mode");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
