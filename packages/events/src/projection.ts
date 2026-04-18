// Read-side abstractions — the inverse of `EventSink`.
//
// EventSink tells the runtime where to write raw events. EventSource tells
// clients where to read them back from. Projections turn a stream of raw
// events into a client-shaped view (summary, step snapshots, stats tiles).
//
// Why this pair lives in @swarm/events:
//   - @swarm/core owns the Event envelope type but must stay I/O-free, so
//     a Postgres/disk-backed source doesn't belong there.
//   - @swarm/server today depends on a thin `RunReader` port that is
//     interface-equivalent to `EventSource` — the server type is kept as
//     a compatibility alias so existing adapters keep working. New code
//     should target `EventSource`.
//
// The split matters for the DB-backed future outlined in docs/PLAN.md
// Phase 6: when runs are stored in Postgres/OTel, a `MaterializedProjectionStore`
// implementation can precompute common projections (summary, steps)
// into indexed tables and serve them without replaying raw events.
// Until then `JsonlEventSource` reads the same JSONL the JsonlSink
// writes, and projections run on demand.

import type { Event, EventSink } from "@swarm/core";

/**
 * Pure reducer from a run's raw events into a client-shaped view.
 *
 * Contract:
 *   - MUST be deterministic — same input → same output. This is what
 *     makes replay deterministic and what a DB-backed adapter relies
 *     on when it materialises the projection up-front.
 *   - MUST NOT throw on partial / malformed events. Projections see
 *     old JSONL shapes (pre-schema_version=1); graceful degradation
 *     is the expectation.
 *   - MAY be async if the projection needs to fan out to external data
 *     (e.g. resolving workflow metadata). The common case is synchronous.
 */
export type Projection<T> = (events: readonly Event[]) => T | Promise<T>;

/**
 * Read-side port — "the opposite of EventSink". Implementations: a
 * JSONL directory scanner today; Postgres/SQLite/OTel in future.
 */
export interface EventSource {
  /** Enumerate every run id the source knows about. Ordering is
   * implementation-defined; callers that care sort. */
  listRuns(): Promise<string[]>;
  /** Load every event for a run in the order they were written.
   * Returns `undefined` when the run does not exist so handlers
   * distinguish "not found" from "empty". */
  readRun(runId: string): Promise<Event[] | undefined>;
}

/**
 * Optional extension: a source that can materialise + cache projection
 * results. DB-backed adapters are expected to implement this so the
 * /pipelines list and /pipelines/:id/steps read a precomputed row
 * instead of re-replaying raw events. Projections are identified by a
 * stable string key that the adapter uses as its cache / table name.
 *
 * Today nobody implements this — the JsonlEventSource projects on
 * demand — but defining the interface now makes the upgrade path
 * contract-only, not a refactor.
 */
export interface MaterializedProjectionStore<T> {
  /** Look up a materialised projection for a run. Returns `undefined`
   * when the run exists but the projection hasn't been materialised
   * yet (adapter decides when to compute). */
  get(runId: string, projectionKey: string): Promise<T | undefined>;
  /** Fold across every materialised projection (e.g. /stats). Adapters
   * may stream rather than load them all at once. */
  list(projectionKey: string): AsyncIterable<{ runId: string; value: T }>;
}

/**
 * Apply a Projection to one run. Returns `undefined` when the run
 * doesn't exist so the caller can produce a proper 404. The helper
 * exists so route handlers stop hand-rolling the
 * `readRun → if-undefined → project → return` dance on every route.
 */
export async function projectRun<T>(
  source: EventSource,
  runId: string,
  projection: Projection<T>,
): Promise<T | undefined> {
  const events = await source.readRun(runId);
  if (events === undefined) return undefined;
  return await projection(events);
}

/**
 * Copy every event from `source` into `sink`, run by run. Gives
 * operators a supported migration path when they're moving from
 * JSONL to Postgres, or from one Postgres instance to another, or
 * backfilling an OTel exporter with historical data.
 *
 * Idempotency: `EventSink.append` is expected to be commutative +
 * idempotent on (run_id, timestamp, type, workflow_sha) — repeated
 * migration runs must not duplicate events. The default JSONL sink
 * does NOT enforce this today (append-only writer; re-running would
 * duplicate), so in practice migration is a one-shot operation on a
 * drained source. A future Postgres sink can enforce idempotency via
 * a unique index on the envelope tuple.
 *
 * `onRun` is a progress callback — gets called once per run with the
 * id and event count. Useful for a CLI that wants to print progress.
 */
export async function migrateAllRuns(
  source: EventSource,
  sink: EventSink,
  opts: { onRun?: (runId: string, eventCount: number) => void } = {},
): Promise<{ runs: number; events: number }> {
  let runs = 0;
  let events = 0;
  for (const runId of await source.listRuns()) {
    const rows = await source.readRun(runId);
    if (!rows) continue;
    for (const ev of rows) await sink.append(ev);
    runs++;
    events += rows.length;
    opts.onRun?.(runId, rows.length);
  }
  if (sink.close) await sink.close();
  return { runs, events };
}

/**
 * Apply a Projection to every run in the source, folding the results
 * into a single accumulator. Used for aggregate endpoints like /stats.
 *
 * `folder` receives the accumulator, the projection output for one
 * run, and that run's id so stats that need per-run attribution can
 * keep it. Runs the projection lazily per-run so a source with
 * thousands of runs doesn't blow up memory before the fold starts.
 */
export async function foldAll<T, A>(
  source: EventSource,
  projection: Projection<T>,
  folder: (acc: A, projected: T, runId: string) => A,
  initial: A,
): Promise<A> {
  const ids = await source.listRuns();
  let acc = initial;
  for (const id of ids) {
    const events = await source.readRun(id);
    if (events === undefined) continue;
    const t = await projection(events);
    acc = folder(acc, t, id);
  }
  return acc;
}
