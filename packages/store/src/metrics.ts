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
  uptimeMs: number;
}

const RESERVOIR_CAP = 512;

export class Metrics {
  private writes = 0;
  private intents = 0;
  private facts = 0;
  private occConflicts = 0;
  private durations: number[] = [];
  private totalMs = 0;
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

  snapshot(): MetricsSnapshot {
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p99 = percentile(sorted, 0.99);
    return {
      writes: this.writes,
      intents: this.intents,
      facts: this.facts,
      occConflicts: this.occConflicts,
      writeDurationsMs: [...this.durations],
      p50WriteMs: p50,
      p99WriteMs: p99,
      totalWriteMs: this.totalMs,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  reset(): void {
    this.writes = 0;
    this.intents = 0;
    this.facts = 0;
    this.occConflicts = 0;
    this.durations = [];
    this.totalMs = 0;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[idx]!;
}
