// SSE streaming helpers shared by `/runs/:id/stream` (per-run) and
// `/events/stream` (global Home feed). Two routes, one loop body — the
// drain-then-sleep cadence, the abort handling, and the wire format are
// identical; they only differ in cursor type and how the next batch is
// fetched.

import type { StoredEvent } from "@swarm/store";
import type { SSEStreamingApi } from "hono/streaming";

/**
 * JSON projection of a {@link StoredEvent} as it flies over the SSE
 * `data:` field. The wire shape is the same on both endpoints — the
 * client uses a single `addEventListener("message", …)` and dispatches
 * on `event.type` from the JSON payload, not the SSE event name.
 */
export function serializeEvent(event: StoredEvent): string {
  return JSON.stringify({
    runId: event.runId,
    seq: event.seq,
    type: event.type,
    writer: event.writer,
    payload: event.payload,
    ts: event.ts,
  });
}

interface SseLoopConfig<C> {
  /** Fetch up to `batchSize` events strictly after `cursor`, in order. */
  fetchBatch(cursor: C, batchSize: number): StoredEvent[];
  /** Derive the cursor that points "right after" this event. */
  cursorOf(event: StoredEvent): C;
  /** SSE `id:` field for this event. The browser echoes the last id back
   * as `Last-Event-ID` on auto-reconnect, so this string must round-trip
   * through {@link parseLastEventIdMax} or the route's equivalent. */
  idOf(event: StoredEvent): string;
  /** Optional close gate, evaluated only after a non-full batch (i.e.
   * when the live tail has been reached). Per-run streams use this to
   * close on terminal status; the global stream omits it and runs until
   * the client disconnects. */
  shouldClose?: () => boolean;
  batchSize: number;
  pollMs: number;
  /** Send a `swarm.ping` data frame on the wire after this many ms
   * without any event. Two jobs in one wire write:
   *   1. Resets dev proxies / load balancers' idle timers (any bytes
   *      flushed do this — comments would too).
   *   2. Fires the client `EventSource.onmessage` handler so the web
   *      hook's stall watchdog can re-arm and detect a half-open TCP
   *      socket that the browser hasn't noticed yet.
   * The previous shape was a `: keepalive` comment, which solved (1)
   * but is invisible to the JS event-source API, so a half-dead
   * connection could sit "open" without delivering events for many
   * minutes. A `data:` frame is observable. Default 10s — comfortably
   * under typical 15s/30s proxy idle thresholds AND under the client
   * watchdog window (35s). */
  keepaliveMs?: number;
  /** Test injection: monotonic clock. */
  now?: () => number;
}

const DEFAULT_KEEPALIVE_MS = 10_000;
/** Wire shape of a keepalive. Intentionally lacks `runId`/`seq` so the
 * client's loose envelope check (which requires both) drops it from the
 * feed atom — the watchdog rearm fires regardless via `onmessage`.
 * Exported for the global-feed loop in routes.ts (which has its own
 * drain loop separate from runSseLoop). */
export function pingFrameData(now: number): string {
  return JSON.stringify({ type: "swarm.ping", ts: now });
}

/**
 * Drain-emit-sleep loop shared by per-run and global SSE streams.
 *
 * Order of operations matters: we ALWAYS drain a full batch before
 * checking `shouldClose`. Otherwise a long terminal run with >`batchSize`
 * unread events would close after the first batch, leaving the rest
 * undelivered. The contract is "non-full batch ⇒ caught up to live
 * tail", which is when closing or sleeping is safe.
 */
export async function runSseLoop<C>(stream: SSEStreamingApi, initialCursor: C, cfg: SseLoopConfig<C>): Promise<void> {
  const now = cfg.now ?? Date.now;
  const keepaliveMs = cfg.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  let cursor = initialCursor;
  let lastWriteAt = now();
  while (!stream.aborted) {
    const batch = cfg.fetchBatch(cursor, cfg.batchSize);
    for (const event of batch) {
      await stream.writeSSE({ id: cfg.idOf(event), data: serializeEvent(event) });
      cursor = cfg.cursorOf(event);
      lastWriteAt = now();
    }
    if (batch.length < cfg.batchSize) {
      if (cfg.shouldClose?.()) return;
      // Keepalive when the live tail has been quiet long enough that a
      // proxy might close the connection or that the client-side stall
      // watchdog might fire on a half-dead socket. Sent as a real
      // `data:` frame (no `id:`, no `event:`) so the client's
      // `onmessage` handler runs and re-arms its watchdog.
      if (now() - lastWriteAt >= keepaliveMs) {
        await stream.writeSSE({ data: pingFrameData(now()) });
        lastWriteAt = now();
      }
      await stream.sleep(cfg.pollMs);
    }
  }
}

