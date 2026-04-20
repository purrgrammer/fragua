// Property-based tests for SteeringRegistry — the concurrency-critical
// per-run slot-management that keeps steer messages from leaking across
// runs on a shared backend.
//
// Uses fast-check's stateful `fc.commands` to generate random
// interleavings of begin/end/steer/forget ops across a small pool of
// runIds (so collisions happen often) and assert the invariants below
// hold after every command.
//
// Invariants (from the plan in ~/.claude/plans/):
//   I1  Per-run isolation — every message delivered to agent-R came
//       from a steer(R, _) call; no cross-runId leaks.
//   I2  At-most-once — each steer(R, msg) is delivered to at most one
//       agent across the lifetime of run R.
//   I3  No loss while agent alive — if an agent is active for R when
//       steer(R, msg) is called, it's injected immediately.
//   I4  Buffered drain FIFO — messages buffered while no agent was
//       active drain in insertion order into the next beginRun.
//   I5  State shape — activeSize matches model; pendingCount > 0
//       implies a non-empty pending entry (no empty arrays leak).
//   I6  forgetRun is terminal — clears both slots; subsequent steer
//       starts a fresh buffer.
//   I7  No cross-leak on endRun — ending run A never clears run B.
//
// The model is a plain Map mirroring expected per-runId state. We apply
// every op to both the real registry and the model, then compare.

import { describe, test } from "bun:test";
import fc from "fast-check";
import { type SteerableAgent, SteeringRegistry } from "../src/steering-registry.ts";

// ---------- Fake agent ----------

class FakeAgent implements SteerableAgent {
  readonly received: string[] = [];
  steer(msg: { content: [{ type: "text"; text: string }] }): void {
    this.received.push(msg.content[0]?.text ?? "");
  }
}

// ---------- Model ----------

interface RunState {
  /** The currently-active agent for this run (null when none). */
  active: FakeAgent | null;
  /** Messages buffered while no agent was active. FIFO. */
  buffer: string[];
  /** Everything ever delivered to agents associated with this run. */
  delivered: string[];
}

interface Model {
  runs: Map<string, RunState>;
  /** All agents ever created, indexed so commands can refer back by
   * index. Lets us model-check that a second beginRun on the same runId
   * can only happen after an endRun. */
  agents: FakeAgent[];
}

function getRun(m: Model, runId: string): RunState {
  let r = m.runs.get(runId);
  if (r === undefined) {
    r = { active: null, buffer: [], delivered: [] };
    m.runs.set(runId, r);
  }
  return r;
}

// ---------- Invariant checks (run after every command) ----------

function assertInvariants(model: Model, real: SteeringRegistry): void {
  // I5a — activeSize agreement.
  let modelActive = 0;
  for (const r of model.runs.values()) if (r.active !== null) modelActive++;
  if (real.activeSize() !== modelActive) {
    throw new Error(`I5: activeSize mismatch: real=${real.activeSize()} model=${modelActive}`);
  }

  // I5b — pending shape: any registry-held pending buffer must be non-empty.
  for (const runId of real.pendingRunIds()) {
    if (real.pendingCount(runId) === 0) {
      throw new Error(`I5: pending entry exists for ${runId} with count 0 (empty-array leak)`);
    }
  }

  // Per-run cross-check.
  for (const [runId, r] of model.runs) {
    // Active slot parity.
    const realActive = real.hasActive(runId);
    const modelActiveHere = r.active !== null;
    if (realActive !== modelActiveHere) {
      throw new Error(`I5: hasActive(${runId}) mismatch: real=${realActive} model=${modelActiveHere}`);
    }

    // Pending size parity.
    const realPending = real.pendingCount(runId);
    if (realPending !== r.buffer.length) {
      throw new Error(`I5: pendingCount(${runId}) mismatch: real=${realPending} model=${r.buffer.length}`);
    }

    // I1+I2 — the delivered stream on the active agent exactly matches
    // the model's `delivered` record (which we only ever append to via
    // the run's own steers or buffer drains).
    if (r.active !== null) {
      const tail = r.delivered.slice(r.delivered.length - r.active.received.length);
      if (r.active.received.join("\x1e") !== tail.join("\x1e")) {
        throw new Error(`I1/I2: delivered-tail mismatch for ${runId}`);
      }
    }
  }
}

