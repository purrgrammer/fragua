# P5.06 — Web: graph view (data-first) + active-node highlight

## Goal
Render the workflow graph in the web UI from the **JSON** returned by
`GET /api/pipelines/:id/graph`. No server-rendered SVG, no
graphviz-wasm in the browser bundle — the UI consumes structured data and
owns layout/styling. As events stream in via SSE, the active node gets a
"running" style and completed ones go to "success" / "fail". Clicking a
node emits `selectedNodeId` for the drilldown pane (task 08).

## Depends on
- P5.05 (Web scaffold)
- P5.02 (REST — need a pipeline id)
- P5.03 (JSON graph endpoint)

## Scope

- Files to create:
  - `packages/web/src/components/GraphView.tsx` — renders nodes + edges
    from the JSON `Graph` shape. Node visual state driven by the
    `nodeStates` map (below). See "Rendering choice" for the layout lib.
  - `packages/web/src/hooks/useRunEvents.ts` — EventSource hook that
    connects to `/api/runs/:id/events`. Exposes `{ events, nodeStates, status }`.
  - `packages/web/src/hooks/useGraph.ts` — fetches `/api/pipelines/:id/graph`
    and returns typed `Graph` (imported from `@swarm/core`). Cached, no refetch.
  - `packages/web/src/lib/node-state.ts` — pure reducer: event list → `Map<nodeId, "pending"|"running"|"success"|"fail">`.
  - `packages/web/test/node-state.test.ts`
  - `packages/web/test/GraphView.test.tsx`
- Files to modify:
  - `packages/web/src/App.tsx` — mount `<GraphView runId=… />` when a run is selected
  - `packages/web/src/styles/globals.css` — highlight styles per node state

## Rendering choice (defer to implementation)

AI Elements ships workflow/task primitives that may fit this use case
directly; investigate first. If AI Elements doesn't provide a suitable
graph primitive, fall back to a minimal layout integration (candidates,
ranked by maintenance burden): `@xyflow/react` (React Flow) ≥ `elkjs` +
custom SVG ≥ hand-rolled dagre. Whatever is picked, it must consume the
`Graph` data structure verbatim — the data shape is the stable contract;
the renderer is replaceable.

## Tests

- `node-state.test.ts`: feeding a real event sequence into the reducer
  produces the expected `nodeId → state` map through `pending → running →
  success/fail`.
- `GraphView.test.tsx`: given a fixture `Graph` + a streamed event set,
  the right DOM element (identified by `data-node-id=`) carries the
  `swarm-node-running` class. Happy-dom is sufficient; no visual diff.
- `useGraph.test.tsx`: mocks `/api/pipelines/:id/graph`, asserts the hook
  returns a typed `Graph` (type-check via `satisfies Graph`).

## Verification

- `bun run ci` passes
- Smoke: launch a pipeline via REST, open the web UI with that run id,
  watch nodes transition live as SSE frames arrive. Click a node → the
  `selectedNodeId` state updates (callback parameter).

## Out of scope

- **Server-rendered SVG** — the server returns JSON only (task 03). Client owns visual layout.
- **graphviz-wasm in the browser bundle** — not needed; we render from structured data.
- Drilldown pane (task 08 uses the `selectedNodeId` emitted here).
- Cost panel / event timeline (task 07).
- Editable graphs (no DAG mutation UI).

## Reusable patterns

- **Graph type**: `import type { Graph, Node, Edge } from "@swarm/core"` —
  the server returns the same shape, so TS keeps client + server honest.
  `@swarm/core` is pure (no `node:` imports) so it bundles in the browser.
- **Client-side DOT parsing** (for replay uploads): `parseDotSource`
  from `@swarm/core` works in the browser too — use it if the user
  uploads a `.dot` file in the replay view (task 10).
- **Event types**: `packages/core/src/types/events.ts` — listen for
  `node.started`, `node.completed`, `node.failed`.
- **SSE in browser**: `new EventSource(`/api/runs/${id}/events`)`.
  Reconnect via `Last-Event-ID` (already implemented server-side in P5.01).
- **Node identity in the DOM**: keep the `Graph`'s `node.id` as the stable
  key everywhere — `<g data-node-id={n.id}>` (or the framework's equivalent).
  Makes Playwright assertions trivial in task 11.
