// Property tests for foldFanIn — attractor §4.9 heuristic.
//
// Invariants exercised:
//   1. Commutativity  — winner is stable under any input permutation.
//   2. Optimality     — winner minimizes (outcome_rank, -score, branchId).
//   3. allFailed      — true iff non-empty AND every candidate is "fail".
//   4. Preservation   — ranked contains exactly the input candidates (as a
//                       multiset) — nothing invented, nothing dropped.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FAN_IN_VERSION, type FanInCandidate, FanInVersionMismatchError, foldFanIn } from "../../src/engine/fan-in.ts";
import type { OutcomeStatus } from "../../src/types/outcome.ts";

const STATUSES: OutcomeStatus[] = ["success", "partial_success", "retry", "skipped", "fail"];
const STATUS_RANK: Record<OutcomeStatus, number> = {
  success: 0,
  partial_success: 1,
  retry: 2,
  skipped: 3,
  fail: 4,
};

function candidateArb(): fc.Arbitrary<FanInCandidate> {
  const base = fc.record({
    branchId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
    status: fc.constantFrom(...STATUSES),
  });
  const withScore = fc.record({
    branchId: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => s.trim().length > 0),
    status: fc.constantFrom(...STATUSES),
    score: fc.integer({ min: -100, max: 100 }),
  });
  return fc.oneof(base, withScore);
}

/** Candidates with unique branchIds — used when we need a strict total order
 * (no lexical ties) so the ranked comparison is free of ambiguity. */
function uniqueCandidatesArb(): fc.Arbitrary<FanInCandidate[]> {
  return fc.uniqueArray(candidateArb(), {
    minLength: 0,
    maxLength: 12,
    selector: (c) => c.branchId,
  });
}

function shuffle<T>(arr: readonly T[], rng: fc.Arbitrary<number[]>): fc.Arbitrary<T[]> {
  return rng.map((order) => {
    const paired = arr.map((v, i) => ({ v, k: order[i] ?? 0 }));
    paired.sort((a, b) => a.k - b.k);
    return paired.map((p) => p.v);
  });
}

