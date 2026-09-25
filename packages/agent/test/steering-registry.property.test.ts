// Property-based tests for SteeringRegistry — the concurrency-critical
// per-run slot-management that keeps steer messages from leaking across
// runs on a shared backend, and broadcasts a steer to every in-flight
// branch of a run.
//
// Uses fast-check's stateful `fc.commands` to generate random
// interleavings of begin/end/steer/forget ops across a small pool of
// runIds (so collisions happen often) and assert the invariants below
// hold after every command. beginRun is allowed to fire repeatedly for
// the same runId without an intervening endRun — that IS the fan-out
// case (N concurrent llm branches under one runId).
//
// Invariants:
//   I1  Per-run isolation — every message delivered to an agent came
//       from a steer on that agent's run; no cross-runId leaks.
//   I2  Broadcast — a steer(R, msg) issued while K agents are live for R
//       is delivered to ALL K, and reports `delivered` with K targets.
//   I3  No loss while an agent is alive — if any agent is active for R
//       when steer(R, msg) is called, it's injected immediately.
//   I4  Buffered drain FIFO — messages buffered while no agent was
//       active drain in insertion order into the next beginRun.
//   I5  State shape — activeSize / activeCount / pendingCount match the
//       model; pendingCount > 0 implies a non-empty pending entry.
//   I6  forgetRun is terminal — clears live agents + buffer; subsequent
//       steer starts a fresh buffer.
//   I7  No cross-leak on endRun — ending an agent on run A never touches
//       run B.
//
// The model mirrors expected per-runId state and per-agent delivery. We
// apply every op to both the real registry and the model, then compare.

