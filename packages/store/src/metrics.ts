// Process-local metrics for the store's write path.
//
// Counters and timings live in-memory and are snapshotted by the HTTP
// layer on demand. No histogram libraries — just a rolling reservoir
// for p50 / p99 approximations so tests can assert on them without
// dragging in a dep.

export interface MetricsSnapshot {
  writes: number;
  intents: number;
  facts: number;
  occConflicts: number;
  /** Last N write durations in ms, newest last. */
  writeDurationsMs: number[];
  p50WriteMs: number;
  p99WriteMs: number;
  totalWriteMs: number;
  /** Time spent waiting for `BEGIN IMMEDIATE` to acquire the write lock,
   * per write. Reservoir-sampled. Under load, this is the leading
   * indicator of contention — if `p99LockWaitMs` climbs while
   * `p99WriteMs` doesn't, two writers are racing for the same lock and
   * `busy_timeout` is absorbing the cost silently. */
  lockWaitDurationsMs: number[];
  p50LockWaitMs: number;
  p99LockWaitMs: number;
  totalLockWaitMs: number;
  uptimeMs: number;
}

const RESERVOIR_CAP = 512;

export class Metrics {
  private writes = 0;
  private intents = 0;
  private facts = 0;
  private occConflicts = 0;
  private durations: number[] = [];
  private lockWaits: number[] = [];
  private totalMs = 0;
  private totalLockWaitMs = 0;
  private readonly startedAt = Date.now();

  recordWrite(durationMs: number, kind: "fact" | "intent"): void {
    this.writes++;
    if (kind === "fact") this.facts++;
    else this.intents++;
    this.totalMs += durationMs;
    this.durations.push(durationMs);
    if (this.durations.length > RESERVOIR_CAP) this.durations.shift();
  }

  recordOccConflict(): void {
    this.occConflicts++;
  }

  /** Record the time `BEGIN IMMEDIATE` spent acquiring the write lock.
   * Called by every store write path; surfaces in MetricsSnapshot as
   * `p99LockWaitMs` so an operator can see contention before tail
   * latency on writes blows up. */
  recordLockWait(durationMs: number): void {
    this.totalLockWaitMs += durationMs;
    this.lockWaits.push(durationMs);
    if (this.lockWaits.length > RESERVOIR_CAP) this.lockWaits.shift();
  }

  snapshot(): MetricsSnapshot {
    const sortedW = [...this.durations].sort((a, b) => a - b);
    const sortedL = [...this.lockWaits].sort((a, b) => a - b);
    return {
      writes: this.writes,
      intents: this.intents,
      facts: this.facts,
      occConflicts: this.occConflicts,
      writeDurationsMs: [...this.durations],
      p50WriteMs: percentile(sortedW, 0.5),
      p99WriteMs: percentile(sortedW, 0.99),
      totalWriteMs: this.totalMs,
      lockWaitDurationsMs: [...this.lockWaits],
      p50LockWaitMs: percentile(sortedL, 0.5),
      p99LockWaitMs: percentile(sortedL, 0.99),
      totalLockWaitMs: this.totalLockWaitMs,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  reset(): void {
    this.writes = 0;
    this.intents = 0;
    this.facts = 0;
    this.occConflicts = 0;
    this.durations = [];
    this.lockWaits = [];
    this.totalMs = 0;
    this.totalLockWaitMs = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}
