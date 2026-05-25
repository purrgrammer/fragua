// SSE streaming helpers shared by `/runs/:id/stream` (per-run) and
// `/events/stream` (global Home feed).
//
// The per-run stream uses {@link runSseLoop} with a numeric `seq`
// cursor — strict-greater on a single column, no dedup needed because
// `seq` is monotone within a run.
//
// The global feed uses {@link runGlobalFeedLoop}, which combines a
// forward strict-tuple cursor (`> (floorTs, maxAt)`) with a paginated
// boundary rescan at `floorTs` that's filtered through a per-ts Set
// of emitted `(runId, seq)` keys. Forward advances on every emission
// so a same-ts batch larger than `batchSize` paginates without
// stalling; the rescan covers any event at the boundary ts the
// forward cursor stepped past. See `queries.ts` for the full
// rationale.

import type { GlobalFeedAtFloorCursor, GlobalFeedForwardCursor } from "@fragua/core/read-plane";
import type { StoredEvent } from "@fragua/store";
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
   * through {@link parseSeqCursorMax} or the route's equivalent. */
  idOf(event: StoredEvent): string;
  /** Optional close gate, evaluated only after a non-full batch (i.e.
   * when the live tail has been reached). Per-run streams use this to
   * close on terminal status; the global stream omits it and runs until
   * the client disconnects. */
  shouldClose?: () => boolean;
  batchSize: number;
  pollMs: number;
  /** Send a `fragua.ping` data frame on the wire after this many ms
   * without any event. Two jobs in one wire write:
   *   1. Resets dev proxies / load balancers' idle timers (any bytes
   *      flushed do this — comments would too).
   *   2. Fires the client `EventSource.onmessage` handler so the web
   *      hook's stall watchdog can re-arm and detect a half-open TCP
   *      socket that the browser hasn't noticed yet.
   * Default 10s — comfortably under typical 15s/30s proxy idle
   * thresholds AND under the client watchdog window (35s). */
  keepaliveMs?: number;
  /** Test injection: monotonic clock. */
  now?: () => number;
}

const DEFAULT_KEEPALIVE_MS = 10_000;

/** Wire shape of a keepalive. Intentionally lacks `runId`/`seq` so the
 * client's loose envelope check (which requires both) drops it from the
 * feed atom — the watchdog rearm fires regardless via `onmessage`. */
export function pingFrameData(now: number): string {
  return JSON.stringify({ type: "fragua.ping", ts: now });
}

/**
 * Drain-emit-sleep loop for the per-run stream. Single numeric cursor;
 * `fetchBatch` returns events strictly after it, ordered.
 *
 * Order of operations matters: we ALWAYS drain a full batch before
 * checking `shouldClose`. Otherwise a long terminal run with >`batchSize`
 * unread events would close after the first batch, leaving the rest
 * undelivered. The contract is "non-full batch ⇒ caught up to live
 * tail", which is when closing or sleeping is safe.
 *
 * `stream.aborted` is checked at the top of the while loop AND between
 * `writeSSE` calls inside a batch, so a long drain to a slow client
 * bails out promptly on disconnect rather than processing the full
 * batch first.
 */
export async function runSseLoop<C>(stream: SSEStreamingApi, initialCursor: C, cfg: SseLoopConfig<C>): Promise<void> {
  const now = cfg.now ?? Date.now;
  const keepaliveMs = cfg.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  let cursor = initialCursor;
  let lastWriteAt = now();
  while (!stream.aborted) {
    const batch = cfg.fetchBatch(cursor, cfg.batchSize);
    for (const event of batch) {
      if (stream.aborted) return;
      await stream.writeSSE({ id: cfg.idOf(event), data: serializeEvent(event) });
      cursor = cfg.cursorOf(event);
      lastWriteAt = now();
    }
    if (batch.length < cfg.batchSize) {
      if (cfg.shouldClose?.()) return;
      if (now() - lastWriteAt >= keepaliveMs) {
        await stream.writeSSE({ data: pingFrameData(now()) });
        lastWriteAt = now();
      }
      await stream.sleep(cfg.pollMs);
    }
  }
}

// ─── Global feed loop ─────────────────────────────────────────────────

/** Cursor state for the global SSE feed. `floorTs` is the boundary
 * `ts` we're at; `maxAt` is the lex-max `(run_id, seq)` already
 * emitted at `floorTs` (the strict-tuple forward cursor). `null`
 * until we've emitted at this ts. */
export interface GlobalEventCursor {
  floorTs: number;
  maxAt: { runId: string; seq: number } | null;
}

interface GlobalFeedLoopConfig {
  /** Forward strict-tuple scan. The read plane bakes the feed allow-list
   * in, so the cursor carries no `kindIn`. */
  fetchForward(cursor: GlobalFeedForwardCursor): StoredEvent[];
  /** Boundary rescan: events at exactly `floorTs` with `(run_id, seq) >
   * cursor`. Paginated ASC from `("", -1)` to walk the full boundary;
   * the loop filters duplicates via a per-`floorTs` Set. */
  fetchAtFloor(cursor: GlobalFeedAtFloorCursor): StoredEvent[];
  batchSize: number;
  pollMs: number;
  keepaliveMs?: number;
  now?: () => number;
}

