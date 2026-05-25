// The `fragua ci` drive loop. These script the `CiDriveDeps` seam directly —
// no store, no executor — to lock the one behaviour the loop owns: it CONTINUES
// the `paused_auto` arm (honouring the auto-resume timer, then re-claiming),
// and only STOPS on a terminal state or an unanswerable pause.

import { describe, expect, test } from "bun:test";
import type { RunStatus } from "@fragua/types";
import { type CiDriveDeps, driveCiRun } from "../src/ci-drive.ts";

/** A scripted run as a linear sequence of ticks. On each tick the loop sees
 * `status`; `claimAndDispatch` drives the run iff `dispatched`. Whichever of
 * dispatch or auto-resume-sleep fires advances to the next entry — so the
 * script reads top-to-bottom as the run's progression. */
interface Step {
  status: RunStatus;
  dispatched: boolean;
  /** auto_resume_at reported while parked in `paused_auto`. */
  resumeAt?: number;
}

function harness(steps: Step[]): {
  deps: CiDriveDeps;
  log: { wakes: number; dispatches: number; sleeps: (number | undefined)[] };
} {
  let i = 0;
  const log = { wakes: 0, dispatches: 0, sleeps: [] as (number | undefined)[] };
  const at = () => steps[Math.min(i, steps.length - 1)]!;
  const deps: CiDriveDeps = {
    shutdownSignal: new AbortController().signal,
    wake: () => {
      log.wakes++;
    },
    claimAndDispatch: async () => {
      if (!at().dispatched) return false;
      log.dispatches++;
      i++;
      return true;
    },
    status: () => at().status,
    autoResumeAt: () => at().resumeAt,
    sleepUntil: async (wakeAt) => {
      log.sleeps.push(wakeAt);
      i++; // the timer elapsing advances the script
    },
  };
  return { deps, log };
}

describe("driveCiRun", () => {
  test("a single dispatch to a terminal status returns", async () => {
    const { deps, log } = harness([
      { status: "running", dispatched: true },
      { status: "completed", dispatched: false },
    ]);
    await driveCiRun(deps);
    expect(log.dispatches).toBe(1);
    expect(log.sleeps).toEqual([]);
  });

  test("CONTINUES paused_auto: honours the timer, then re-claims to terminal", async () => {
    const steps: Step[] = [
      { status: "paused_auto", dispatched: false, resumeAt: 5000 },
      { status: "running", dispatched: true },
      { status: "completed", dispatched: false },
    ];
    const { deps, log } = harness(steps);
    await driveCiRun(deps);
    expect(log.sleeps).toEqual([5000]); // honoured the auto_resume_at backoff
    expect(log.dispatches).toBe(1); // re-claimed after the timer
    expect(log.wakes).toBeGreaterThanOrEqual(2); // wake() ran on every tick
  });

  test("rides multiple paused_auto cycles before completing", async () => {
    const steps: Step[] = [
      { status: "paused_auto", dispatched: false, resumeAt: 100 },
      { status: "paused_auto", dispatched: false, resumeAt: 200 },
      { status: "running", dispatched: true },
      { status: "completed", dispatched: false },
    ];
    const { deps, log } = harness(steps);
    await driveCiRun(deps);
    expect(log.sleeps).toEqual([100, 200]);
    expect(log.dispatches).toBe(1);
  });

  test("STOPS on paused_human (HITL) without dispatching or sleeping", async () => {
    const { deps, log } = harness([{ status: "paused_human", dispatched: false }]);
    await driveCiRun(deps);
    expect(log.dispatches).toBe(0);
    expect(log.sleeps).toEqual([]);
  });

  test("STOPS on paused (operator action)", async () => {
    const { deps, log } = harness([{ status: "paused", dispatched: false }]);
    await driveCiRun(deps);
    expect(log.dispatches).toBe(0);
    expect(log.sleeps).toEqual([]);
  });

  test("STOPS on quarantined", async () => {
    const { deps, log } = harness([{ status: "quarantined", dispatched: false }]);
    await driveCiRun(deps);
    expect(log.dispatches).toBe(0);
    expect(log.sleeps).toEqual([]);
  });

  test("a fired shutdown signal returns before doing any work", async () => {
    const { deps, log } = harness([{ status: "running", dispatched: true }]);
    const ac = new AbortController();
    ac.abort();
    deps.shutdownSignal = ac.signal;
    await driveCiRun(deps);
    expect(log.wakes).toBe(0);
    expect(log.dispatches).toBe(0);
  });
});