// ---------- Commands ----------

class BeginRunCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(readonly runId: string) {}
  check(m: Model): boolean {
    // beginRun only makes sense when nothing is active for this runId.
    // (A second concurrent beginRun on the same runId would be a bug in
    // the caller, and we don't want to test that pathology here — the
    // class is defensive but the contract is "begin then end".)
    return getRun(m, this.runId).active === null;
  }
  run(m: Model, r: SteeringRegistry): void {
    const agent = new FakeAgent();
    m.agents.push(agent);
    r.beginRun(this.runId, agent);

    const rs = getRun(m, this.runId);
    rs.active = agent;
    // I4 — drain buffer FIFO into this agent.
    if (rs.buffer.length > 0) {
      for (const msg of rs.buffer) rs.delivered.push(msg);
      rs.buffer = [];
    }

    assertInvariants(m, r);
  }
  toString(): string {
    return `beginRun(${this.runId})`;
  }
}

class EndRunCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(readonly runId: string) {}
  check(m: Model): boolean {
    return getRun(m, this.runId).active !== null;
  }
  run(m: Model, r: SteeringRegistry): void {
    const rs = getRun(m, this.runId);
    // Snapshot to later assert I7 — other runs untouched.
    const otherActiveBefore = new Map<string, boolean>();
    for (const [id, s] of m.runs) if (id !== this.runId) otherActiveBefore.set(id, s.active !== null);

    r.endRun(this.runId, rs.active!);
    rs.active = null;

    for (const [id, wasActive] of otherActiveBefore) {
      if (r.hasActive(id) !== wasActive) {
        throw new Error(`I7: endRun(${this.runId}) affected run ${id}`);
      }
    }

    assertInvariants(m, r);
  }
  toString(): string {
    return `endRun(${this.runId})`;
  }
}

class SteerCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(
    readonly runId: string,
    readonly msg: string,
  ) {}
  check(_m: Model): boolean {
    return true;
  }
  run(m: Model, r: SteeringRegistry): void {
    r.steer(this.runId, this.msg);

    const rs = getRun(m, this.runId);
    if (this.msg === "") {
      // Empty-string steers are dropped per the contract.
      assertInvariants(m, r);
      return;
    }
    if (rs.active !== null) {
      // I3 — injected immediately.
      rs.delivered.push(this.msg);
    } else {
      rs.buffer.push(this.msg);
    }

    assertInvariants(m, r);
  }
  toString(): string {
    return `steer(${this.runId}, ${JSON.stringify(this.msg)})`;
  }
}

class ForgetRunCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(readonly runId: string) {}
  check(_m: Model): boolean {
    return true;
  }
  run(m: Model, r: SteeringRegistry): void {
    r.forgetRun(this.runId);

    const rs = getRun(m, this.runId);
    rs.active = null;
    rs.buffer = [];
    // I6 — leave `delivered` alone (history of what was delivered before
    // forgetRun is still a historical fact; it just can't be added to
    // until a new beginRun/steer cycle).

    assertInvariants(m, r);
  }
  toString(): string {
    return `forgetRun(${this.runId})`;
  }
}

// ---------- Arbitraries ----------

const runIdArb = fc.constantFrom("R1", "R2", "R3", "R4");
const msgArb = fc.oneof(
  // Empty strings exercise the drop-path.
  fc.constant(""),
  fc.string({ minLength: 1, maxLength: 12 }).filter((s) => !s.includes("\x1e")),
);

const commandArb = fc.oneof(
  runIdArb.map((runId) => new BeginRunCmd(runId)),
  runIdArb.map((runId) => new EndRunCmd(runId)),
  fc.tuple(runIdArb, msgArb).map(([runId, msg]) => new SteerCmd(runId, msg)),
  runIdArb.map((runId) => new ForgetRunCmd(runId)),
);

// ---------- The test ----------

describe("SteeringRegistry — properties", () => {
  test("random op sequences preserve the concurrency invariants", () => {
    fc.assert(
      fc.property(fc.commands([commandArb], { maxCommands: 200 }), (cmds) => {
        fc.modelRun(
          () => ({
            model: { runs: new Map<string, RunState>(), agents: [] },
            real: new SteeringRegistry(),
          }),
          cmds,
        );
      }),
      { numRuns: 500 },
    );
  });
});
