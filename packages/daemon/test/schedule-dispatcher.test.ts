// Schedule dispatcher \u2014 tick-level coverage of the proposal's per-row
// decision tree. We drive the synchronous `scheduleDispatcherTick`
// directly so tests don't depend on real timers.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConcurrencyError,
  type FactEvent,
  type IEventStore,
  isTerminal as isTerminalStatus,
  SqliteStore,
} from "@swarm/store";
import { scheduleDispatcherTick } from "../src/schedule-dispatcher.ts";

const HOUR_MS = 60 * 60 * 1000;
const TRIVIAL_YAML = "name: t\nsteps:\n  work: {type: llm, prompt: x}\n";

interface Fixture {
  store: SqliteStore;
  homeDir: string;
  cwd: string;
  cleanup: () => void;
  now: number;
  setNow: (t: number) => void;
  /** Write `<homeDir>/.swarm/workflows/<name>.yaml` with the given source. */
  writeWorkflow: (name: string, yamlSource?: string) => string;
  tick: () => { fired: number; skipped: number; paused: number };
  freshRunId: () => string;
}

function newFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "sched-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "sched-cwd-"));
  mkdirSync(join(home, ".swarm/workflows"), { recursive: true });
  let now = 1_000_000;
  const store = new SqliteStore({ path: ":memory:", now: () => now });

  let runIdCounter = 0;
  const freshRunId = (): string => `run_${++runIdCounter}`;

  return {
    store,
    homeDir: home,
    cwd,
    get now() {
      return now;
    },
    setNow: (t) => {
      now = t;
    },
    writeWorkflow: (name, yamlSource) => {
      const path = join(home, ".swarm/workflows", `${name}.yaml`);
      writeFileSync(path, yamlSource ?? TRIVIAL_YAML);
      return path;
    },
    tick: () => {
      return scheduleDispatcherTick({
        store,
        shutdownSignal: new AbortController().signal,
        now: () => now,
        homeDir: home,
        newRunId: freshRunId,
      });
    },
    freshRunId,
    cleanup: () => {
      store.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

let f: Fixture;

beforeEach(() => {
  f = newFixture();
});

afterEach(() => {
  f.cleanup();
});

describe("schedule-dispatcher", () => {
  test("fires immediately on create when fireOnCreate=true and enqueues a run carrying scheduleId", () => {
    f.writeWorkflow("analyze", TRIVIAL_YAML);
    f.store.createSchedule(
      {
        id: "sch_a",
        workflowRef: "analyze",
        cwd: f.cwd,
        intervalMs: HOUR_MS,
        intervalText: "1h",
      },
      f.now,
    );

    const out = f.tick();
    expect(out.fired).toBe(1);
    expect(out.skipped).toBe(0);
    expect(out.paused).toBe(0);

    const sched = f.store.getSchedule("sch_a")!;
    expect(sched.lastRunId).not.toBeNull();
    expect(sched.lastFireAt).toBe(f.now);
    expect(sched.nextFireAt).toBe(f.now + HOUR_MS);

    const state = f.store.getState(sched.lastRunId!);
    expect(state).not.toBeNull();
    expect(state!.scheduleId).toBe("sch_a");
    expect(state!.cwd).toBe(f.cwd);

    const events = f.store.getDaemonEvents({}).map((e) => e.type);
    expect(events).toContain("fact.schedule_fired");
  });

  test("skips fire when overlap_policy=skip and last_run_id is non-terminal; advances next_fire_at", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    // Manually seed a non-terminal prior run via the store API.
    const sha = "wf_sha_seed";
    f.store.saveWorkflow(sha, "wf", TRIVIAL_YAML);
    const priorRun = "run_prior";
    f.store.enqueueRun({ runId: priorRun, workflowSha: sha, scheduleId: "sch_o" });
    expect(isTerminalStatus(f.store.getState(priorRun)!.status)).toBe(false);

    f.store.createSchedule(
      { id: "sch_o", workflowRef: "wf", cwd: f.cwd, intervalMs: HOUR_MS, intervalText: "1h" },
      f.now,
    );
    // Wire the schedule to the prior run by recording a fake fire.
    f.store.recordScheduleFire("sch_o", priorRun, f.now);
    // Advance into the next due slot.
    f.setNow(f.now + HOUR_MS);

    const before = f.store.getSchedule("sch_o")!;
    const expectedNext = f.now + HOUR_MS;

    const out = f.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(1);

    const after = f.store.getSchedule("sch_o")!;
    expect(after.nextFireAt).toBe(expectedNext);
    expect(after.lastRunId).toBe(priorRun); // unchanged
    expect(after.lastFireAt).toBe(before.lastFireAt); // unchanged

    const skipped = f.store.getDaemonEvents({}).filter((e) => e.type === "fact.schedule_skipped");
    expect(skipped.length).toBe(1);
    expect((skipped[0]!.payload as { reason: string }).reason).toBe("overlap");
  });

  test("queue overlap policy fires regardless of in-flight last run", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    const sha = "wf_sha_q";
    f.store.saveWorkflow(sha, "wf", TRIVIAL_YAML);
    const priorRun = "run_prior_q";
    f.store.enqueueRun({ runId: priorRun, workflowSha: sha });

    f.store.createSchedule(
      {
        id: "sch_q",
        workflowRef: "wf",
        cwd: f.cwd,
        intervalMs: HOUR_MS,
        intervalText: "1h",
        overlapPolicy: "queue",
      },
      f.now,
    );
    f.store.recordScheduleFire("sch_q", priorRun, f.now);
    f.setNow(f.now + HOUR_MS);

    const out = f.tick();
    expect(out.fired).toBe(1);

    const sched = f.store.getSchedule("sch_q")!;
    expect(sched.lastRunId).not.toBe(priorRun); // a fresh run was minted
  });

  test("emits fact.schedule_late with missedIntervals when next_fire_at is multiple intervals stale", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    f.store.createSchedule(
      {
        id: "sch_l",
        workflowRef: "wf",
        cwd: f.cwd,
        intervalMs: HOUR_MS,
        intervalText: "1h",
        fireOnCreate: false,
      },
      f.now,
    );
    // Pin next_fire_at to "5h ago" by advancing now without ticking.
    const targetAt = f.now + HOUR_MS; // create's next_fire_at
    f.setNow(targetAt + 5 * HOUR_MS); // 5 missed slots

    const out = f.tick();
    expect(out.fired).toBe(1);

    const lateEvents = f.store.getDaemonEvents({}).filter((e) => e.type === "fact.schedule_late");
    expect(lateEvents.length).toBe(1);
    const payload = lateEvents[0]!.payload as { missedIntervals: number; lastTargetAt: number };
    expect(payload.missedIntervals).toBe(5);
    expect(payload.lastTargetAt).toBe(targetAt);
    // At-most-one fire per resume window: the next fire is one interval out, anchored to actual fire time.
    const sched = f.store.getSchedule("sch_l")!;
    expect(sched.nextFireAt).toBe(f.now + HOUR_MS);
  });

  test("auto-pauses on workflow file missing and emits fact.schedule_invalid_workflow", () => {
    // Don't write any workflow file.
    f.store.createSchedule(
      {
        id: "sch_miss",
        workflowRef: "nope-not-here",
        cwd: f.cwd,
        intervalMs: HOUR_MS,
        intervalText: "1h",
      },
      f.now,
    );

    const out = f.tick();
    expect(out.fired).toBe(0);
    expect(out.paused).toBe(1);

    const sched = f.store.getSchedule("sch_miss")!;
    expect(sched.pausedAt).toBe(f.now);

    const events = f.store.getDaemonEvents({}).filter((e) => e.type === "fact.schedule_invalid_workflow");
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { error: string }).error).toMatch(/not found/);
  });

  test("auto-pauses when YAML source fails to parse", () => {
    f.writeWorkflow("broken", "this is not valid yaml: : :{{{");
    f.store.createSchedule(
      {
        id: "sch_bad",
        workflowRef: "broken",
        cwd: f.cwd,
        intervalMs: HOUR_MS,
        intervalText: "1h",
      },
      f.now,
    );

    const out = f.tick();
    expect(out.paused).toBe(1);
    expect(f.store.getSchedule("sch_bad")!.pausedAt).toBe(f.now);

    const events = f.store.getDaemonEvents({}).filter((e) => e.type === "fact.schedule_invalid_workflow");
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { error: string }).error).toMatch(/parse failed/);
  });

  test("paused schedules are not surfaced by getDueSchedules", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    f.store.createSchedule(
      { id: "sch_p", workflowRef: "wf", cwd: f.cwd, intervalMs: HOUR_MS, intervalText: "1h" },
      f.now,
    );
    f.store.pauseSchedule("sch_p", f.now);

    const out = f.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(0);
    expect(out.paused).toBe(0);
  });

  test("transient run failure does not pause the schedule", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    f.store.createSchedule(
      { id: "sch_t", workflowRef: "wf", cwd: f.cwd, intervalMs: HOUR_MS, intervalText: "1h" },
      f.now,
    );

    f.tick();
    const sched1 = f.store.getSchedule("sch_t")!;
    expect(sched1.lastRunId).not.toBeNull();

    // Simulate the prior run halting (terminal failure).
    appendTerminalFailure(f.store, sched1.lastRunId!);
    expect(isTerminalStatus(f.store.getState(sched1.lastRunId!)!.status)).toBe(true);

    // Advance a full interval and tick again.
    f.setNow(f.now + HOUR_MS);
    const out = f.tick();
    expect(out.fired).toBe(1);
    expect(f.store.getSchedule("sch_t")!.pausedAt).toBeNull();
  });

  test("wall-clock backwards jump leaves the schedule waiting (no double-fire)", () => {
    f.writeWorkflow("wf", TRIVIAL_YAML);
    f.store.createSchedule(
      { id: "sch_back", workflowRef: "wf", cwd: f.cwd, intervalMs: HOUR_MS, intervalText: "1h" },
      f.now,
    );
    f.tick(); // fires once
    expect(f.store.getSchedule("sch_back")!.lastFireAt).toBe(f.now);

    // Clock jumps backward 30m (NTP correction, suspend).
    f.setNow(f.now - 30 * 60 * 1000);
    const out = f.tick();
    expect(out.fired).toBe(0);
    expect(out.skipped).toBe(0);
  });
});

/** Walk a run to a halted-terminal state so the next tick treats the
 *  prior run as completed. We use `fact.run_started` + `fact.run_halted`
 *  via the store's own appendFact path so OCC, version bumps, and
 *  reducer transitions all line up. */
function appendTerminalFailure(store: IEventStore, runId: string): void {
  const state = store.getState(runId);
  if (state == null) throw new Error(`unknown run ${runId}`);
  // First started, then halted \u2014 reducer requires running before halt.
  let v = state.version;
  try {
    const r = store.appendFact(
      runId,
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: state.workflowSha, schemaVersion: state.schemaVersion, startNode: "a" },
        } as FactEvent,
      ],
      v,
    );
    v = r.newVersion;
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err;
  }
  store.appendFact(runId, [{ type: "fact.run_halted", payload: { reason: "error", detail: "test" } } as FactEvent], v);
}
