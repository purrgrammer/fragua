// Unit tests for the daemon rendezvous module.
//
// Focus: the file-shape contract (atomic write, schema validation,
// ENOENT as "no daemon", removeRendezvous idempotency) and the pid
// liveness helper. The lifecycle — who writes, when to unlink — is
// the CLI's problem and tested separately.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDaemonDir,
  getRendezvousPath,
  isPidAlive,
  readRendezvous,
  removeRendezvous,
  writeRendezvous,
} from "../src/rendezvous.ts";

describe("rendezvous", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "swarm-rendezvous-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("path helpers point under .swarm/daemon/", () => {
    expect(getDaemonDir(cwd)).toBe(join(cwd, ".swarm/daemon"));
    expect(getRendezvousPath(cwd)).toBe(join(cwd, ".swarm/daemon/daemon.json"));
  });

  test("write then read round-trips the payload", async () => {
    const payload = {
      pid: 12345,
      port: 3737,
      startedAt: "2026-04-18T10:00:00.000Z",
      version: "0.0.0",
    };
    await writeRendezvous(cwd, payload);
    const got = await readRendezvous(cwd);
    expect(got).toEqual(payload);
  });

  test("read returns undefined when the file is absent", async () => {
    expect(await readRendezvous(cwd)).toBeUndefined();
  });

  test("read returns undefined when the file is malformed JSON", async () => {
    const path = getRendezvousPath(cwd);
    await writeRendezvous(cwd, { pid: 1, port: 1, startedAt: "t", version: "v" });
    await writeFile(path, "{ not valid json", "utf8");
    expect(await readRendezvous(cwd)).toBeUndefined();
  });

  test("read returns undefined when the file has the wrong shape", async () => {
    const path = getRendezvousPath(cwd);
    await writeRendezvous(cwd, { pid: 1, port: 1, startedAt: "t", version: "v" });
    await writeFile(path, JSON.stringify({ pid: "not-a-number" }), "utf8");
    expect(await readRendezvous(cwd)).toBeUndefined();
  });

  test("write is atomic — a mid-write crash leaves nothing behind, not a half-file", async () => {
    // Simulate atomicity by inspecting that the tmp file does NOT survive a
    // completed write. (We can't kill a real write mid-call here, but we
    // can assert the directory is clean afterwards.)
    await writeRendezvous(cwd, { pid: 1, port: 1, startedAt: "t", version: "v" });
    const entries = await readdir(getDaemonDir(cwd));
    expect(entries.filter((e) => e.includes(".tmp"))).toHaveLength(0);
    expect(entries).toContain("daemon.json");
  });

  test("write creates .swarm/daemon/ if it doesn't exist", async () => {
    // No prior call to create the directory — writeRendezvous must do it.
    await writeRendezvous(cwd, { pid: 7, port: 8, startedAt: "s", version: "v" });
    const r = await readRendezvous(cwd);
    expect(r?.pid).toBe(7);
  });

  test("remove deletes the rendezvous and is idempotent on ENOENT", async () => {
    await writeRendezvous(cwd, { pid: 1, port: 1, startedAt: "t", version: "v" });
    await removeRendezvous(cwd);
    expect(await readRendezvous(cwd)).toBeUndefined();
    // Second call must not throw.
    await removeRendezvous(cwd);
  });

  test("overwriting the rendezvous atomically replaces the previous one", async () => {
    await writeRendezvous(cwd, { pid: 1, port: 1, startedAt: "first", version: "v" });
    await writeRendezvous(cwd, { pid: 2, port: 2, startedAt: "second", version: "v" });
    const r = await readRendezvous(cwd);
    expect(r?.pid).toBe(2);
    expect(r?.startedAt).toBe("second");
    // And the raw file is a single valid JSON object.
    const raw = await readFile(getRendezvousPath(cwd), "utf8");
    expect(JSON.parse(raw).pid).toBe(2);
  });
});

describe("isPidAlive", () => {
  test("returns true for our own pid", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("returns false for an impossible pid", () => {
    // 2^31 - 1 is the max pid on 64-bit Linux; safely above any real process.
    expect(isPidAlive(2147483646)).toBe(false);
  });

  test("returns false for 0, negative numbers, and non-integers", () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});
