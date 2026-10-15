// `fragua doctor` — last-exit rendering and process+row liveness. When no
// live daemon holds the lock, doctor reads the newest daemon lifecycle record
// and prints a "last exit:" line (reason, time, and for leak_limit the leaked
// nodes). Liveness cases seed rows and inject the pid probe + hostname.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { type DoctorOptions, doctorCommand, formatLastExit } from "../src/commands/doctor.ts";
import type { PidState } from "../src/pid-probe.ts";

const workdirs: string[] = [];

afterEach(() => {
  while (workdirs.length > 0) {
    const d = workdirs.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function makeStore(now?: () => number): { dbPath: string; store: SqliteStore } {
  const cwd = mkdtempSync(join(tmpdir(), "fragua-doctor-"));
  workdirs.push(cwd);
  mkdirSync(join(cwd, ".fragua"), { recursive: true });
  const dbPath = join(cwd, ".fragua/fragua.db");
  const store = now !== undefined ? new SqliteStore({ path: dbPath, now }) : new SqliteStore({ path: dbPath });
  return { dbPath, store };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(ANSI_PATTERN, "");

async function captureDoctor(dbPath: string, opts: Omit<DoctorOptions, "dbPath"> = {}): Promise<string[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(stripAnsi(args.map(String).join(" ")));
  });
  try {
    const code = await doctorCommand({ dbPath, ...opts });
    expect(code).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe("fragua doctor — last exit", () => {
  test("prints last exit with reason, time, and leaked nodes for a recorded leak_limit shutdown", async () => {
    const ts = 1_700_000_000_000;
    const { dbPath, store } = makeStore(() => ts);
    store.appendDaemonEvent({ type: "daemon.started", payload: { pid: 99, hostname: "h" } });
    store.appendDaemonEvent({
      type: "daemon.stopped",
      payload: {
        pid: 99,
        reason: "leak_limit",
        detail: "1 handler leaks",
        leaked: [{ runId: "r1", nodeId: "hang" }],
      },
    });
    store.close();

    const lines = await captureDoctor(dbPath);
    const exitLine = lines.find((l) => l.includes("last exit:"));
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain("leak_limit");
    expect(exitLine).toContain(new Date(ts).toISOString());
    expect(exitLine).toContain("leaked: r1/hang");
  });

  test("reports a probable crash when the newest lifecycle record is daemon.started", async () => {
    const { dbPath, store } = makeStore();
    store.appendDaemonEvent({ type: "daemon.started", payload: { pid: 42, hostname: "h" } });
    store.close();

    const lines = await captureDoctor(dbPath);
    const exitLine = lines.find((l) => l.includes("last exit:"));
    expect(exitLine).toBeDefined();
    expect(exitLine).toContain("no shutdown record");
    expect(exitLine).toContain("likely crash");
  });

  test("formatLastExit renders the empty and orderly-shutdown cases", () => {
    expect(stripAnsi(formatLastExit(null))).toBe("last exit: none recorded");
    const line = stripAnsi(
      formatLastExit({
        seq: 1,
        type: "daemon.stopped",
        payload: { pid: 7, reason: "signal" },
        ts: 1_700_000_000_000,
        runId: null,
      }),
    );
    expect(line).toContain("last exit: signal at 2023-11-14T22:13:20.000Z (pid 7)");
  });
});

describe("fragua doctor — liveness from process + row", () => {
  const T = 1_700_000_000_000;
  const HOST = "this-host";

  function probeFrom(states: Record<number, PidState>): (pid: number) => PidState {
    return (pid) => states[pid] ?? "dead";
  }

  function seedLock(pid: number, host = HOST, harnessPid?: number): string {
    const { dbPath, store } = makeStore(() => T);
    store.forceAcquireDaemonLock(pid, host);
    if (harnessPid !== undefined) store.heartbeatDaemonLock(pid, { harnessPid });
    store.close();
    return dbPath;
  }

  const lineOf = (lines: string[], label: string): string => lines.find((l) => l.includes(`${label}:`)) ?? "";

  test("daemon alive + fresh heartbeat renders alive", async () => {
    const dbPath = seedLock(4242, HOST, 4000);
    const lines = await captureDoctor(dbPath, {
      now: () => T + 2_000,
      hostname: HOST,
      probePid: probeFrom({ 4242: "alive" }),
    });
    const daemon = lineOf(lines, "daemon");
    expect(daemon).toContain("alive (2s)");
    expect(daemon).toContain("harness pid 4000");
    expect(daemon).not.toContain("stale");
    expect(lines.some((l) => l.includes("last exit:"))).toBe(false);
  });

  test("daemon alive + stale heartbeat renders host-slept hint", async () => {
    const dbPath = seedLock(4242);
    const lines = await captureDoctor(dbPath, {
      now: () => T + 120_000,
      hostname: HOST,
      probePid: probeFrom({ 4242: "alive" }),
    });
    expect(lineOf(lines, "daemon")).toContain("alive, heartbeat stale 120s (host slept? the harness will respawn it)");
  });

  test("dead pid with a lock row renders a stale lock", async () => {
    const dbPath = seedLock(4242);
    const lines = await captureDoctor(dbPath, { now: () => T + 2_000, hostname: HOST, probePid: probeFrom({}) });
    expect(lineOf(lines, "daemon")).toContain("dead (pid 4242 gone; stale lock, next harness start evicts it)");
    expect(lines.some((l) => l.includes("last exit:"))).toBe(true);
  });

  test("no lock row but a live daemon.started pid renders running without a lock", async () => {
    const { dbPath, store } = makeStore(() => T);
    store.appendDaemonEvent({ type: "daemon.started", payload: { pid: 45626, hostname: HOST } });
    store.close();
    const lines = await captureDoctor(dbPath, {
      now: () => T + 2_000,
      hostname: HOST,
      probePid: probeFrom({ 45626: "alive" }),
    });
    expect(lineOf(lines, "daemon")).toContain("running without a lock: pid 45626");
  });

  test("no lock row and no live pid renders no daemon", async () => {
    const { dbPath, store } = makeStore(() => T);
    store.appendDaemonEvent({ type: "daemon.started", payload: { pid: 45626, hostname: HOST } });
    store.close();
    const lines = await captureDoctor(dbPath, { now: () => T + 2_000, hostname: HOST, probePid: probeFrom({}) });
    const idx = lines.findIndex((l) => l.includes("daemon:"));
    expect(lines[idx]).toContain("no daemon");
    expect(lines[idx + 1]).toContain("last exit:");
  });

  test("foreign-host lock defers to the row and never probes", async () => {
    const dbPath = seedLock(4242, "other-host");
    const probed: number[] = [];
    const lines = await captureDoctor(dbPath, {
      now: () => T + 2_000,
      hostname: HOST,
      probePid: (pid) => {
        probed.push(pid);
        return "dead";
      },
    });
    expect(probed).toEqual([]);
    const daemon = lineOf(lines, "daemon");
    expect(daemon).toContain("alive (2s)");
    expect(daemon).toContain("pid not probed: other host");
  });

  test("server endpoint with live pid renders alive", async () => {
    const { dbPath, store } = makeStore(() => T);
    store.setServerEndpoint({ url: "http://127.0.0.1:6767/api", port: 6767, pid: 7, version: null, hostname: HOST });
    store.close();
    const lines = await captureDoctor(dbPath, { now: () => T, hostname: HOST, probePid: probeFrom({ 7: "alive" }) });
    const server = lineOf(lines, "server");
    expect(server).toContain("http://127.0.0.1:6767/api");
    expect(server).toContain("alive");
  });

  test("server endpoint with dead pid renders a stale endpoint", async () => {
    const { dbPath, store } = makeStore(() => T);
    store.setServerEndpoint({ url: "http://127.0.0.1:6767/api", port: 6767, pid: 7, version: null, hostname: HOST });
    store.close();
    const lines = await captureDoctor(dbPath, { now: () => T, hostname: HOST, probePid: probeFrom({}) });
    expect(lineOf(lines, "server")).toContain("dead (pid 7 gone; stale endpoint)");
  });

  test("no endpoint row but a live supervising harness renders running without an endpoint row", async () => {
    const dbPath = seedLock(4242, HOST, 4000);
    const lines = await captureDoctor(dbPath, {
      now: () => T + 2_000,
      hostname: HOST,
      probePid: probeFrom({ 4242: "alive", 4000: "alive" }),
    });
    expect(lineOf(lines, "server")).toContain("running without an endpoint row: harness pid 4000");
  });

  test("doctor is read-only", async () => {
    const { dbPath, store } = makeStore(() => T);
    store.forceAcquireDaemonLock(4242, HOST);
    store.setServerEndpoint({ url: "http://127.0.0.1:6767/api", port: 6767, pid: 7, version: null, hostname: HOST });
    const lockBefore = store.currentDaemonLock();
    const endpointBefore = store.currentServerEndpoint();
    store.close();

    await captureDoctor(dbPath, { now: () => T + 120_000, hostname: HOST, probePid: probeFrom({}) });

    const check = new SqliteStore({ path: dbPath, migrate: false });
    try {
      expect(check.currentDaemonLock()).toEqual(lockBefore);
      expect(check.currentServerEndpoint()).toEqual(endpointBefore);
    } finally {
      check.close();
    }
  });
});
