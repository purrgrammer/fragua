# P5.10 — `swarm replay` feeds TUI + web

## Goal
Extend `swarm replay` so it drives the TUI and web UI as if the run were live.
Replaying an events.jsonl reconstructs the full visual experience — graph
highlights, streaming text, tool calls, cost — at accelerated or real-time
speed.

## Depends on
- P5.09 (TUI)
- P5.06 (Graph view)

## Scope

- Files to create:
  - `packages/cli/src/replay/player.ts` — reads JSONL, yields events on a
    virtual clock (`--speed 1` = real-time, `--speed 10` = 10x, `--instant` = no delays)
  - `packages/cli/test/replay-player.test.ts`
  - `packages/web/src/pages/Replay.tsx` — upload-or-URL loader; renders the
    same GraphView + EventTimeline + NodeDrilldown bound to a local event
    source instead of SSE
  - `packages/web/src/lib/local-event-source.ts` — `EventSourceLike` that
    emits from a parsed JSONL array instead of an HTTP connection
  - `packages/web/test/local-event-source.test.ts`
- Files to modify:
  - `packages/cli/src/commands/replay.ts` — add `--ui=text|tui` option; when
    `--ui=tui`, launch the dashboard component bound to the player
  - `packages/cli/bin/swarm.ts` — thread the new option
  - `packages/web/src/App.tsx` — route/query handling for replay mode

## Tests

- Player: given a fixture events.jsonl, emits events in original order at
  correct wall-time (mock timers)
- `--speed 0` or `--instant` emits all events synchronously
- Web LocalEventSource fires events identically to SSE (same `.addEventListener` interface)
- TUI replay renders the same final state as a live run (snapshot match)

## Verification

- `bun run ci` passes
- Smoke (TUI):
  ```sh
  bun run packages/cli/bin/swarm.ts replay .swarm/runs/<id>/events.jsonl --ui tui --speed 10
  ```
- Smoke (web): open `http://localhost:5173/replay?file=<url>` (or drag-drop)

## Out of scope

- Editing events before replay (future debugging tool)
- Diffing two runs (future)

## Reusable patterns

- Existing `swarm replay` command: `packages/cli/src/commands/replay.ts` — extend, don't rewrite
- Events sorted by `timestamp` already; deltas are ISO-8601 strings (`Date.parse` them for virtual clock)
- Web's existing `useRunEvents` hook abstracts EventSource — swap in LocalEventSource and the same components work
