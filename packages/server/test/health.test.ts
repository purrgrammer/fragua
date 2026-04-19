// Tests for GET /health.

import { describe, expect, test } from "bun:test";
import { createServer } from "../src/index.ts";
import type { HealthDaemonInfo } from "../src/routes/health.ts";
import { freshStore } from "./helpers.ts";

describe("GET /health", () => {
  test("without daemonInfo → { ok: true } only", async () => {
    const store = freshStore();
    const app = createServer({ store });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daemon?: unknown };
    expect(body.ok).toBe(true);
    expect("daemon" in body).toBe(false);
    store.close();
  });

  test("with daemonInfo → includes the daemon key", async () => {
    const store = freshStore();
    const info: HealthDaemonInfo = {
      pid: 12345,
      port: 3737,
      startedAt: "2026-04-18T12:00:00.000Z",
      version: "0.0.0",
      concurrency: 2,
      inflight: 0,
      queued: 3,
    };
    const app = createServer({ store, ports: { daemonInfo: () => info } });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daemon: HealthDaemonInfo };
    expect(body.ok).toBe(true);
    expect(body.daemon).toEqual(info);
    store.close();
  });

  test("daemonInfo is called per request (counters stay fresh)", async () => {
    let queued = 0;
    const store = freshStore();
    const app = createServer({
      store,
      ports: {
        daemonInfo: () => ({
          pid: 1,
          port: 1,
          startedAt: "t",
          version: "v",
          concurrency: 1,
          inflight: 0,
          queued: queued++,
        }),
      },
    });
    const res1 = (await (await app.request("/health")).json()) as {
      daemon: { queued: number };
    };
    const res2 = (await (await app.request("/health")).json()) as {
      daemon: { queued: number };
    };
    expect(res1.daemon.queued).toBe(0);
    expect(res2.daemon.queued).toBe(1);
    store.close();
  });

  test("daemonInfo may be async", async () => {
    const store = freshStore();
    const app = createServer({
      store,
      ports: {
        daemonInfo: async () => ({
          pid: 7,
          port: 8,
          startedAt: "t",
          version: "v",
          concurrency: 1,
          inflight: 0,
          queued: 0,
        }),
      },
    });
    const res = await app.request("/health");
    const body = (await res.json()) as { daemon: { pid: number } };
    expect(body.daemon.pid).toBe(7);
    store.close();
  });
});
