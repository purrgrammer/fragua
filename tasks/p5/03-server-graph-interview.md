# P5.03 — Server: graph data endpoint + interview endpoints

## Goal
Expose two more endpoint groups on `@swarm/server`:
1. **Graph data** — return a workflow's parsed graph as JSON (the same
   `Graph` type `@swarm/core` already produces). The client renders from
   data; the server does not ship a layout engine. DOT is also served raw
   for debugging / download.
2. **Interview** — answer questions coming from `wait.human` nodes, enabling
   a `WebInterviewer` backend for browser-driven approvals.

## Depends on
- P5.02 (Server REST: pipelines CRUD)

## Scope

- Files to create:
  - `packages/server/src/routes/graph.ts` — two thin routes:
    - `GET /api/pipelines/:id/graph`          → `{ graph: Graph }` (JSON; default)
    - `GET /api/pipelines/:id/graph?format=dot` → `text/vnd.graphviz` raw source
  - `packages/server/src/routes/interview.ts`:
    - `GET  /api/pipelines/:id/questions`  — list pending questions
    - `POST /api/pipelines/:id/answer`     — body `{ question_id, value, text? }`
  - `packages/server/src/web-interviewer.ts` — `class WebInterviewer implements Interviewer` with async question/answer channels
  - `packages/server/test/graph.test.ts`
  - `packages/server/test/web-interviewer.test.ts`
- Files to modify:
  - `packages/server/src/index.ts` — mount routes
  - `packages/server/src/process-registry.ts` — store the `WebInterviewer` instance per run so the interview routes can reach it
- **No new dependencies**. The JSON endpoint is essentially
  `JSON.stringify(parseDotSource(source))` — zero extra runtime weight.

## Tests

- `GET /api/pipelines/:id/graph` returns `{ graph: { nodes: {...}, edges: [...], subgraphs: [...], attrs: {...} } }` with `Content-Type: application/json`. The shape matches `@swarm/core`'s `Graph` type exactly (snapshot test against a fixture workflow).
- `GET /api/pipelines/:id/graph?format=dot` returns the raw DOT source with `Content-Type: text/vnd.graphviz`.
- Unknown pipeline id → 404 (both formats).
- Unknown `?format` → 400.
- `WebInterviewer.ask(q)` resolves when a matching `POST /answer` lands.
- Multiple concurrent questions queue FIFO.
- `POST /answer` with an unknown `question_id` → 400.
- Integration: launch a pipeline with a `wait.human` node using `WebInterviewer`, assert the node pauses until an answer arrives via REST.

## Verification

- `bun run ci` passes
- Smoke:
  ```sh
  curl http://localhost:3000/api/pipelines/<id>/graph | jq '.graph.nodes | keys'
  curl http://localhost:3000/api/pipelines/<id>/graph?format=dot | head -5
  curl http://localhost:3000/api/pipelines/<id>/questions
  curl -X POST http://localhost:3000/api/pipelines/<id>/answer \
    -d '{"question_id":"q1","value":"YES"}'
  ```

## Out of scope

- SVG / PNG / any rendering — the client owns visual layout (task 06)
- Graph mutation endpoints (nodes added/removed post-parse)
- Node-level highlighting (streams via SSE, task 06)
- Interview UI (task 08)
- Authentication / multi-user question routing

## Reusable patterns

- **Graph type + parser**: `packages/core/src/types/graph.ts` (canonical
  `Graph`, `Node`, `Edge` interfaces) and
  `packages/core/src/parser/parser.ts:parseDotSource`. Already pure, no
  `node:` imports — safe to import client-side too.
- **DOT source discovery**: resume the workflow path from the run's
  summary.md or checkpoint metadata; re-read on demand.
- **Interviewer port**: `packages/core/src/types/interviewer.ts`
  (Question, Answer, Interviewer).
- **Async queue pattern**: `packages/core/src/interviewer/index.ts:QueueInterviewer`
  for one-way consumption; WebInterviewer needs a two-way channel
  (push-question-to-client + await-answer-from-client).
