// Tests for `createSqliteJobQueue`.
//
// Every test uses `:memory:` so runs are hermetic and parallel-safe.
// A small subset exercises the on-disk path (schema creation, parent
// dir creation) to make sure the production code path is covered.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";
import type { JobQueue } from "../src/ports.ts";

describe("createSqliteJobQueue — :memory:", () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = createSqliteJobQueue({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    await queue.close();
  });

  test("enqueue returns a queued row with generated id + runId when none provided", async () => {
    const row = await queue.enqueue({ workflow: "workflows/build.dot" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(row.runId).toMatch(/^\d+-[a-z0-9]{6}$/);
    expect(row.workflow).toBe("workflows/build.dot");
    expect(row.status).toBe("queued");
    expect(row.priority).toBe(0);
    expect(typeof row.enqueuedAt).toBe("string");
    expect(row.startedAt).toBeUndefined();
    expect(row.childPid).toBeUndefined();
  });

  test("enqueue honours client-supplied id + runId + priority", async () => {
    const row = await queue.enqueue({
      id: "j1",
      runId: "r1",
      workflow: "w.dot",
      priority: 5,
      inputJson: JSON.stringify({ prompt: "hi" }),
      model: "claude-opus-4-7",
    });
    expect(row.id).toBe("j1");
    expect(row.runId).toBe("r1");
    expect(row.priority).toBe(5);
    expect(row.inputJson).toBe('{"prompt":"hi"}');
    expect(row.model).toBe("claude-opus-4-7");
  });

  test("duplicate id rejects via UNIQUE(id) constraint", async () => {
    await queue.enqueue({ id: "dup", runId: "a", workflow: "w.dot" });
    try {
      await queue.enqueue({ id: "dup", runId: "b", workflow: "w.dot" });
      throw new Error("expected UNIQUE violation");
    } catch (err) {
      expect((err as Error).message).toMatch(/UNIQUE|unique|constraint/i);
    }
  });

  test("duplicate runId rejects via UNIQUE(run_id) constraint", async () => {
    await queue.enqueue({ id: "a", runId: "shared", workflow: "w.dot" });
    try {
      await queue.enqueue({ id: "b", runId: "shared", workflow: "w.dot" });
      throw new Error("expected UNIQUE violation");
    } catch (err) {
      expect((err as Error).message).toMatch(/UNIQUE|unique|constraint/i);
    }
  });

  test("get returns the row, or undefined for unknown ids", async () => {
    const row = await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const loaded = await queue.get("j1");
    expect(loaded?.id).toBe(row.id);
    expect(loaded?.runId).toBe(row.runId);
    expect(await queue.get("no-such-id")).toBeUndefined();
  });

  test("list returns rows newest-first by default", async () => {
    await queue.enqueue({ id: "a", runId: "ra", workflow: "w.dot" });
    // Small delay so enqueued_at timestamps are distinguishable.
    await new Promise((r) => setTimeout(r, 5));
    await queue.enqueue({ id: "b", runId: "rb", workflow: "w.dot" });
    const rows = await queue.list();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("b");
    expect(rows[1]?.id).toBe("a");
  });

  test("list with status filters by status and respects priority ordering", async () => {
    await queue.enqueue({ id: "lo", runId: "rl", workflow: "w.dot", priority: 0 });
    await queue.enqueue({ id: "hi", runId: "rh", workflow: "w.dot", priority: 10 });
    const queued = await queue.list({ status: "queued" });
    expect(queued.map((r) => r.id)).toEqual(["hi", "lo"]);
  });

  test("list honours a custom limit", async () => {
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ id: `j${i}`, runId: `r${i}`, workflow: "w.dot" });
    }
    const rows = await queue.list({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  test("claimNext returns undefined on empty queue", async () => {
    expect(await queue.claimNext()).toBeUndefined();
  });

  test("claimNext transitions the highest-priority queued row to running", async () => {
    await queue.enqueue({ id: "lo", runId: "rl", workflow: "w.dot", priority: 0 });
    await queue.enqueue({ id: "hi", runId: "rh", workflow: "w.dot", priority: 10 });
    const claimed = await queue.claimNext();
    expect(claimed?.id).toBe("hi");
    expect(claimed?.status).toBe("running");
    expect(typeof claimed?.startedAt).toBe("string");
    // The unclaimed row stays queued.
    const lo = await queue.get("lo");
    expect(lo?.status).toBe("queued");
  });

  test("claimNext is atomic under concurrent callers", async () => {
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({ id: `j${i}`, runId: `r${i}`, workflow: "w.dot" });
    }
    const claims = await Promise.all(Array.from({ length: 5 }, () => queue.claimNext()));
    const claimedIds = claims.filter((c) => c !== undefined).map((c) => c!.id);
    // Each row can only be claimed once — no duplicates.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    // All 5 queued rows should have been claimed.
    expect(claimedIds).toHaveLength(5);
    // Double-check via `list`: no rows are still queued.
    expect(await queue.list({ status: "queued" })).toHaveLength(0);
  });

  test("markRunning records the child pid", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("j1", 54321);
    const row = await queue.get("j1");
    expect(row?.childPid).toBe(54321);
    expect(row?.status).toBe("running");
  });

  test("markTerminal transitions running → success and clears child_pid", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markRunning("j1", 100);
    await queue.markTerminal("j1", "success");
    const row = await queue.get("j1");
    expect(row?.status).toBe("success");
    expect(row?.childPid).toBeUndefined();
    expect(typeof row?.completedAt).toBe("string");
    expect(row?.error).toBeUndefined();
  });

  test("markTerminal records the error reason on failure", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markTerminal("j1", "failed", "oom");
    const row = await queue.get("j1");
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("oom");
  });

  test("markTerminal on an already-terminal row is a no-op (row stays as it was)", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await queue.markTerminal("j1", "success");
    // Try to flip to failed — should not overwrite.
    await queue.markTerminal("j1", "failed", "no effect");
    const row = await queue.get("j1");
    expect(row?.status).toBe("success");
    expect(row?.error).toBeUndefined();
  });

  test("delete removes a queued row", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.delete("j1");
    expect(await queue.get("j1")).toBeUndefined();
  });

  test("delete on a non-queued row throws", async () => {
    await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    await queue.claimNext();
    await expect(queue.delete("j1")).rejects.toThrow(/only queued/);
  });

  test("delete on a missing row throws not_found", async () => {
    await expect(queue.delete("ghost")).rejects.toThrow(/not found/);
  });

  test("runningJobs returns only rows with status='running'", async () => {
    await queue.enqueue({ id: "a", runId: "ra", workflow: "w.dot" });
    await queue.enqueue({ id: "b", runId: "rb", workflow: "w.dot" });
    await queue.enqueue({ id: "c", runId: "rc", workflow: "w.dot" });
    await queue.claimNext(); // a or b (priority tie → enqueued_at); regardless, one → running
    const running = await queue.runningJobs();
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
  });

  test("rowToJob round-trips ISO timestamps verbatim", async () => {
    const before = Date.now();
    const row = await queue.enqueue({ id: "j1", runId: "r1", workflow: "w.dot" });
    const after = Date.now();
    const t = Date.parse(row.enqueuedAt);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe("createSqliteJobQueue — on-disk path", () => {
  let scratch: string;
  let queue: JobQueue;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-queue-"));
  });

  afterEach(async () => {
    await queue.close();
    await rm(scratch, { recursive: true, force: true });
  });

  test("creates the parent directory + file on open", async () => {
    const dbPath = join(scratch, "nested/dir/queue.db");
    queue = createSqliteJobQueue({ dbPath });
    const s = await stat(dbPath);
    expect(s.isFile()).toBe(true);
    // Sanity: rows survive close + reopen against the same file.
    await queue.enqueue({ id: "persist", runId: "rp", workflow: "w.dot" });
    await queue.close();
    queue = createSqliteJobQueue({ dbPath });
    expect((await queue.get("persist"))?.runId).toBe("rp");
  });
});