describe("foldFanIn — pure reducer properties", () => {
  test("empty input → winner=null, ranked=[], allFailed=false", () => {
    expect(foldFanIn([])).toEqual({ winner: null, ranked: [], allFailed: false });
  });

  test("single candidate → that candidate is winner", () => {
    fc.assert(
      fc.property(candidateArb(), (c) => {
        const r = foldFanIn([c]);
        expect(r.winner).toEqual(c);
        expect(r.ranked).toEqual([c]);
        expect(r.allFailed).toBe(c.status === "fail");
      }),
    );
  });

  test("commutativity: winner is stable under any permutation", () => {
    fc.assert(
      fc.property(
        uniqueCandidatesArb().chain((cs) =>
          fc.tuple(
            fc.constant(cs),
            shuffle(cs, fc.array(fc.integer(), { minLength: cs.length, maxLength: cs.length })),
          ),
        ),
        ([original, shuffled]) => {
          const a = foldFanIn(original);
          const b = foldFanIn(shuffled);
          expect(b.winner).toEqual(a.winner);
          expect(b.ranked).toEqual(a.ranked);
          expect(b.allFailed).toBe(a.allFailed);
        },
      ),
    );
  });

  test("optimality: winner has minimum (rank, -score, branchId) of all inputs", () => {
    fc.assert(
      fc.property(
        uniqueCandidatesArb().filter((cs) => cs.length > 0),
        (cs) => {
          const { winner } = foldFanIn(cs);
          expect(winner).not.toBeNull();
          const w = winner!;
          for (const c of cs) {
            if (c === w) continue;
            const ordered = compareTriple(w, c);
            // w must be <= every other candidate
            expect(ordered).toBeLessThanOrEqual(0);
          }
        },
      ),
    );
  });

  test("allFailed iff non-empty AND every candidate is fail", () => {
    fc.assert(
      fc.property(uniqueCandidatesArb(), (cs) => {
        const r = foldFanIn(cs);
        const expected = cs.length > 0 && cs.every((c) => c.status === "fail");
        expect(r.allFailed).toBe(expected);
      }),
    );
  });

  test("preservation: ranked is the exact input multiset (nothing invented, nothing dropped)", () => {
    fc.assert(
      fc.property(uniqueCandidatesArb(), (cs) => {
        const r = foldFanIn(cs);
        expect(r.ranked).toHaveLength(cs.length);
        // Same set of branchIds.
        expect(new Set(r.ranked.map((c) => c.branchId))).toEqual(new Set(cs.map((c) => c.branchId)));
      }),
    );
  });

  test("non-fail candidate guarantees allFailed=false", () => {
    fc.assert(
      fc.property(
        uniqueCandidatesArb().filter((cs) => cs.some((c) => c.status !== "fail")),
        (cs) => {
          expect(foldFanIn(cs).allFailed).toBe(false);
        },
      ),
    );
  });

  test("ranked is sorted ascending by (rank, -score, branchId)", () => {
    fc.assert(
      fc.property(uniqueCandidatesArb(), (cs) => {
        const r = foldFanIn(cs);
        for (let i = 1; i < r.ranked.length; i++) {
          const cmp = compareTriple(r.ranked[i - 1]!, r.ranked[i]!);
          expect(cmp).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe("foldFanIn — fixed examples anchoring the rank order", () => {
  test("success beats partial_success beats retry beats skipped beats fail", () => {
    const cs: FanInCandidate[] = [
      { branchId: "a", status: "fail" },
      { branchId: "b", status: "skipped" },
      { branchId: "c", status: "retry" },
      { branchId: "d", status: "partial_success" },
      { branchId: "e", status: "success" },
    ];
    const r = foldFanIn(cs);
    expect(r.ranked.map((c) => c.status)).toEqual(["success", "partial_success", "retry", "skipped", "fail"]);
  });

  test("score tiebreak within same status (higher score wins)", () => {
    const cs: FanInCandidate[] = [
      { branchId: "a", status: "success", score: 5 },
      { branchId: "b", status: "success", score: 10 },
      { branchId: "c", status: "success", score: 1 },
    ];
    expect(foldFanIn(cs).winner?.branchId).toBe("b");
  });

  test("lexical tiebreak when status and score tie", () => {
    const cs: FanInCandidate[] = [
      { branchId: "zz", status: "success", score: 0 },
      { branchId: "aa", status: "success", score: 0 },
      { branchId: "mm", status: "success", score: 0 },
    ];
    expect(foldFanIn(cs).winner?.branchId).toBe("aa");
  });

  test("all-fail → allFailed=true, winner is lexically smallest", () => {
    const cs: FanInCandidate[] = [
      { branchId: "c", status: "fail" },
      { branchId: "a", status: "fail" },
      { branchId: "b", status: "fail" },
    ];
    const r = foldFanIn(cs);
    expect(r.allFailed).toBe(true);
    expect(r.winner?.branchId).toBe("a");
  });
});

describe("foldFanIn — algorithm version pinning", () => {
  test("FAN_IN_VERSION is a positive integer that survives import-time", () => {
    expect(FAN_IN_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(FAN_IN_VERSION)).toBe(true);
  });

  test("explicit v1 matches the default (current implementation)", () => {
    const cs: FanInCandidate[] = [
      { branchId: "a", status: "fail" },
      { branchId: "b", status: "success", score: 0.5 },
    ];
    expect(foldFanIn(cs)).toEqual(foldFanIn(cs, 1));
    expect(foldFanIn(cs, 1).winner?.branchId).toBe("b");
  });

  test("undefined / 0 version coerces to v1 (pre-pinning replays)", () => {
    const cs: FanInCandidate[] = [{ branchId: "x", status: "success" }];
    expect(foldFanIn(cs, undefined).winner?.branchId).toBe("x");
    expect(foldFanIn(cs, 0).winner?.branchId).toBe("x");
  });

  test("unknown version throws FanInVersionMismatchError with the known list", () => {
    const cs: FanInCandidate[] = [{ branchId: "x", status: "success" }];
    expect(() => foldFanIn(cs, 999)).toThrow(FanInVersionMismatchError);
    try {
      foldFanIn(cs, 999);
    } catch (err) {
      expect(err).toBeInstanceOf(FanInVersionMismatchError);
      expect((err as FanInVersionMismatchError).requested).toBe(999);
      expect((err as FanInVersionMismatchError).known).toContain(1);
    }
  });
});

/** Compare (rank, -score, branchId). Returns <0 if a precedes b, 0 if tied. */
function compareTriple(a: FanInCandidate, b: FanInCandidate): number {
  const ra = STATUS_RANK[a.status];
  const rb = STATUS_RANK[b.status];
  if (ra !== rb) return ra - rb;
  const sa = a.score ?? 0;
  const sb = b.score ?? 0;
  if (sa !== sb) return sb - sa;
  return a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0;
}
