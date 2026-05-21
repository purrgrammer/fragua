// HTTP route coverage for the schedules surface

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { createScheduleRoutes } from "../../src/store/schedule-routes.ts";

let store: SqliteStore;
let server: { fetch: (req: Request) => Response | Promise<Response> };
let nowMs = 1_700_000_000_000;

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  nowMs = 1_700_000_000_000;
  server = createScheduleRoutes({ store, now: () => nowMs });
});

afterEach(() => {
  store.close();
});

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return server.fetch(new Request(`http://test${path}`, init));
}

describe("POST /schedules", () => {
  test("creates a schedule and returns its id, defaults overlap=skip, fire_on_create=true", async () => {
    const res = await req("POST", "/schedules", {
      workflow: "analyze",
      cwd: "/repo",
      every: "1h",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      overlapPolicy: string;
      nextFireAt: number;
      pausedAt: number | null;
    };
    expect(body.id).toMatch(/^sch_/);
    expect(body.overlapPolicy).toBe("skip");
    expect(body.pausedAt).toBeNull();
    // fireOnCreate defaults true \u2192 nextFireAt == now
    expect(body.nextFireAt).toBe(nowMs);

    // intent.schedule_create row landed on daemon_events
    const events = store.getDaemonEvents({});
    const intents = events.filter((e) => e.type === "intent.schedule_create");
    expect(intents.length).toBe(1);
  });

  test("--no-fire-on-create waits one full interval before first fire", async () => {
    const res = await req("POST", "/schedules", {
      workflow: "wf",
      cwd: "/r",
      every: "1h",
      fireOnCreate: false,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nextFireAt: number };
    expect(body.nextFireAt).toBe(nowMs + 60 * 60 * 1000);
  });

  test("rejects unknown overlap policy with 400", async () => {
    const res = await req("POST", "/schedules", {
      workflow: "wf",
      cwd: "/r",
      every: "1h",
      overlap: "wat",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_overlap");
  });

  test("rejects an interval outside the shorthand whitelist with 400", async () => {
    for (const bad of ["5m", "1d", "30s", "60", ""]) {
      const res = await req("POST", "/schedules", {
        workflow: "wf",
        cwd: "/r",
        every: bad,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code?: string };
      expect(body.code).toBe("invalid_interval");
    }
  });

  test("rejects missing workflow / cwd with 400", async () => {
    const r1 = await req("POST", "/schedules", { cwd: "/r", every: "1h" });
    expect(r1.status).toBe(400);
    const r2 = await req("POST", "/schedules", { workflow: "wf", every: "1h" });
    expect(r2.status).toBe(400);
  });
});

describe("GET /schedules?cwd=...", () => {
  test("filters by cwd and returns rows ordered by created_at ASC", async () => {
    nowMs = 100;
    await req("POST", "/schedules", { workflow: "a", cwd: "/p1", every: "1h" });
    nowMs = 200;
    await req("POST", "/schedules", { workflow: "b", cwd: "/p2", every: "1h" });
    nowMs = 300;
    await req("POST", "/schedules", { workflow: "c", cwd: "/p1", every: "6h" });

    const res = await req("GET", "/schedules?cwd=/p1");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ workflowRef: string; recentRuns: unknown[] }>;
    expect(rows.map((r) => r.workflowRef)).toEqual(["a", "c"]);
    // Health stripe data embedded — empty array because no runs have fired yet.
    expect(rows[0]?.recentRuns).toEqual([]);

    const all = (await (await req("GET", "/schedules")).json()) as Array<{ workflowRef: string }>;
    expect(all.length).toBe(3);
  });

  test("embeds recentRuns health stripe data in GET /schedules response", async () => {
    // Seed a schedule and manually associate a completed + a halted run.
    const sha = "wf_sha_stripe";
    store.saveWorkflow(sha, "wf", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    const created = (await (await req("POST", "/schedules", { workflow: "wf", cwd: "/r", every: "1h" })).json()) as {
      id: string;
    };

    const r1 = "run_stripe_1";
    const r2 = "run_stripe_2";
    store.enqueueRun({ runId: r1, workflowSha: sha, scheduleId: created.id });
    store.enqueueRun({ runId: r2, workflowSha: sha, scheduleId: created.id });

    const res = await req("GET", "/schedules");
    const rows = (await res.json()) as Array<{
      id: string;
      recentRuns: Array<{ runId: string; status: string }>;
    }>;
    const row = rows.find((r) => r.id === created.id)!;
    // Both runs are queued (non-terminal) — stripe has 2 entries.
    expect(row.recentRuns.length).toBe(2);
    expect(row.recentRuns.every((r) => r.status === "queued")).toBe(true);
  });
});

describe("POST /schedules/:id/pause + /resume", () => {
  test("pause sets paused_at; resume clears it and emits matching daemon-event audit rows", async () => {
    nowMs = 1_000;
    const created = (await (await req("POST", "/schedules", { workflow: "wf", cwd: "/r", every: "1h" })).json()) as {
      id: string;
    };

    nowMs = 2_000;
    const pauseRes = await req("POST", `/schedules/${created.id}/pause`);
    expect(pauseRes.status).toBe(200);
    const paused = (await pauseRes.json()) as { pausedAt: number };
    expect(paused.pausedAt).toBe(2_000);

    nowMs = 5_000;
    const resumeRes = await req("POST", `/schedules/${created.id}/resume`);
    const resumed = (await resumeRes.json()) as { pausedAt: number | null; nextFireAt: number };
    expect(resumed.pausedAt).toBeNull();
    // Per proposal: resume re-anchors next_fire_at = now + interval_ms (no catch-up).
    expect(resumed.nextFireAt).toBe(5_000 + 60 * 60 * 1000);

    const events = store.getDaemonEvents({}).map((e) => e.type);
    expect(events).toContain("intent.schedule_pause");
    expect(events).toContain("intent.schedule_resume");
  });

  test("returns 404 for unknown id", async () => {
    const r = await req("POST", "/schedules/sch_nope/pause");
    expect(r.status).toBe(404);
  });
});

describe("DELETE /schedules/:id", () => {
  test("hard-deletes the row and emits intent.schedule_delete audit event", async () => {
    const created = (await (await req("POST", "/schedules", { workflow: "wf", cwd: "/r", every: "1h" })).json()) as {
      id: string;
    };

    const del = await req("DELETE", `/schedules/${created.id}`);
    expect(del.status).toBe(200);
    expect(store.getSchedule(created.id)).toBeNull();
    const events = store.getDaemonEvents({}).map((e) => e.type);
    expect(events).toContain("intent.schedule_delete");
  });

  test("returns 404 for unknown id", async () => {
    const r = await req("DELETE", "/schedules/sch_nope");
    expect(r.status).toBe(404);
  });
});
