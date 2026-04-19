/**
 * Fiber-level write serializer. `bun:sqlite` is synchronous, so a single
 * process has no intra-process races — but the store's write surface (event
 * append + projection update + optional blob insert) can span multiple
 * statements. The queue guards against interleaving when callers produce
 * writes from async paths that resolve in arbitrary order.
 *
 * Inter-process serialization is the job of SQLite itself (WAL + BEGIN
 * IMMEDIATE); `busy_timeout = 5000` retries transparently.
 */
export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  enqueue<T>(fn: () => T): Promise<T> {
    const next = this.tail.then(() => fn());
    // Swallow rejections in the tail itself to avoid poisoning the chain.
    this.tail = next.catch(() => {});
    return next;
  }
}
