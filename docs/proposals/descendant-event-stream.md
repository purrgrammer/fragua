---
title: Per-parent descendant event stream — split the operator feed from descendant tracking
summary: "The operator Activity feed and RunDetail's descendant-tracking signal share one allowlist on /events. RunDetail's need for fact.message_appended floods the feed and forces a client-side HIDDEN_FEED_TYPES patch. Replace the entanglement with a scoped SSE: /runs/:id/events/stream?include=descendants serves a parent's run tree; /events keeps lifecycle + system-health only."
status: shipped
maturity: shipped
last-reviewed: 2026-05-16
rationale: Commit 2d0ddaf (P11 of parallel-ui, 2026-05-15) added `fact.message_appended` to `FEED_EVENT_KINDS` so RunDetail could observe sub-run progress through `feedAtom`. The commit message frames it as deferred work: "Parent's run-detail page updates in real time **without a parent-level SSE descendant multiplex (deferred — server-side recursive cursor work is the next pass)**." That next pass is this proposal. Observable cost today: a single live run can emit dozens of `fact.message_appended` per minute, the 30-event /events backfill fills with them, the GlobalFeed hides them all, and the operator sees one Activity row.
---

# Per-parent descendant event stream

> The operator Activity feed and RunDetail's descendant tracking are two
> different consumers of the same event log. The first wants a narrow
> lifecycle stream across every run; the second wants the full event
> firehose scoped to one parent's tree. Merging them into one cross-run
> allowlist makes the high-volume consumer's needs dominate — every
> operator's Activity view is degraded so one component can avoid an SSE
> subscription.

## Problem

`FEED_EVENT_KINDS` (`packages/types/src/swarm-events.ts:833`) is the
server's allowlist for `/events` (backfill) and `/events/stream` (live
SSE). It currently serves three disjoint consumers via one stream:

| Consumer | Path | Needs |
|---|---|---|
| Operator Activity feed | `GlobalFeed.tsx` → `feedAtom` | Lifecycle + system-health, low volume |
| Cross-run cache invalidation | `useGlobalEventStream` → `RUN_INVALIDATE_KINDS` | Lifecycle, low volume |
| Per-parent descendant tracking | `RunDetail.tsx` → `DESCENDANT_REFRESH_TYPES` → `useRunLive.descendantRefreshToken` | A specific parent's child-tree `fact.message_appended` |

`FEED_EVENT_KINDS` is the **union** of those needs. The third consumer
puts `fact.message_appended` on the list. The first consumer hides it
again via `HIDDEN_FEED_TYPES` (`GlobalFeed.tsx:158`) because it's
operationally useless and noisy. The 50-slot `feedAtom` cap
(`globalFeed.ts:18`) plus a 30-event default backfill (`routes.ts:610`)
combine with that noise so the operator sees one visible Activity row
even after several runs.

Step 1 of the fix (in flight in a parallel change run) drops the noisy
kinds from `FEED_EVENT_KINDS` and accepts a temporary regression in
RunDetail: the descendant message transcript stops auto-ticking on
every sub-run assistant message and refreshes only at child lifecycle
boundaries. This proposal is step 2 — restore that liveness by giving
RunDetail its own stream.

## Shape

Two surfaces, identical envelope to the existing ones.

### Server

A new SSE route on top of the existing `getEventsWithDescendants`
recursive CTE (`packages/store/src/event-queries.ts:146`). That CTE
already produces the merged `(ts, run_id, seq)`-ordered stream the
backfill JSON endpoint uses; generalising it to a forward cursor mirrors
exactly what `getGlobalEventsForward` does for the global feed.

```ts
// packages/store/src/event-queries.ts
// New: forward-cursor variant of getEventsWithDescendants.
//
// Same SQL as SELECT_EVENTS_WITH_DESCENDANTS_SQL but adds the
// strict-tuple cursor `(ts, max-at-floor) > (?floorTs, ?floorMaxAt)`
// that `getGlobalEventsForward` uses. Returns rows after the cursor,
// page-sized.
export function getEventsForRunWithDescendantsForward(
  db: Database,
  opts: { runId: string; floorTs: number; floorMaxAt: number; limit: number },
): DescendantEventRow[];

// And a paired "at floor" lookup for the replay-at-boundary case the
// global feed already handles — paginates events that share
// `ts === floorTs` and were missed by the strict-tuple cursor.
export function getEventsForRunWithDescendantsAtFloor(
  db: Database,
  opts: { runId: string; floorTs: number; afterMaxAt: number; limit: number },
): DescendantEventRow[];
```

Wire them into `IEventStore` / `SqliteStore`, then a route:

```ts
// packages/server/src/store/runs-routes.ts (new SSE sibling of the
// existing JSON `?include=descendants` GET).
app.get("/runs/:id/events/stream", (c) => {
  const includeDescendants = c.req.query("include") === "descendants";
  if (!includeDescendants) {
    return c.json({ error: "missing ?include=descendants" }, 400);
  }
  return streamSSE(c, async (stream) => {
    const initialCursor = parseGlobalCursorFromHeader({ /* same shape */ });
    await runGlobalFeedLoop(stream, initialCursor, {
      fetchForward: (opts) =>
        deps.store.getEventsForRunWithDescendantsForward({ runId: c.req.param("id"), ...opts }),
      fetchAtFloor: (opts) =>
        deps.store.getEventsForRunWithDescendantsAtFloor({ runId: c.req.param("id"), ...opts }),
      /* kindIn omitted — descendant stream is unfiltered by design */
    });
  });
});
```

`runGlobalFeedLoop` already handles reconnect, stall watchdog, the
`Last-Event-ID` boundary case, and cursor accounting. The descendant
stream reuses it verbatim; the only delta is the SQL source.

