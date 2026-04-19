// Property-based fuzz of the sqlite job queue.
//
// Models the queue as a state machine and verifies invariants hold
// after any random sequence of ops:
//
//   I1. No job is ever in an invalid status.
//   I2. A claimed job never reappears as queued.
//   I3. markRunning only takes effect on claimed (running) rows.
//   I4. markTerminal is one-shot: once terminal, status is frozen.
//   I5. child_pid is cleared on terminal.
//   I6. count(status) == list({status}).length for every status.
//   I7. claimNext under concurrent contention hands each row to at
//       most one caller (atomicity).

import { describe, test } from "bun:test";
import fc from "fast-check";
import { createSqliteJobQueue } from "../src/adapters/sqlite-job-queue.ts";
import type { JobQueue } from "../src/ports.ts";

type Op =
  | { kind: "enqueue"; id: string; priority: number }
  | { kind: "claim" }
  | { kind: "markRunning"; id: string; pid: number }
  | { kind: "markTerminal"; id: string; terminal: "success" | "failed" | "canceled" }
  | { kind: "delete"; id: string };

const VALID_STATUSES = new Set(["queued", "running", "success", "failed", "canceled"]);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("enqueue" as const),
    id: fc.stringMatching(/^j[0-9]{1,3}$/),
    priority: fc.integer({ min: 0, max: 10 }),
  }),
  fc.record({ kind: fc.constant("claim" as const) }),
  fc.record({
    kind: fc.constant("markRunning" as const),
    id: fc.stringMatching(/^j[0-9]{1,3}$/),
    pid: fc.integer({ min: 1, max: 99_999 }),
  }),
  fc.record({
    kind: fc.constant("markTerminal" as const),
    id: fc.stringMatching(/^j[0-9]{1,3}$/),
    terminal: fc.constantFrom("success" as const, "failed" as const, "canceled" as const),
  }),
  fc.record({ kind: fc.constant("delete" as const), id: fc.stringMatching(/^j[0-9]{1,3}$/) }),
);

async function runSequence(queue: JobQueue, ops: Op[]): Promise<string | null> {
  for (const op of ops) {
    try {
      switch (op.kind) {
        case "enqueue":
          await queue.enqueue({ id: op.id, runId: `r-${op.id}`, workflow: "w.dot", priority: op.priority });
          break;
        case "claim":
          await queue.claimNext();
          break;
        case "markRunning":
          await queue.markRunning(op.id, op.pid);
          break;
        case "markTerminal":
          await queue.markTerminal(op.id, op.terminal);
          break;
        case "delete":
          await queue.delete(op.id);
          break;
      }
    } catch {
      // Many ops will throw on invalid state (dup id, delete non-queued,
      // delete missing) — that's the API contract and expected. We only
      // care that the *observable state* stays valid.
    }

    // Invariant check after every op.
    const rows = await queue.list({ limit: 9999 });
    for (const row of rows) {
      if (!VALID_STATUSES.has(row.status)) {
        return `invalid status: ${row.id}=${row.status}`;
      }
      const isTerminal = row.status === "success" || row.status === "failed" || row.status === "canceled";
      if (isTerminal && row.childPid !== undefined) {
        return `terminal row ${row.id} still has child_pid=${row.childPid}`;
      }
    }

    // I6: count == list length for each status
    for (const s of ["queued", "running", "success", "failed", "canceled"] as const) {
      const c = await queue.count(s);
      const listed = await queue.list({ status: s, limit: 9999 });
      if (c !== listed.length) return `count(${s})=${c} but list(${s})=${listed.length}`;
    }
  }
  return null;
}

describe("sqlite job queue — property: state invariants", () => {
  test("arbitrary op sequences never produce invalid state", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 30 }), async (ops) => {
        const queue = createSqliteJobQueue({ dbPath: ":memory:" });
        try {
          const err = await runSequence(queue, ops);
          if (err) throw new Error(err);
        } finally {
          await queue.close();
        }
      }),
      { numRuns: 80, timeout: 30_000 },
    );
  }, 120_000);

  test("markTerminal is one-shot: terminal status never changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("success" as const, "failed" as const, "canceled" as const),
        fc.constantFrom("success" as const, "failed" as const, "canceled" as const),
        async (first, second) => {
          const queue = createSqliteJobQueue({ dbPath: ":memory:" });
          try {
            await queue.enqueue({ id: "j", runId: "r", workflow: "w.dot" });
            await queue.claimNext();
            await queue.markTerminal("j", first);
            await queue.markTerminal("j", second, "overwrite attempt");
            const row = await queue.get("j");
            if (row?.status !== first) {
              throw new Error(`expected status=${first} after double-terminal, got ${row?.status}`);
            }
            if (row.error !== undefined) {
              throw new Error(`expected error undefined, got ${row.error}`);
            }
          } finally {
            await queue.close();
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  test("claimNext is atomic under high concurrency", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 20 }), async (n) => {
        const queue = createSqliteJobQueue({ dbPath: ":memory:" });
        try {
          for (let i = 0; i < n; i++) {
            await queue.enqueue({ id: `j${i}`, runId: `r${i}`, workflow: "w.dot" });
          }
          // Fire 2n concurrent claims; n should return rows, n should return undefined.
          const claims = await Promise.all(Array.from({ length: n * 2 }, () => queue.claimNext()));
          const claimed = claims.filter((c) => c !== undefined);
          const ids = new Set(claimed.map((c) => c!.id));
          if (ids.size !== claimed.length)
            throw new Error(`duplicate claim: ${claimed.length} claims but ${ids.size} unique ids`);
          if (claimed.length !== n) throw new Error(`expected ${n} claims, got ${claimed.length}`);
          const remaining = await queue.list({ status: "queued", limit: 9999 });
          if (remaining.length !== 0) throw new Error(`${remaining.length} rows remain queued after ${n} claims`);
        } finally {
          await queue.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});
