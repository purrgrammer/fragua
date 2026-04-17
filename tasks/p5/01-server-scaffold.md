# P5.01 — @swarm/server scaffold + SSE event stream

## Goal
Create a new `@swarm/server` package that exposes the live event stream of any
run via Server-Sent Events. A browser opening `GET /api/runs/:id/events`
receives every line of `.swarm/runs/:id/events.jsonl` parsed as an SSE frame,
plus any new lines as they're appended.

## Depends on
None — this is the first server task.

## Scope

- Files to create:
  - `packages/server/package.json` (private workspace package)
  - `packages/server/tsconfig.json` (extends root, emits nothing)
  - `packages/server/src/index.ts` (createServer factory + ports type)
  - `packages/server/src/routes/health.ts` (`GET /health` → `{ ok: true }`)
  - `packages/server/src/routes/events.ts` (`GET /api/runs/:id/events` SSE)
  - `packages/server/test/events-sse.test.ts`
- Files to modify:
  - root `package.json` — add `@swarm/server` to workspace (if not auto-detected)
- Public API:
  - `export function createServer(opts: { runsDir: string }): Hono`
  - Hono is the HTTP framework; tail the events.jsonl with `fs.watch` or poll.

## Tests

- `packages/server/test/events-sse.test.ts`:
  - Start server against a tmp runsDir with a pre-seeded events.jsonl
  - Open SSE stream, read first N events, assert they match the file
  - Append a new line to the file, assert the stream emits it within ~200ms
  - Cancel the stream and verify the server cleans up watchers

## Verification

- `bun run ci` passes (new package typechecks, tests pass)
- Smoke: `curl -N http://localhost:3000/api/runs/<id>/events` streams JSON lines
  as `event: ...\ndata: {...}\n\n` frames

## Out of scope

- Do NOT add authentication/CORS/rate-limit yet — single-user local tool
- Do NOT integrate with the CLI yet (that's task 04)
- Do NOT write the web UI (that's task 05)
- Do NOT add graph or interview endpoints (task 03)

## Reusable patterns

- Event shape: `packages/core/src/types/events.ts` (Event interface)
- Runs directory layout: `.swarm/runs/<id>/events.jsonl`
- Workspace package pattern: mirror `packages/events/package.json`
- Add `hono` as a pinned dep — use the latest stable (check current bun.lock)
