# P5.07 — Web: event timeline + filter + cost ticker

## Goal
Add a streaming event timeline below the graph, with checkbox filters by event
type and a running cost ticker in the header. Timeline is virtualized so a 10k
event run doesn't choke the browser.

## Depends on
- P5.05 (Web scaffold)
- P5.01 (SSE endpoint)

## Scope

- Files to create:
  - `packages/web/src/components/EventTimeline.tsx` — virtualized list via `@tanstack/react-virtual`
  - `packages/web/src/components/EventFilter.tsx` — checkbox group of event type categories
  - `packages/web/src/components/CostTicker.tsx` — header widget showing `$0.0032 · 3 LLM calls · 1.2k in / 450 out`
  - `packages/web/src/lib/cost-aggregate.ts` — reducer that sums `cost.recorded` events
  - `packages/web/test/cost-aggregate.test.ts`
  - `packages/web/test/EventTimeline.test.tsx`
- Files to modify:
  - `packages/web/src/App.tsx` — mount the timeline + cost ticker in layout
  - `packages/web/src/hooks/useRunEvents.ts` — already exposes `events`; also expose `costTotal`
- Dependencies:
  - Add `@tanstack/react-virtual` (pinned)

## Tests

- `cost-aggregate.test.ts`: given a mix of cost.recorded events, computes totals per model + per node + grand total
- `EventTimeline.test.tsx`: renders 1000 events, filter hides llm.* events, scrolling works (virtualized row count matches)
- Cost ticker reflects latest totals

## Verification

- `bun run ci` passes
- Smoke:
  - Launch a pipeline, open web UI
  - Watch events stream into the timeline top-down (newest-first)
  - Toggle "llm.*" off → delta events disappear
  - Cost ticker updates live

## Out of scope

- Step drilldown (task 08 — clicking a timeline entry navigates, but the pane itself is later)
- Historical run search / replay (task 10)

## Reusable patterns

- Event categorization: `packages/core/src/types/events.ts` — group into {pipeline, node, edge, agent, llm, tool, interview, steering, cost}
- Cost per call: the `cost.recorded` event data payload matches `packages/agent/src/event-bridge.ts:costPayload()` shape
- Existing CLI timeline printer: `packages/events/src/console.ts` has a reference formatter
