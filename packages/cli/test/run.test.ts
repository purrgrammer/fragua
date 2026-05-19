// swarm run: full round-trip — CLI uploads DOT, enqueues a run, streams
// events until terminal. Spins up a real server + a foreground daemon
// fiber so the SSE stream actually progresses.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as handler from "@swarm/core/handler";
import { AbortRegistry, autoDispatcherResolver, Dispatcher, runExecutor } from "@swarm/daemon";
import { createServer } from "@swarm/server";
import { SqliteStore } from "@swarm/store";
import { runCommand } from "../src/commands/run.ts";

interface Rig {
  url: string;
  store: SqliteStore;
  close: () => Promise<void>;
}

const tmps: string[] = [];

afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "swarm-run-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".swarm"), { recursive: true });
  const store = new SqliteStore({ path: join(dir, ".swarm/swarm.db") });

  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  const app = createServer({ store });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const url = `http://127.0.0.1:${server.port}`;

  const shutdown = new AbortController();
  const executorPromise = runExecutor({
    store,
    dispatcher,
    registry: new AbortRegistry(),
    tools,
    llmCall,
    maxConcurrentRuns: 2,
    pollIntervalMs: 10,
    shutdownSignal: shutdown.signal,
  }).catch(() => {});

  return {
    url,
    store,
    close: async () => {
      shutdown.abort();
      await executorPromise;
      await server.stop(true);
      store.close();
    },
  };
}

describe.skip("swarm run", () => {
  test("round-trip: DOT file → upload → enqueue → stream → completed", async () => {
    const r = await rig();
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "swarm-wf-"));
      tmps.push(workflowDir);
      const dotPath = join(workflowDir, "echo.dot");
      writeFileSync(
        dotPath,
        `digraph Echo {
           start [shape=Mdiamond];
           finish [shape=Msquare];
           start -> finish;
         }`,
      );

      const exitCode = await runCommand({
        workflow: dotPath,
        url: r.url,
      });
      expect(exitCode).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("cannot read workflow file → exit 1", async () => {
    const code = await runCommand({
      workflow: "/nonexistent/workflow.dot",
      url: "http://127.0.0.1:1",
    });
    expect(code).toBe(1);
  });

  test("--no-follow exits immediately after enqueue", async () => {
    const r = await rig();
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "swarm-wf-"));
      tmps.push(workflowDir);
      const dotPath = join(workflowDir, "echo.dot");
      writeFileSync(dotPath, `digraph { start [shape=Mdiamond]; end [shape=Msquare]; start -> end; }`);

      const code = await runCommand({
        workflow: dotPath,
        url: r.url,
        follow: false,
      });
      expect(code).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("opts.input is carried into routing.input on the enqueued run", async () => {
    const r = await rig();
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "swarm-wf-"));
      tmps.push(workflowDir);
      const dotPath = join(workflowDir, "echo.dot");
      writeFileSync(dotPath, `digraph { start [shape=Mdiamond]; end [shape=Msquare]; start -> end; }`);

      const code = await runCommand({
        workflow: dotPath,
        url: r.url,
        follow: false,
        input: "rename foo to bar",
      });
      expect(code).toBe(0);
      // Peek at the most-recently-enqueued run. The round-trip test above
      // also enqueues one; isolate by checking the max-seq intent payload.
      const db = (r.store as unknown as { db: import("bun:sqlite").Database }).db;
      const row = db
        .query<{ run_id: string }, []>(`SELECT run_id FROM run_state ORDER BY enqueued_at DESC LIMIT 1`)
        .get();
      expect(row).not.toBeNull();
      const state = r.store.getState(row!.run_id);
      expect(state!.routing["input"]).toBe("rename foo to bar");
    } finally {
      await r.close();
    }
  });
});