import { describe, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { MAX_BUFFERED_STEERS, type SteerableAgent, SteeringRegistry } from "../src/steering-registry.ts";

// ---------- Fake agent ----------

class FakeAgent implements SteerableAgent {
  readonly received: string[] = [];
  steer(msg: { content: [{ type: "text"; text: string }] }): void {
    this.received.push(msg.content[0]?.text ?? "");
  }
}

// ---------- Model ----------

interface RunState {
  /** The currently-active agents for this run (empty when none). */
  active: Set<FakeAgent>;
  /** Messages buffered while no agent was active. FIFO. Survives a drain —
   *  it is cleared when the live set empties, so every branch of a fan-out
   *  receives it, not just whichever one won the registration race. */
  buffer: string[];
  /** Agents already handed this buffer, so a branch that ends and
   *  re-dispatches while its siblings are live is not injected twice. */
  drained: Set<FakeAgent>;
}

interface Model {
  runs: Map<string, RunState>;
  /** Per-agent expected delivery stream. */
  expected: Map<FakeAgent, string[]>;
  /** Monotone counter for distinct branch node ids. */
  agentSeq: number;
}

function getRun(m: Model, runId: string): RunState {
  let r = m.runs.get(runId);
  if (r === undefined) {
    r = { active: new Set(), buffer: [], drained: new Set() };
    m.runs.set(runId, r);
  }
  return r;
}

// ---------- Invariant checks (run after every command) ----------

function assertInvariants(model: Model, real: SteeringRegistry): void {
  // I5a — activeSize agreement (runs with ≥1 live agent).
  let modelActiveRuns = 0;
  for (const r of model.runs.values()) if (r.active.size > 0) modelActiveRuns++;
  if (real.activeSize() !== modelActiveRuns) {
    throw new Error(`I5: activeSize mismatch: real=${real.activeSize()} model=${modelActiveRuns}`);
  }

  // I5b — pending shape: any registry-held pending buffer must be non-empty.
  for (const runId of real.pendingRunIds()) {
    if (real.pendingCount(runId) === 0) {
      throw new Error(`I5: pending entry exists for ${runId} with count 0 (empty-array leak)`);
    }
  }

  // Per-run cross-check.
  for (const [runId, r] of model.runs) {
    const realActive = real.hasActive(runId);
    const modelActiveHere = r.active.size > 0;
    if (realActive !== modelActiveHere) {
      throw new Error(`I5: hasActive(${runId}) mismatch: real=${realActive} model=${modelActiveHere}`);
    }
    if (real.activeCount(runId) !== r.active.size) {
      throw new Error(`I5: activeCount(${runId}) mismatch: real=${real.activeCount(runId)} model=${r.active.size}`);
    }
    const realPending = real.pendingCount(runId);
    if (realPending !== r.buffer.length) {
      throw new Error(`I5: pendingCount(${runId}) mismatch: real=${realPending} model=${r.buffer.length}`);
    }
  }

  // I1/I2/I3/I4 — every agent's real delivery stream matches its expected.
  for (const [agent, expected] of model.expected) {
    if (agent.received.join("\x1e") !== expected.join("\x1e")) {
      throw new Error(
        `I1/I2: delivery mismatch: real=${JSON.stringify(agent.received)} model=${JSON.stringify(expected)}`,
      );
    }
  }
}

// ---------- Commands ----------

class BeginRunCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(readonly runId: string) {}
  check(): boolean {
    // Fan-out: multiple concurrent begins on the same runId are legal.
    return true;
  }
  run(m: Model, r: SteeringRegistry): void {
    const agent = new FakeAgent();
    const target = { nodeId: `n${m.agentSeq}`, iteration: 0 };
    m.agentSeq++;
    r.beginRun(this.runId, agent, target);

    const rs = getRun(m, this.runId);
    rs.active.add(agent);
    const expected: string[] = [];
    m.expected.set(agent, expected);
    // I4 — the buffer drains FIFO into each registering agent and SURVIVES,
    // so a sibling branch registering a moment later gets the same messages.
    // A given agent is drained into at most once per non-empty interval.
    if (!rs.drained.has(agent)) {
      rs.drained.add(agent);
      for (const msg of rs.buffer) expected.push(msg);
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
    return getRun(m, this.runId).active.size > 0;
  }
  run(m: Model, r: SteeringRegistry): void {
    const rs = getRun(m, this.runId);
    const agent = [...rs.active][0]!;

    // Snapshot to later assert I7 — other runs untouched.
    const otherActiveBefore = new Map<string, boolean>();
    for (const [id, s] of m.runs) if (id !== this.runId) otherActiveBefore.set(id, s.active.size > 0);

    r.endRun(this.runId, agent);
    rs.active.delete(agent);
    // I8 — the last agent out clears the buffer, so a steer typed during one
    // superstep is never replayed into the next one's agents.
    if (rs.active.size === 0) {
      rs.buffer = [];
      rs.drained = new Set();
    }

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
  check(): boolean {
    return true;
  }
  run(m: Model, r: SteeringRegistry): void {
    const delivery = r.steer(this.runId, this.msg);
    const rs = getRun(m, this.runId);

    if (this.msg === "") {
      // Empty-string steers are dropped per the contract.
      assertInvariants(m, r);
      return;
    }
    if (rs.active.size > 0) {
      // I2/I3 — broadcast to every live agent, immediately.
      for (const agent of rs.active) m.expected.get(agent)!.push(this.msg);
      if (delivery.disposition !== "delivered") {
        throw new Error(`I2: expected delivered, got ${delivery.disposition}`);
      }
      if (delivery.targets.length !== rs.active.size) {
        throw new Error(`I2: targets ${delivery.targets.length} != active ${rs.active.size}`);
      }
    } else {
      rs.buffer.push(this.msg);
      // I9 — the buffer is capped; the oldest go first.
      if (rs.buffer.length > MAX_BUFFERED_STEERS) {
        rs.buffer.splice(0, rs.buffer.length - MAX_BUFFERED_STEERS);
      }
      if (delivery.disposition !== "buffered") {
        throw new Error(`I4: expected buffered, got ${delivery.disposition}`);
      }
    }

    assertInvariants(m, r);
  }
  toString(): string {
    return `steer(${this.runId}, ${JSON.stringify(this.msg)})`;
  }
}

class ForgetRunCmd implements fc.Command<Model, SteeringRegistry> {
  constructor(readonly runId: string) {}
  check(): boolean {
    return true;
  }
  run(m: Model, r: SteeringRegistry): void {
    r.forgetRun(this.runId);

    const rs = getRun(m, this.runId);
    // Forgotten agents keep their frozen delivery history (they can't
    // receive more), so leave `m.expected` alone — just clear live state.
    rs.active = new Set();
    rs.buffer = [];
    rs.drained = new Set();

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
  test("random op sequences preserve isolation and broadcast invariants", () => {
    fc.assert(
      fc.property(fc.commands([commandArb], { maxCommands: 200 }), (cmds) => {
        fc.modelRun(
          () => ({
            model: { runs: new Map<string, RunState>(), expected: new Map<FakeAgent, string[]>(), agentSeq: 0 },
            real: new SteeringRegistry(),
          }),
          cmds,
        );
      }),
      { numRuns: pbtRuns(500) },
    );
  });
});
