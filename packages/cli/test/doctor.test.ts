// `fragua doctor` — last-exit rendering. When no live daemon holds the
// lock, doctor reads the newest daemon lifecycle record and prints a
// "last exit:" line (reason, time, and for leak_limit the leaked nodes).

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@fragua/store";
import { doctorCommand, formatLastExit } from "../src/commands/doctor.ts";

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

async function captureDoctor(dbPath: string): Promise<string[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(stripAnsi(args.map(String).join(" ")));
  });
  try {
    const code = await doctorCommand({ dbPath });
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
