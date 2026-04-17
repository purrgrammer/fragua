# P5.12 — Adopt Vercel AI Elements across the web surface

## Goal
Standardize on **Vercel AI Elements** as the UI vocabulary for `@swarm/web`.
Replace the Graphviz-wasm SVG renderer shipped in P5.06 with the AI Elements
**Workflow** family (`Canvas`, `Connection`, `Controls`, `Edge`, `Node`,
`Panel`, `Toolbar`), and reserve the Chatbot family (`Message`, `Reasoning`,
`Tool`, `Task`, `Chain of Thought`, `Response`, `Conversation`) for the node
drilldown (task 08) and the human-in-the-loop set (`Checkpoint`,
`Confirmation`, `Suggestion`, `Queue`, `Prompt Input`) for steering (task 14).

The data contract is unchanged: the server continues to return typed JSON
from `GET /api/pipelines/:id` (`PipelineDetail.nodes[]`) and the parsed DAG
(`Graph` from `@swarm/core`). AI Elements is the presentation layer; the
data shape is the stable contract.

## Depends on
- P5.06 (data-first pipeline list + detail — already shipped)

## Scope

- Files to modify:
  - `packages/web/src/components/GraphView.tsx` — remove
    `dangerouslySetInnerHTML` + the `/graph.svg` fetch path; render nodes +
    edges through AI Elements `<Workflow.Canvas>` with a custom node
    renderer that reads the existing `nodeState` map (`pending` | `running`
    | `completed` | `failed` | `skipped` | `retrying`). Keep the public
    props (`runId`, `onNodeClick`, `activeNodeId`, `refetchKey`) stable so
    `PipelineDetail.tsx` is untouched.
  - `packages/web/src/components/GraphView.module.css` — delete or reduce
    to swarm-specific status tokens; AI Elements supplies the base styling.
  - `packages/server/src/routes/graph.ts` — delete once nothing consumes
    `/pipelines/:id/graph.svg`. Drop the `GraphRenderer` port and the
    `graphviz-wasm` dependency alongside it.
  - `packages/core/src/executor/execute.ts` — keep the `workflow_source`
    emit; downstream replay tooling and the CLI dashboard (P5.09) may still
    want the raw DOT even though the browser no longer renders it.
  - `packages/web/package.json` — add AI Elements (exact package name:
    check `https://elements.ai-sdk.dev` at implementation time; `pnpm dlx
    ai-elements@latest add workflow` is the current install path).
  - `packages/web/test/components/GraphView.test.tsx` — retarget assertions
    at the AI Elements Workflow DOM output (node elements continue to carry
    a stable `data-node-id` attribute so Playwright/unit tests keep working).

- Files to create:
  - `packages/web/src/lib/graph-layout.ts` — pure adapter. Inputs: parsed
    `Graph` from `@swarm/core` + the live `NodeState[]` from the server.
    Output: positioned Workflow nodes/edges ready for `<Workflow.Canvas>`.
    Layout math (elk-style layered layout, or whatever AI Elements'
    Workflow recommends) is isolated here so the rest of the codebase
    never depends on it directly.
  - `packages/web/test/lib/graph-layout.test.ts` — fixture DAG → structural
    shape assertions; no pixel-perfect coords.

## Rendering contract

- `<Workflow.Canvas>` receives nodes + edges produced by `graph-layout.ts`.
- Each node uses a swarm-specific `<Workflow.Node>` renderer that shows
  the node id, its current state (colour token), and an optional active
  marker. Click delegation inside the custom node calls `onNodeClick`.
- Active-node highlight uses an explicit prop on the custom node renderer
  — no string patching of SVG output. The `applyActiveMarker` helper in
  the current `GraphView.tsx` is deleted alongside the SVG path.

## Tests
- `graph-layout.test.ts`: fixture `Graph` + node-state map → expected
  number of workflow nodes and edges; stable ids; status flows through.
- `GraphView.test.tsx`: renders the AI Elements workflow with a fixture;
  asserts that clicking a node fires `onNodeClick(nodeId)` and that the
  `activeNodeId` prop flips the active marker on the matching node.
- Existing `PipelineDetail.test.tsx` must keep passing unchanged — the
  swap is presentation-only.

## Verification
- `bun run ci` passes.
- Smoke: `bun --filter='@swarm/web' dev` + `swarm serve` — open
  `/pipelines/<id>`; graph renders via AI Elements with pan/zoom + controls;
  clicking a node still fires the selection callback; live state updates
  recolour nodes as events stream in.
- `GET /pipelines/:id/graph.svg` no longer exists (404) and the browser's
  console is clean — no request for the retired endpoint.

## Out of scope
- Pipeline conversation view (task 08 — AI Elements Chatbot family).
- Steering UI (task 14 — AI Elements human-in-the-loop set).
- CLI dashboard (task 09 — Ink-based, not AI Elements).

## Reusable patterns
- **Data stays put.** The server already returns `nodes[]` with lifecycle
  state on `PipelineDetail`; `@swarm/core`'s `parseDotSource` supplies the
  edges. No server-side contract change.
- **One adapter, one lib.** All layout math lives in `graph-layout.ts`.
  If we ever need to swap the underlying presentation lib, only this
  module and `GraphView.tsx` change.
- **Stable node identity.** Keep a `data-node-id` attribute on every
  rendered node — Playwright/unit tests and keyboard navigation rely on it.
- **Status tokens.** Reuse the existing swarm node-state vocabulary
  (`pending` | `running` | `completed` | `failed` | `skipped` | `retrying`)
  — do not invent new states for the renderer.
