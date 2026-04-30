// Reaper takeover + daemon-started events — emitted from the entrypoint
// after acquiring (or force-acquiring) the daemon lock. The lock is the
// same surface used by P9; here we assert the audit trail.

import { describe, expect, test } from "bun:test";
import * as handler from "@swarm/core/handler";
import { SqliteStore } from "@swarm/store";
import { Dispatcher } from "../src/dispatch.ts";
import { startDaemon } from "../src/entrypoint.ts";

function rig(): {
  store: SqliteStore;
  dispatcher: Dispatcher;
  tools: handler.InMemoryToolRegistry;
  llmCall: handler.LlmCallFn;
} {
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf", "t", "digraph{}");
  return {
    store,
    dispatcher: new Dispatcher(),
    tools: new handler.InMemoryToolRegistry(),
    llmCall: async () => ({ content: "", tokens: 0, costUsd: 0, model: "stub" }),
  };
}

describe("daemon entrypoint — daemon_events", () => {
  test("daemon.started is appended after a clean lock acquisition", async () => {
    const r = rig();
    const ctrl = new AbortController();
    ctrl.abort();
    const handle = startDaemon({
      store: r.store,
      dispatcher: r.dispatcher,
      tools: r.tools,
      llmCall: r.llmCall,
      pid: 7777,
      hostname: "hostClean",
      maxConcurrentRuns: 1,
      shutdownSignal: ctrl.signal,
    });
    await handle.done.catch(() => undefined);

    const events = r.store.getDaemonEvents();
    const started = events.find((e) => e.type === "daemon.started");
    expect(started).toBeDefined();
    expect(started!.payload).toEqual({ pid: 7777, hostname: "hostClean" });
    expect(events.find((e) => e.type === "daemon.reaper_took_over")).toBeUndefined();
    r.store.close();
  });

  test("stale lock → reaper takeover emits daemon.reaper_took_over with priorPid + staleForMs", async () => {
    const r = rig();
    // Pre-seed the lock with a stale heartbeat (60s ago).
    const PRIOR_PID = 1111;
    const PRIOR_HOST = "deadHost";
    r.store.acquireDaemonLock(PRIOR_PID, PRIOR_HOST);
    // Backdate the heartbeat directly. We need staleForMs > lockTtl.
    // biome-ignore lint/suspicious/noExplicitAny: test-only access
    const db = (r.store as any).db as { query: (sql: string) => { run: (...args: unknown[]) => unknown } };
    const oldHeartbeat = Date.now() - 60_000;
    db.query("UPDATE daemon_lock SET heartbeat_at = ? WHERE id = 1").run(oldHeartbeat);

    const ctrl = new AbortController();
    ctrl.abort();
    const handle = startDaemon({
      store: r.store,
      dispatcher: r.dispatcher,
      tools: r.tools,
      llmCall: r.llmCall,
      pid: 2222,
      hostname: "hostNew",
      maxConcurrentRuns: 1,
      lockTtlMs: 30_000,
      shutdownSignal: ctrl.signal,
    });
    await handle.done.catch(() => undefined);

    const events = r.store.getDaemonEvents();
    const takeover = events.find((e) => e.type === "daemon.reaper_took_over");
    expect(takeover).toBeDefined();
    const payload = takeover!.payload as {
      priorPid: number;
      priorHostname: string;
      priorHeartbeatAt: number;
      staleForMs: number;
    };
    expect(payload.priorPid).toBe(PRIOR_PID);
    expect(payload.priorHostname).toBe(PRIOR_HOST);
    expect(payload.priorHeartbeatAt).toBe(oldHeartbeat);
    expect(payload.staleForMs).toBeGreaterThan(0);

    const started = events.find((e) => e.type === "daemon.started");
    expect(started).toBeDefined();
    expect(started!.payload).toEqual({ pid: 2222, hostname: "hostNew" });

    // Order: takeover precedes started (seq is monotonic).
    expect(takeover!.seq).toBeLessThan(started!.seq);
    r.store.close();
  });
});
