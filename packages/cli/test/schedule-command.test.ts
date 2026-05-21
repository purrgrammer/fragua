// `fragua schedule` CLI \u2014 covers the four happy-path commands by spinning
// up a real `@fragua/server` schedule routes app and pointing the
// command's URL discovery at it via the explicit `--url` override.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SqliteStore } from "@fragua/store";
import { Hono } from "hono";
import { createScheduleRoutes, type ScheduleRoutesDeps } from "../../server/src/store/schedule-routes.ts";
import {
  scheduleAddCommand,
  scheduleListCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleRmCommand,
} from "../src/commands/schedule.ts";

interface Rig {
  url: string;
  store: SqliteStore;
  close: () => void;
}

let r: Rig;
let logs: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(async () => {
  const store = new SqliteStore({ path: ":memory:" });
  const app = new Hono();
  const deps: ScheduleRoutesDeps = { store };
  app.route("/", createScheduleRoutes(deps));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  r = {
    url: `http://127.0.0.1:${server.port}`,
    store,
    close: () => {
      server.stop(true);
      store.close();
    },
  };
  logs = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  r.close();
});

describe("scheduleAddCommand", () => {
  test("POSTs /schedules with the right body and reports the new id", async () => {
    const code = await scheduleAddCommand({
      workflow: "analyze",
      every: "1h",
      cwd: "/repo",
      url: r.url,
    });
    expect(code).toBe(0);
    const rows = r.store.listSchedules();
    expect(rows.length).toBe(1);
    expect(rows[0]!.workflowRef).toBe("analyze");
    expect(rows[0]!.intervalText).toBe("1h");
    expect(rows[0]!.overlapPolicy).toBe("skip");
    expect(rows[0]!.cwd).toBe("/repo");
    // CLI announces the id.
    expect(logs.some((l) => l.includes("schedule created"))).toBe(true);
  });

  test("rejects --every outside the four-value whitelist before hitting the server", async () => {
    const code = await scheduleAddCommand({
      workflow: "wf",
      every: "5m",
      url: r.url,
    });
    expect(code).toBe(1);
    expect(r.store.listSchedules().length).toBe(0);
  });

  test("--no-fire-on-create propagates fireOnCreate=false", async () => {
    const code = await scheduleAddCommand({
      workflow: "wf",
      every: "1h",
      cwd: "/r",
      noFireOnCreate: true,
      url: r.url,
    });
    expect(code).toBe(0);
    const row = r.store.listSchedules()[0]!;
    // fireOnCreate=false \u2192 nextFireAt = now + intervalMs (~1h ahead).
    expect(row.nextFireAt).toBeGreaterThan(row.createdAt + 30 * 60 * 1000);
  });
});

describe("scheduleListCommand", () => {
  test("renders one row per schedule with workflow / cwd / interval / status / health-stripe columns", async () => {
    const sha = "wf_sha_list";
    r.store.saveWorkflow(sha, "wf-a", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    r.store.createSchedule(
      { id: "sch_a", workflowRef: "wf-a", cwd: "/p", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );
    r.store.createSchedule(
      { id: "sch_b", workflowRef: "wf-b", cwd: "/p", intervalMs: 6 * 3_600_000, intervalText: "6h" },
      Date.now(),
    );
    r.store.pauseSchedule("sch_b", Date.now());

    const code = await scheduleListCommand({ url: r.url });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("sch_a");
    expect(out).toContain("sch_b");
    expect(out).toContain("wf-a");
    expect(out).toContain("paused");
    expect(out).toContain("active");
    // Health stripe column header present.
    expect(out).toContain("Last 10");
  });

  test("renders health stripe with ✅/❌/⏳ derived from terminal status of the last 10 runs", async () => {
    const sha = "wf_stripe";
    r.store.saveWorkflow(sha, "wf", "name: t\nsteps:\n  work: {type: llm, prompt: x}\n");
    r.store.createSchedule(
      { id: "sch_stripe", workflowRef: "wf", cwd: "/p", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );

    // Seed runs: completed, halted, queued (in-flight)
    const r1 = "run_s1";
    const r2 = "run_s2";
    const r3 = "run_s3";
    for (const id of [r1, r2, r3]) {
      r.store.enqueueRun({ runId: id, workflowSha: sha, scheduleId: "sch_stripe" });
    }
    // Walk r1 to completed and r2 to halted via appendFact.
    const s1 = r.store.getState(r1)!;
    const s2 = r.store.getState(r2)!;
    r.store.appendFact(
      r1,
      [{ type: "fact.run_started", payload: { workflowSha: sha, schemaVersion: 5, startNode: "a" } } as never],
      s1.version,
    );
    const s1b = r.store.getState(r1)!;
    r.store.appendFact(r1, [{ type: "fact.run_completed", payload: { finalNode: "b" } } as never], s1b.version);
    r.store.appendFact(
      r2,
      [{ type: "fact.run_started", payload: { workflowSha: sha, schemaVersion: 5, startNode: "a" } } as never],
      s2.version,
    );
    const s2b = r.store.getState(r2)!;
    r.store.appendFact(
      r2,
      [{ type: "fact.run_halted", payload: { reason: "error", detail: "test" } } as never],
      s2b.version,
    );

    const code = await scheduleListCommand({ url: r.url });
    expect(code).toBe(0);
    const out = logs.join("\n");
    // r1=completed→✅, r2=halted→❌, r3=queued(in-flight)→⏳
    // recentRuns is newest-first from server, reversed by CLI for display.
    expect(out).toContain("✅");
    expect(out).toContain("❌");
    expect(out).toContain("⏳");
  });

  test("--cwd filters server-side", async () => {
    r.store.createSchedule(
      { id: "sch_x", workflowRef: "wf", cwd: "/one", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );
    r.store.createSchedule(
      { id: "sch_y", workflowRef: "wf", cwd: "/two", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );
    const code = await scheduleListCommand({ url: r.url, cwd: "/two" });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("sch_y");
    expect(out).not.toContain("sch_x");
  });
});

describe("scheduleRmCommand", () => {
  test("DELETEs the schedule and prints its id", async () => {
    r.store.createSchedule(
      { id: "sch_d", workflowRef: "wf", cwd: "/r", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );
    const code = await scheduleRmCommand({ id: "sch_d", url: r.url });
    expect(code).toBe(0);
    expect(r.store.getSchedule("sch_d")).toBeNull();
    expect(logs.some((l) => l.includes("schedule deleted"))).toBe(true);
  });

  test("returns 1 on unknown id", async () => {
    const code = await scheduleRmCommand({ id: "sch_nope", url: r.url });
    expect(code).toBe(1);
  });
});

describe("schedulePauseCommand / scheduleResumeCommand", () => {
  test("pause sets paused_at; resume clears it (no catch-up)", async () => {
    const created = r.store.createSchedule(
      { id: "sch_p", workflowRef: "wf", cwd: "/r", intervalMs: 3_600_000, intervalText: "1h" },
      Date.now(),
    );
    const pauseCode = await schedulePauseCommand({ id: created.id, url: r.url });
    expect(pauseCode).toBe(0);
    expect(r.store.getSchedule(created.id)!.pausedAt).not.toBeNull();

    const resumeCode = await scheduleResumeCommand({ id: created.id, url: r.url });
    expect(resumeCode).toBe(0);
    expect(r.store.getSchedule(created.id)!.pausedAt).toBeNull();
  });
});