// ─── Numeric (per-run) cursor helpers ─────────────────────────────────

/**
 * Resume cursor for per-run streams = `max(?sinceSeq=<n>, Last-Event-ID, 0)`.
 *
 * Both signals are valid resume cursors and they show up at different
 * lifecycle stages:
 *   - `?sinceSeq=` is set by the client on initial connect (the snapshot
 *     already has events ≤ N, no need to replay).
 *   - `Last-Event-ID` is set by the browser on EventSource auto-reconnect
 *     (transport drop), to whatever id: the browser last received.
 *     Vanilla EventSource doesn't let app code set the header, hence
 *     the dual-signal hybrid.
 *
 * Picking max() is what makes the two safe to coexist: after a reconnect
 * deep into a stream, `Last-Event-ID` is strictly ahead of the original
 * `?sinceSeq=` baked into the URL, so taking the larger avoids
 * redelivering events the client already received.
 */
export function parseSeqCursorMax(querySinceSeq: string | undefined, lastEventId: string | undefined): number {
  const queryNum = querySinceSeq != null ? Number(querySinceSeq) : Number.NaN;
  const headerNum = lastEventId != null ? Number(lastEventId) : Number.NaN;
  const querySafe = Number.isFinite(queryNum) ? queryNum : 0;
  const headerSafe = Number.isFinite(headerNum) ? headerNum : 0;
  const maxed = Math.max(querySafe, headerSafe);
  return maxed < 0 ? 0 : maxed;
}

// ─── Global feed cursor helpers ───────────────────────────────────────

/**
 * Identity for the SSE `id:` field on the global feed. The wire format
 * is `<ts>.<runId>.<seq>`; the server only uses `ts` for the SQL filter
 * (everything else is for client-side dedup), but the full triple is
 * kept on the wire so the client can re-dedupe across reconnects via
 * `(runId, seq)` identity. `runId` is lowercase Crockford base-32 (no
 * dots), so the dotted form is unambiguous to parse.
 */
export interface GlobalEventId {
  ts: number;
  runId: string;
  seq: number;
}

export function encodeGlobalEventId(id: GlobalEventId): string {
  return `${id.ts}.${id.runId}.${id.seq}`;
}

/** Parse `<ts>.<runId>.<seq>`; returns null on malformed input so the
 * caller can fall back to query params or origin. */
export function parseGlobalEventId(s: string | undefined): GlobalEventId | null {
  if (s == null) return null;
  const firstDot = s.indexOf(".");
  const lastDot = s.lastIndexOf(".");
  if (firstDot < 0 || lastDot <= firstDot) return null;
  const ts = Number(s.slice(0, firstDot));
  const runId = s.slice(firstDot + 1, lastDot);
  const seq = Number(s.slice(lastDot + 1));
  if (!Number.isFinite(ts) || !Number.isFinite(seq) || runId.length === 0) return null;
  return { ts, runId, seq };
}

/**
 * Resume `ts` cursor for the global feed = `max(?fromTs, Last-Event-ID.ts, 0)`.
 *
 * Same dual-signal logic as the per-run cursor (`?sinceSeq` vs
 * `Last-Event-ID`): the query cursor is baked at first connect, the
 * header advances on auto-reconnect, picking the larger of the two
 * resumes safely from the latest signal. Only the `ts` component is
 * needed for the SQL filter — the (runId, seq) part lives in
 * `Last-Event-ID` for the client's own dedup, not the server's.
 *
 * Inclusive on the boundary (`ts >= cursor`), matching the SQL filter.
 */
export function parseGlobalFromTsMax(args: { fromTs: string | undefined; lastEventId: string | undefined }): number {
  const queryNum = args.fromTs != null ? Number(args.fromTs) : Number.NaN;
  const headerNum = parseGlobalEventId(args.lastEventId)?.ts ?? Number.NaN;
  const querySafe = Number.isFinite(queryNum) ? queryNum : 0;
  const headerSafe = Number.isFinite(headerNum) ? headerNum : 0;
  const maxed = Math.max(querySafe, headerSafe);
  return maxed < 0 ? 0 : maxed;
}
