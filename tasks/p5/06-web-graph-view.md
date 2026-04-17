# P5.06 — Web: graph view + active-node highlight

## Goal
Render a workflow as an SVG in the web UI, fetched from the server's graph
endpoint. As events stream in (`node.started`, `node.completed`), highlight
the active node and mark completed ones. Clicking a node emits a
`selectedNodeId` state update for the drilldown pane (filled in by task 08).

## Depends on
- P5.05 (Web scaffold)
- P5.02 (REST — need a pipeline id to render)
- P5.03 ideally (SVG endpoint; if not done, fetch DOT and render client-side)

## Scope

- Files to create:
  - `packages/web/src/components/GraphView.tsx` — fetches SVG, mounts via `dangerouslySetInnerHTML`, overlays highlight via CSS classes on node groups
  - `packages/web/src/hooks/useRunEvents.ts` — EventSource-based hook that connects to `/api/runs/:id/events` and exposes `{ events, status, nodeStates }`
  - `packages/web/src/lib/node-state.ts` — reducer that turns events into `{ nodeId → "pending" | "running" | "success" | "fail" }`
  - `packages/web/test/node-state.test.ts`
  - `packages/web/test/GraphView.test.tsx`
- Files to modify:
  - `packages/web/src/App.tsx` — mount `<GraphView runId={…} />` when a run is selected
  - `packages/web/src/styles/globals.css` — highlight classes (`.swarm-node-running`, `.swarm-node-success`, `.swarm-node-fail`)

## Tests

- `node-state.test.ts`: reducer correctly moves a node through `running → success` on real event sequences
- `GraphView.test.tsx`: given a fixture SVG + streamed events, the right node gets the `swarm-node-running` class (use happy-dom)
- Visual sanity (manual): node fill color changes as events arrive

## Verification

- `bun run ci` passes
- Smoke: launch a pipeline via the REST API, open the web UI with that run_id,
  watch the graph light up through start → intermediate nodes → exit

## Out of scope

- Graph layout customization — use whatever graphviz-wasm emits
- Node click → drilldown (just wire up the `onNodeClick` callback; the pane
  itself is task 08)
- Cost panel (task 07) or event timeline (task 07)

## Reusable patterns

- Event types: `packages/core/src/types/events.ts` (listen for `node.started`, `node.completed`, `node.failed`)
- SSE consumption in browser: `new EventSource('/api/runs/' + id + '/events')`
- Node id in the graph SVG: graphviz outputs `<g id="node1" class="node">...<title>nodeId</title>...</g>` — use the `<title>` text to map SVG group → node id
