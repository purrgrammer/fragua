// Daemon-events table — append + read filters + payload cap + cascade.

import { describe, expect, test } from "bun:test";
import { PayloadTooLargeError } from "../src/types.ts";
import { freshStore, seedRun } from "./helpers.ts";

describe("daemon_events", () => {
  test("append + read round-trips payload and ts", () => {
    const store = freshStore();
    const r = store.appendDaemonEvent({
      type: "daemon.started",
      payload: { pid: 4242, hostname: "h1" },
    });
    expect(r.seq).toBeGreaterThan(0);
    expect(r.ts).toBeGreaterThan(0);

    const rows = store.getDaemonEvents();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.type).toBe("daemon.started");
    expect(row.payload).toEqual({ pid: 4242, hostname: "h1" });
    expect(row.ts).toBe(r.ts);
    expect(row.seq).toBe(r.seq);
    expect(row.runId).toBeNull();
    store.close();
  });

  test("filter by runId returns only run-scoped events", async () => {
    const store = freshStore();
    const runId = await seedRun(store);

    store.appendDaemonEvent({
      type: "daemon.started",
      payload: { pid: 1, hostname: "h" },
    });
    store.appendDaemonEvent(
      {
        type: "daemon.leak_detected",
        payload: { runId, nodeId: "a", count: 1, ceiling: 3 },
      },
      { runId },
    );
    store.appendDaemonEvent({
      type: "daemon.sweep_completed",
      payload: { requeued: 0, quarantined: 0, durationMs: 5 },
    });

    const all = store.getDaemonEvents();
    expect(all).toHaveLength(3);

    const scoped = store.getDaemonEvents({ runId });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.type).toBe("daemon.leak_detected");
    expect(scoped[0]!.runId).toBe(runId);
    store.close();
  });

  test("latestDaemonLifecycleEvent returns the newest started/stopped row, skipping other daemon events", () => {
    const store = freshStore();
    expect(store.latestDaemonLifecycleEvent()).toBeNull();

    store.appendDaemonEvent({ type: "daemon.started", payload: { pid: 1, hostname: "h" } });
    store.appendDaemonEvent({
      type: "daemon.sweep_completed",
      payload: { requeued: 0, quarantined: 0, durationMs: 1 },
    });
    store.appendDaemonEvent({
      type: "daemon.stopped",
      payload: { pid: 1, reason: "leak_limit", detail: "1 handler leaks", leaked: [{ runId: "r1", nodeId: "hang" }] },
    });
    store.appendDaemonEvent({
      type: "daemon.leak_detected",
      payload: { runId: "r1", nodeId: "hang", count: 1, ceiling: 1 },
    });

    const latest = store.latestDaemonLifecycleEvent();
    expect(latest).not.toBeNull();
    expect(latest!.type).toBe("daemon.stopped");
    expect(latest!.payload).toEqual({
      pid: 1,
      reason: "leak_limit",
      detail: "1 handler leaks",
      leaked: [{ runId: "r1", nodeId: "hang" }],
    });
    store.close();
  });

  test("payload over 4KB is rejected with PayloadTooLargeError", () => {
    const store = freshStore();
    const big = "x".repeat(5000);
    expect(() =>
      store.appendDaemonEvent({
        type: "daemon.stopped",
        payload: { pid: 1, reason: "error", detail: big },
      }),
    ).toThrow(PayloadTooLargeError);
    store.close();
  });

  test("seq is autoincrement and monotonic across appends", () => {
    const store = freshStore();
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = store.appendDaemonEvent({
        type: "daemon.sweep_completed",
        payload: { requeued: i, quarantined: 0, durationMs: 1 },
      });
      seqs.push(r.seq);
    }
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }

    // sinceSeq filters strictly greater
    const tail = store.getDaemonEvents({ sinceSeq: seqs[2]! });
    expect(tail).toHaveLength(2);
    expect(tail[0]!.seq).toBe(seqs[3]!);
    store.close();
  });

  test("ON DELETE SET NULL preserves daemon events when their run is deleted", async () => {
    const store = freshStore();
    const runId = await seedRun(store);
    const evt = store.appendDaemonEvent(
      {
        type: "daemon.worktree_provisioned",
        payload: { runId, ok: true },
      },
      { runId },
    );

    // Delete the run via the underlying DB. Cascade fires on the
    // events / messages / artifacts tables; daemon_events should set
    // run_id to NULL but keep the row.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    const db = (store as any).db as { query: (sql: string) => { run: (...args: unknown[]) => unknown } };
    db.query("DELETE FROM run_state WHERE run_id = ?").run(runId);

    const rows = store.getDaemonEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seq).toBe(evt.seq);
    expect(rows[0]!.runId).toBeNull();
    store.close();
  });
});
