// Read-path ceilings (Surfaces F5/F6): the `/metrics/global` window is clamped
// so a pathological `?windowHours=1e12` can't drive the cutoff negative and scan
// all history, and the full-fidelity `/runs/:id/events.json` + `/runs/:id/messages`
// endpoints clamp an opt-in `?limit` to 5000 while leaving the default uncapped
// (the canonical give-me-everything contract).

import { describe, expect, test } from "bun:test";
import type { GetEventsOpts, GetMessagesOpts, IEventReader } from "@fragua/store";
import { SqliteStore } from "@fragua/store";
import { createRoutes } from "../src/store/routes.ts";
import { storeRunsRoutes } from "../src/store/runs-routes.ts";

const STUB_IR = JSON.stringify({ id: "t", directed: true, attrs: {}, nodes: {}, edges: [] });
const WF_SRC = "name: t\nsteps:\n  work: {type: llm, prompt: x}\n";
const DAY_MS = 24 * 3_600_000;

describe("GET /metrics/global — windowHours clamp", () => {
  function seed(): { store: SqliteStore; now: number } {
    const now = 1_800_000_000_000;
    let clock = now;
    const store = new SqliteStore({ path: ":memory:", now: () => clock });
    store.saveWorkflow("wf1", "test", WF_SRC, STUB_IR, 1);
    clock = now - 7 * 365 * DAY_MS; // 7 years ago
    store.enqueueRun({ runId: "old7", workflowSha: "wf1" });
    clock = now - 60 * DAY_MS; // 60 days ago
    store.enqueueRun({ runId: "old60", workflowSha: "wf1" });
    clock = now; // recent
    store.enqueueRun({ runId: "recent", workflowSha: "wf1" });
    return { store, now };
  }

  test("a huge windowHours is clamped to the 5-year ceiling, not an all-history scan", async () => {
    const { store, now } = seed();
    const app = createRoutes({ store, now: () => now });
    const res = await app.request("/metrics/global?windowHours=1000000000000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total_runs: number };
    // Clamped to 5 years → the 60-day and recent runs count; the 7-year-old
    // one is excluded. An unclamped 1e12h window would have counted all 3.
    expect(body.total_runs).toBe(2);
    store.close();
  });

  test("a windowHours above the cap yields the same clamped window", async () => {
    const { store, now } = seed();
    const app = createRoutes({ store, now: () => now });
    const overCap = 24 * 365 * 10; // 10 years, above the 5-year cap
    const res = await app.request(`/metrics/global?windowHours=${overCap}`);
    const body = (await res.json()) as { total_runs: number };
    expect(body.total_runs).toBe(2);
    store.close();
  });

  test("absent windowHours preserves the 30-day default window", async () => {
    const { store, now } = seed();
    const app = createRoutes({ store, now: () => now });
    const res = await app.request("/metrics/global");
    const body = (await res.json()) as { total_runs: number };
    // 30-day default excludes both the 60-day and 7-year runs.
    expect(body.total_runs).toBe(1);
    store.close();
  });
});

/** Wrap a real store, delegating every method, but record the `limit` that
 * reaches `getEvents` / `getMessagesNarrow` so the route-level clamp is
 * observable without seeding thousands of rows. */
function recordingStore(real: SqliteStore): {
  store: IEventReader;
  seen: { events?: number | undefined; messages?: number | undefined };
} {
  const seen: { events?: number | undefined; messages?: number | undefined } = {};
  const store = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "getEvents") {
        return (runId: string, opts?: GetEventsOpts) => {
          seen.events = opts?.limit;
          return target.getEvents(runId, opts);
        };
      }
      if (prop === "getMessagesNarrow") {
        return (runId: string, opts?: GetMessagesOpts) => {
          seen.messages = opts?.limit;
          return target.getMessagesNarrow(runId, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as IEventReader;
  return { store, seen };
}

function seedRun(): SqliteStore {
  const store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow("wf1", "test", WF_SRC, STUB_IR, 1);
  store.enqueueRun({ runId: "r1", workflowSha: "wf1" });
  return store;
}

describe("GET /runs/:id/events.json — limit ceiling", () => {
  test("a huge ?limit is clamped to 5000", async () => {
    const real = seedRun();
    const { store, seen } = recordingStore(real);
    const app = storeRunsRoutes({ store });
    const res = await app.request("/runs/r1/events.json?limit=999999");
    expect(res.status).toBe(200);
    expect(seen.events).toBe(5000);
    real.close();
  });

  test("a small ?limit passes through (floored)", async () => {
    const real = seedRun();
    const { store, seen } = recordingStore(real);
    const app = storeRunsRoutes({ store });
    await app.request("/runs/r1/events.json?limit=3.9");
    expect(seen.events).toBe(3);
    real.close();
  });

  test("absent ?limit leaves the default uncapped", async () => {
    const real = seedRun();
    const { store, seen } = recordingStore(real);
    const app = storeRunsRoutes({ store });
    await app.request("/runs/r1/events.json");
    expect(seen.events).toBeUndefined();
    real.close();
  });
});

describe("GET /runs/:id/messages — limit ceiling", () => {
  test("a huge ?limit is clamped to 5000", async () => {
    const real = seedRun();
    const { store, seen } = recordingStore(real);
    const app = storeRunsRoutes({ store });
    const res = await app.request("/runs/r1/messages?limit=999999");
    expect(res.status).toBe(200);
    expect(seen.messages).toBe(5000);
    real.close();
  });

  test("absent ?limit leaves the default uncapped", async () => {
    const real = seedRun();
    const { store, seen } = recordingStore(real);
    const app = storeRunsRoutes({ store });
    await app.request("/runs/r1/messages");
    expect(seen.messages).toBeUndefined();
    real.close();
  });
});
