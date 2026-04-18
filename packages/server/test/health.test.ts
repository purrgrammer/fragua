// Tests for GET /health. Two shapes:
//   - { ok: true }                          — no daemon injected
//   - { ok: true, daemon: { ... } }         — daemon info provider set
//
// The second shape drives the web UI's "daemon-down" banner; the first
// is the plain `swarm serve` path and must stay backwards-compatible.

import { describe, expect, test } from "bun:test";
import { createServer } from "../src/index.ts";
import type { HealthDaemonInfo } from "../src/routes/health.ts";
import { memoryRunReader } from "./helpers.ts";

describe("GET /health", () => {
  test("without daemonInfo → { ok: true } only", async () => {
    const app = createServer({
      runsDir: "/tmp/health-a",
      ports: { runReader: memoryRunReader({}) },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daemon?: unknown };
    expect(body.ok).toBe(true);
    expect("daemon" in body).toBe(false);
  });

  test("with daemonInfo → includes the daemon key", async () => {
    const info: HealthDaemonInfo = {
      pid: 12345,
      port: 3737,
      startedAt: "2026-04-18T12:00:00.000Z",
      version: "0.0.0",
      concurrency: 2,
      inflight: 0,
      queued: 3,
    };
    const app = createServer({
      runsDir: "/tmp/health-b",
      ports: { runReader: memoryRunReader({}), daemonInfo: () => info },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daemon: HealthDaemonInfo };
    expect(body.ok).toBe(true);
    expect(body.daemon).toEqual(info);
  });

  test("daemonInfo is called per request (counters stay fresh)", async () => {
    let queued = 0;
    const app = createServer({
      runsDir: "/tmp/health-c",
      ports: {
        runReader: memoryRunReader({}),
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
    const a = (await (await app.request("/health")).json()) as { daemon: { queued: number } };
    const b = (await (await app.request("/health")).json()) as { daemon: { queued: number } };
    expect(a.daemon.queued).toBe(0);
    expect(b.daemon.queued).toBe(1);
  });

  test("a throwing daemonInfo falls back to { ok: true } (liveness doesn't flap)", async () => {
    const app = createServer({
      runsDir: "/tmp/health-d",
      ports: {
        runReader: memoryRunReader({}),
        daemonInfo: () => {
          throw new Error("queue closed");
        },
      },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; daemon?: unknown };
    expect(body.ok).toBe(true);
    expect("daemon" in body).toBe(false);
  });
});