Pair the SSE with the existing JSON `?include=descendants` endpoint
(`runs-routes.ts:130`) for the initial backfill — the same pair-pattern
the global feed uses (`/events` for backfill, `/events/stream` for live
tail). No changes to that JSON route are required.

### Client

A new hook, or an extension to `useRunLive`. The cleanest split:

```ts
// packages/web/src/lib/useRunDescendantStream.ts (new)
//
// Mounted by RunDetail when the run has descendants (parallel parent).
// Owns its own SSE EventSource keyed off (runId, terminal). Exposes a
// monotonic `descendantToken` that's bumped on every received event
// (mirrors today's descendantRefreshToken contract).
export function useRunDescendantStream(
  runId: string | null,
  opts: { terminal: boolean | undefined },
): { descendantToken: string };
```

RunDetail drops `feedAtom`-as-descendant-transport:

```ts
// Before — packages/web/src/routes/RunDetail.tsx:165
const feedEvents = useAtomValue(feedAtom);
const descendantRefreshToken = useMemo(() => {
  /* scan feedEvents for child runIds */
}, [feedEvents, childRunIds]);

// After
const { descendantToken } = useRunDescendantStream(id, { terminal: isTerminal });
```

`useRunLive` accepts the `descendantToken` exactly as it accepts
`descendantRefreshToken` today (`useRunLive.ts:108`) — no protocol
change downstream. The hook's existing fetch-on-token-change effect
(line 171) keeps working.

## Why this shape

- **One SSE per consumer concern.** Operator feed = `/events/stream`;
  descendant tracking = `/runs/:id/events/stream`. Each stream filters
  on its consumer's actual needs. No cross-contamination.
- **Server reuse.** `runGlobalFeedLoop` + the recursive CTE are both
  load-bearing today; the new route is glue, not new infrastructure.
- **Mount cost stays one SSE.** RunDetail today opens `useRunLive`'s
  per-run SSE + reads `feedAtom`. After the split it opens
  `useRunLive`'s per-run SSE + `useRunDescendantStream`'s SSE. One
  net-new connection, mounted only when viewing a parent — passes
  through to one TCP connection per browser tab.
- **No widening of `FEED_EVENT_KINDS`.** The allowlist stays narrow
  (lifecycle + system-health). The descendant stream is unfiltered by
  design — RunDetail consumes the full firehose for its own tree, which
  is what it wanted in the first place.

## Out of scope

- **A blanket "any run + descendants" subscription protocol.** This
  proposal solves the one observed use case (RunDetail on a parallel
  parent). A general per-arbitrary-set subscription is unwarranted
  until a second consumer appears.
- **Replacing `useRunLive`'s per-run SSE.** That stream is doing a
  different job (raw event log for the run's own observability + LLM
  text deltas). The descendant stream is purely a token-bump signal.
- **Server-side `excludeKinds` on `/events`.** Considered as a smaller
  fix, but it leaves the architectural entanglement in place: one
  stream, three consumers, configuration sprawl. The split is cleaner.

## Tests

- **Store.** `packages/store/test/event-queries.test.ts` — forward
  cursor over a parent + 2 sub-runs returns rows in
  `(ts, run_id, seq)` order, advances past `(floorTs, maxAt)`, paginates
  correctly at the boundary case (multiple events at the same `ts`).
- **Server.** `packages/server/test/store/runs-routes.test.ts` — GET
  `/runs/:id/events/stream?include=descendants` opens, emits events
  from the run AND its sub-runs, ignores events from unrelated runs;
  reconnect with `Last-Event-ID` replays the boundary correctly.
- **Client.** `packages/web/src/lib/useRunDescendantStream.test.tsx` —
  token bumps on incoming event, doesn't bump on unrelated event,
  unmounts cleanly, doesn't open when `runId` is null or
  `terminal === true`.
- **Integration.** `packages/web/src/routes/RunDetail.test.tsx` — a
  parallel parent's descendant message view ticks on every child
  `fact.message_appended` after the switch; the global Activity feed
  no longer contains `fact.message_appended` rows.

## Same-PR doc obligations

Per `AGENTS.md` §Ground rules:

- `docs/ARCHITECTURE.md` §7 (web-server routes): add the new
  `/runs/:id/events/stream` row.
- `.agents/skills/swarm-debug/SKILL.md`: mention the descendant stream
  as a debugging surface for "why isn't the descendant view updating".

## Status

> Shipped, 2026-05-16. The four-site change landed verbatim:
>
> - `@swarm/store`: `getEventsForRunWithDescendantsForward` /
>   `getEventsForRunWithDescendantsAtFloor` on `IEventReader` /
>   `SqliteStore`, backed by a recursive-CTE-scoped strict-tuple cursor
>   in `packages/store/src/event-queries.ts`.
> - `@swarm/server`: new SSE route
>   `GET /runs/:id/events/stream?include=descendants` mounted by
>   `storeRunsRoutes`, reusing `runGlobalFeedLoop` with an empty
>   `kindIn` (the descendant SQL is unfiltered).
> - `@swarm/web`: `useRunDescendantStream(runId, { terminal })` hook
>   returning `{ descendantToken }`; RunDetail replaces its
>   `feedAtom`-scan-for-childRunIds block with the hook and threads
>   the token into `useRunLive.descendantRefreshToken`. The previous
>   `computeDescendantRefreshToken` export is gone.
>
> Same-PR doc updates: `docs/ARCHITECTURE.md` §4 (IEventReader) +
> §7 (web-server routes); `.agents/skills/swarm-debug/SKILL.md`
> §4 (walking the descendant timeline).