/**
 * Drain-emit-sleep loop for the global feed.
 *
 * Each iteration:
 *   1. **Forward query** (strict-tuple `> (floorTs, maxAt)`) drains
 *      everything past the cursor. Advances `maxAt` on every emit so
 *      `LIMIT N` on >N same-ts events paginates across iterations
 *      without re-fetching the same N rows.
 *   2. **Boundary rescan** at `floorTs`: paginate ASC from
 *      `("", -1)`, filter via the per-`floorTs` Set of emitted keys,
 *      emit anything new. Catches every event at the boundary ts the
 *      forward cursor stepped past, regardless of where the new
 *      INSERT's `(run_id, seq)` falls relative to the lex-min /
 *      lex-max already emitted.
 *   3. Sleep + keepalive if no new events emitted in this pass.
 *
 * The Set is bounded by events at one millisecond — typically a
 * handful — and clears whenever `floorTs` advances.
 *
 * Per-iteration `stream.aborted` checks bail out promptly on client
 * disconnect.
 */
export async function runGlobalFeedLoop(
  stream: SSEStreamingApi,
  initialCursor: GlobalEventCursor,
  cfg: GlobalFeedLoopConfig,
): Promise<void> {
  const now = cfg.now ?? Date.now;
  const keepaliveMs = cfg.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
  let floorTs = initialCursor.floorTs;
  let maxAt: { runId: string; seq: number } | null = initialCursor.maxAt;
  let seenAtFloor: Set<string> = new Set();
  if (maxAt != null) seenAtFloor.add(`${maxAt.runId}.${maxAt.seq}`);
  let lastWriteAt = now();

  const emit = async (event: StoredEvent): Promise<void> => {
    await stream.writeSSE({
      id: encodeGlobalEventId({ ts: event.ts, runId: event.runId, seq: event.seq }),
      data: serializeEvent(event),
    });
    lastWriteAt = now();
    const key = `${event.runId}.${event.seq}`;
    if (event.ts > floorTs) {
      floorTs = event.ts;
      maxAt = { runId: event.runId, seq: event.seq };
      seenAtFloor = new Set([key]);
      return;
    }
    seenAtFloor.add(key);
    if (maxAt == null || event.runId > maxAt.runId || (event.runId === maxAt.runId && event.seq > maxAt.seq)) {
      maxAt = { runId: event.runId, seq: event.seq };
    }
  };

  while (!stream.aborted) {
    let emittedInPass = 0;

    const forward = cfg.fetchForward({
      floorTs,
      lastRunId: maxAt?.runId ?? "",
      lastSeq: maxAt?.seq ?? -1,
      limit: cfg.batchSize,
    });
    for (const event of forward) {
      if (stream.aborted) return;
      await emit(event);
      emittedInPass++;
    }

    if (seenAtFloor.size > 0) {
      // Boundary rescan: walk every event at `floorTs` ASC and filter
      // via Set. Pagination cursor resets to `("", -1)` per outer
      // iteration so a new INSERT lex-anywhere at `floorTs` is picked
      // up. Cost is O(events-at-floorTs) per outer iteration; events
      // at one ms are typically few.
      let rescanRunId = "";
      let rescanSeq = -1;
      while (!stream.aborted) {
        const rescan = cfg.fetchAtFloor({
          floorTs,
          afterRunId: rescanRunId,
          afterSeq: rescanSeq,
          limit: cfg.batchSize,
        });
        if (rescan.length === 0) break;
        for (const ev of rescan) {
          if (stream.aborted) return;
          rescanRunId = ev.runId;
          rescanSeq = ev.seq;
          const key = `${ev.runId}.${ev.seq}`;
          if (!seenAtFloor.has(key)) {
            await emit(ev);
            emittedInPass++;
          }
        }
        if (rescan.length < cfg.batchSize) break;
      }
    }

    if (forward.length < cfg.batchSize && emittedInPass === 0) {
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
 * Resume cursor for the global feed. Combines `?fromTs=` (set by the
 * client at first connect from the latest backfill ts) and
 * `Last-Event-ID` (set by the browser on auto-reconnect to the last
 * delivered SSE id) into a {@link GlobalEventCursor}.
 *
 * The header carries the full `(ts, runId, seq)` triple, so when it's
 * present and at least as fresh as `?fromTs`, we use it directly —
 * `maxAt` and `minAt` both seed from the triple so the look-back
 * doesn't immediately re-emit everything below it on reconnect.
 *
 * On first connect (no header, or `?fromTs` is fresher), `maxAt` and
 * `minAt` start as `null`: the forward query uses the sentinel
 * `("", -1)` so every event at `floorTs` qualifies, and the look-back
 * is skipped until we've emitted something.
 */
export function parseGlobalCursorFromHeader(args: {
  fromTs: string | undefined;
  lastEventId: string | undefined;
}): GlobalEventCursor {
  const headerCursor = parseGlobalEventId(args.lastEventId);
  const queryNum = args.fromTs != null ? Number(args.fromTs) : Number.NaN;
  const querySafe = Number.isFinite(queryNum) && queryNum > 0 ? queryNum : 0;

  // Header dominates when it's at least as fresh as the query param.
  // Seed `maxAt` from the triple so the forward query doesn't re-emit
  // events the previous connection already delivered at this ts.
  if (headerCursor != null && headerCursor.ts >= querySafe) {
    return {
      floorTs: headerCursor.ts,
      maxAt: { runId: headerCursor.runId, seq: headerCursor.seq },
    };
  }
  // Fresh `?fromTs` (or no header at all): no emission yet at this ts,
  // so the cursor starts unset.
  return { floorTs: querySafe, maxAt: null };
}
