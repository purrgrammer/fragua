// Periodic blob garbage collection.
//
// `store.putArtifact` writes the file before the row that points at it
// (§I8 — file-then-row commit ordering). A hard crash between the file
// write and the row insert leaves an orphan file. The store's `gcBlobs`
// reaps these on demand. Without this driver it never runs unless an
// operator types `swarm db gc` — orphans accumulate until disk pressure
// surfaces them.
//
// This loop ticks slowly (default every 6 hours) and bounds work per
// tick (default 1000 rows). It's idempotent and safe to call any time.

import type { IEventStore } from "@swarm/store";

export interface BlobGcOpts {
  store: IEventStore;
  shutdownSignal: AbortSignal;
  /** How often to sweep, in ms. Default 6 hours. */
  intervalMs?: number;
  /** Max rows visited per sweep. Bounds latency on huge stores. Default 1000. */
  maxRows?: number;
  /** Optional reporter — called after each successful sweep with the
   * count of files deleted. Tests use it to assert the loop ran. */
  onSweep?: (deleted: number) => void;
}

export const DEFAULT_BLOB_GC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_BLOB_GC_MAX_ROWS = 1_000;

export function startBlobGc(opts: BlobGcOpts): { promise: Promise<void> } {
  const intervalMs = opts.intervalMs ?? DEFAULT_BLOB_GC_INTERVAL_MS;
  const maxRows = opts.maxRows ?? DEFAULT_BLOB_GC_MAX_ROWS;

  const promise = (async () => {
    while (!opts.shutdownSignal.aborted) {
      // Sleep first — start-up sweep already runs at boot, so the very
      // first GC happens one interval later. Avoids a thundering-herd
      // pattern when many daemons restart at once.
      await sleep(intervalMs, opts.shutdownSignal);
      if (opts.shutdownSignal.aborted) return;
      try {
        const { deleted } = opts.store.gcBlobs(maxRows);
        if (opts.onSweep) opts.onSweep(deleted);
      } catch (err) {
        // Never crash the loop. GC failures (filesystem permission, race
        // with a concurrent write, etc.) should be visible but not fatal.
        // eslint-disable-next-line no-console
        console.warn("[blob-gc] sweep failed:", err);
      }
    }
  })();

  return { promise };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
