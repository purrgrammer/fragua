import { describe, expect, test } from "bun:test";
import { freshStore, nextId, seedWorkflow } from "./helpers.ts";

const HOUR_MS = 60 * 60 * 1000;

describe("schedule queries", () => {
  test("insert + select round-trips a row with all defaults", () => {
    const store = freshStore(1_700_000_000_000);
    const created = store.createSchedule(
      {
        id: "sch_a",
        workflowRef: "analyze",
        cwd: "/repo",
        intervalMs: HOUR_MS,
        intervalText: "1h",
      },
      1_700_000_000_000,
    );
    expect(created.overlapPolicy).toBe("skip");
    expect(created.pausedAt).toBeNull();
    expect(created.title).toBeNull();
    expect(created.nextFireAt).toBe(1_700_000_000_000);

    const fetched = store.getSchedule("sch_a");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("sch_a");
    expect(fetched!.workflowRef).toBe("analyze");
    expect(fetched!.cwd).toBe("/repo");
    expect(fetched!.intervalMs).toBe(HOUR_MS);
    expect(fetched!.intervalText).toBe("1h");
    expect(fetched!.overlapPolicy).toBe("skip");
    expect(fetched!.pausedAt).toBeNull();
    expect(fetched!.lastRunId).toBeNull();
    store.close();
  });

  test("getDueSchedules returns rows with next_fire_at <= now and paused_at IS NULL", () => {
    const store = freshStore(1_000_000);
    // a: due at t=2_000_000 (in past at our query time 5_000_000)
    store.createSchedule(
      { id: "sch_a", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h", fireOnCreate: false },
      2_000_000 - HOUR_MS,
    );
    // b: due at t=3_000_000
    store.createSchedule(
      { id: "sch_b", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h", fireOnCreate: false },
      3_000_000 - HOUR_MS,
    );
    // c: due in future (10_000_000)
    store.createSchedule(
      { id: "sch_c", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h", fireOnCreate: false },
      10_000_000 - HOUR_MS,
    );
    // d: due now but paused
    store.createSchedule(
      { id: "sch_d", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h" },
      1_000_000,
    );
    store.pauseSchedule("sch_d", 1_000_000);

    const due = store.getDueSchedules(5_000_000);
    expect(due.map((s) => s.id)).toEqual(["sch_a", "sch_b"]);
    store.close();
  });

  test("recordScheduleFire bumps last_fire_at, last_run_id, next_fire_at by interval anchored to now", async () => {
    const store = freshStore(0);
    const sha = await seedWorkflow(store);
    store.createSchedule(
      { id: "sch_x", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h", fireOnCreate: false },
      0,
    );
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, scheduleId: "sch_x" });
    // The proposal: anchor `next_fire_at = now + interval_ms`, NOT
    // `prev_target + interval_ms`. Fire at t=12:03 on a 1h schedule
    // \u2192 next at 13:03, not 13:00.
    const fireAt = HOUR_MS + 3 * 60 * 1000; // "12:03" relative
    store.recordScheduleFire("sch_x", runId, fireAt);

    const after = store.getSchedule("sch_x")!;
    expect(after.lastFireAt).toBe(fireAt);
    expect(after.lastRunId).toBe(runId);
    expect(after.nextFireAt).toBe(fireAt + HOUR_MS);
    store.close();
  });

  test("pauseSchedule sets paused_at; resumeSchedule clears it and re-anchors next_fire_at = now + interval_ms", () => {
    const store = freshStore(0);
    store.createSchedule({ id: "sch_p", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h" }, 0);
    store.pauseSchedule("sch_p", 100);
    const paused = store.getSchedule("sch_p")!;
    expect(paused.pausedAt).toBe(100);

    store.resumeSchedule("sch_p", 500);
    const resumed = store.getSchedule("sch_p")!;
    expect(resumed.pausedAt).toBeNull();
    // No catch-up: re-anchored to now + interval_ms.
    expect(resumed.nextFireAt).toBe(500 + HOUR_MS);
    store.close();
  });

  test("deleteSchedule hard-deletes the row but leaves runs.schedule_id intact", async () => {
    const store = freshStore(0);
    const sha = await seedWorkflow(store);
    store.createSchedule({ id: "sch_dx", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h" }, 0);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, scheduleId: "sch_dx" });

    store.deleteSchedule("sch_dx");
    expect(store.getSchedule("sch_dx")).toBeNull();
    // Run lineage survives.
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.scheduleId).toBe("sch_dx");
    store.close();
  });

  test("listSchedules filters by cwd and orders by created_at ASC", () => {
    const store = freshStore(0);
    store.createSchedule({ id: "sch_1", workflowRef: "wf", cwd: "/a", intervalMs: HOUR_MS, intervalText: "1h" }, 100);
    store.createSchedule({ id: "sch_2", workflowRef: "wf", cwd: "/a", intervalMs: HOUR_MS, intervalText: "1h" }, 200);
    store.createSchedule({ id: "sch_3", workflowRef: "wf", cwd: "/b", intervalMs: HOUR_MS, intervalText: "1h" }, 150);

    const a = store.listSchedules({ cwd: "/a" });
    expect(a.map((s) => s.id)).toEqual(["sch_1", "sch_2"]);
    const b = store.listSchedules({ cwd: "/b" });
    expect(b.map((s) => s.id)).toEqual(["sch_3"]);
    const all = store.listSchedules();
    expect(all.map((s) => s.id)).toEqual(["sch_1", "sch_3", "sch_2"]);
    store.close();
  });

  test("recordScheduleSkipped advances next_fire_at without setting last_fire_at", () => {
    const store = freshStore(0);
    store.createSchedule({ id: "sch_s", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h" }, 0);
    store.recordScheduleSkipped("sch_s", 5_000);
    const s = store.getSchedule("sch_s")!;
    expect(s.lastFireAt).toBeNull();
    expect(s.nextFireAt).toBe(5_000 + HOUR_MS);
    store.close();
  });

  test("lastError surfaces the latest schedule_invalid_workflow audit error while paused, never while active", () => {
    const store = freshStore(0);
    store.createSchedule({ id: "sch_e", workflowRef: "wf", cwd: "/r", intervalMs: HOUR_MS, intervalText: "1h" }, 0);

    // Active with no audit history → null.
    expect(store.getSchedule("sch_e")!.lastError).toBeNull();

    // Dispatcher auto-pause: pause + audit event, like schedule-dispatcher does.
    store.pauseSchedule("sch_e", 1_000);
    store.appendDaemonEvent({
      type: "fact.schedule_invalid_workflow",
      payload: { scheduleId: "sch_e", error: "workflow not found: wf" },
    });
    store.appendDaemonEvent({
      type: "fact.schedule_invalid_workflow",
      payload: { scheduleId: "sch_e", error: "validation failed: E032 step has no successor" },
    });
    // Latest audit row wins; listSchedules carries it too.
    expect(store.getSchedule("sch_e")!.lastError).toBe("validation failed: E032 step has no successor");
    expect(store.listSchedules().find((s) => s.id === "sch_e")!.lastError).toBe(
      "validation failed: E032 step has no successor",
    );

    // Resumed → the stale cause is suppressed.
    store.resumeSchedule("sch_e", 2_000);
    expect(store.getSchedule("sch_e")!.lastError).toBeNull();
    store.close();
  });
});
