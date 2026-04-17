# P5.03 — Server: graph SVG + interview endpoints

## Goal
Add two more endpoint groups to `@swarm/server`:
1. Graph rendering — turn a workflow's DOT source into SVG via `graphviz-wasm`
   so the web UI can display it without shipping a renderer.
2. Interview — answer questions coming from `wait.human` nodes, enabling a
   `WebInterviewer` backend for browser-driven approvals.

## Depends on
- P5.02 (Server REST: pipelines CRUD)

## Scope

- Files to create:
  - `packages/server/src/routes/graph.ts` — `GET /api/pipelines/:id/graph?format=svg|dot`
  - `packages/server/src/routes/interview.ts`:
    - `GET  /api/pipelines/:id/questions`  — list pending questions
    - `POST /api/pipelines/:id/answer`     — body `{ question_id, value, text? }`
  - `packages/server/src/web-interviewer.ts` — `class WebInterviewer implements Interviewer` with async queues (question and answer channels)
  - `packages/server/test/graph.test.ts`
  - `packages/server/test/web-interviewer.test.ts`
- Files to modify:
  - `packages/server/src/index.ts` — mount routes
  - `packages/server/src/process-registry.ts` — store the `WebInterviewer` instance per run so the interview routes can reach it
- Dependencies:
  - Add `graphviz-wasm` as a pinned dep

## Tests

- `GET /api/pipelines/:id/graph?format=svg` returns `<svg>…</svg>` body with `Content-Type: image/svg+xml`
- `GET /api/pipelines/:id/graph?format=dot` returns raw DOT source
- Unknown pipeline id → 404
- `WebInterviewer.ask(q)` returns a promise that resolves when `POST /answer` lands
- Multiple concurrent questions queue correctly, FIFO
- `POST /answer` with an unknown question_id → 400
- Integration: launch a pipeline with a `wait.human` node using `WebInterviewer`, assert the node pauses until an answer arrives via the REST endpoint

## Verification

- `bun run ci` passes
- Smoke:
  ```sh
  curl http://localhost:3000/api/pipelines/<id>/graph?format=svg | head -5
  curl http://localhost:3000/api/pipelines/<id>/questions
  curl -X POST http://localhost:3000/api/pipelines/<id>/answer \
    -d '{"question_id":"q1","value":"YES"}'
  ```

## Out of scope

- Node-level highlighting (that's a web-side concern — task 06)
- Interview UI (task 08)
- Authentication / multi-user question routing

## Reusable patterns

- Interviewer port: `packages/core/src/types/interviewer.ts` (Question, Answer, Interviewer)
- DOT source is stored at the workflow path — re-read on demand
- Pattern for async queues: see `packages/core/src/interviewer/index.ts:QueueInterviewer` for inspiration (but needs two-way channel)
- SVG rendering: `graphviz-wasm` has `.layout(dotSrc, 'svg', 'dot')` — module imports may need top-level await wrapper
