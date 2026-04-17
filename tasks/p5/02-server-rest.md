# P5.02 — Server REST: pipelines CRUD

## Goal
Extend `@swarm/server` with REST endpoints that launch, list, inspect, and
cancel pipeline runs. Launching a pipeline spawns a child `swarm run` process
that writes to the same runs directory the SSE stream tails.

## Depends on
- P5.01 (`@swarm/server` scaffold + SSE events)

## Scope

- Files to create:
  - `packages/server/src/routes/pipelines.ts`
    - `POST   /api/pipelines`     — body: `{ workflow, input?, inputFiles?, provider?, model?, worktree? }` → `{ run_id, events_url }`
    - `GET    /api/pipelines`     — list recent runs from `runsDir` (mirror `swarm list` logic)
    - `GET    /api/pipelines/:id` — status + outcome + cost aggregate for one run
    - `DELETE /api/pipelines/:id` — signal running child to abort (SIGINT)
  - `packages/server/src/process-registry.ts` — track run_id → ChildProcess (in-memory)
  - `packages/server/test/pipelines.test.ts`
- Files to modify:
  - `packages/server/src/index.ts` — mount the new routes
- Public API:
  - `export interface LaunchPipelineOptions { workflow: string; input?: string; inputFiles?: string[]; provider?: string; model?: string; worktree?: boolean }`
  - `export function launchPipeline(opts): Promise<{ run_id: string; pid: number }>`

## Tests

- `POST /api/pipelines` with mock backend → returns 200 + run_id, child process appears in registry
- `GET /api/pipelines` returns >=1 entry after a launch
- `GET /api/pipelines/:id` reflects status ("running" → "success"/"fail")
- `DELETE /api/pipelines/:id` aborts the child (wait, verify exit code)
- Invalid workflow path → 400
- Missing provider credentials → 400 (reuse `hasProviderCredentials`)

## Verification

- `bun run ci` passes
- Smoke:
  ```sh
  bun run packages/cli/bin/swarm.ts serve --port 3000 &  # (will be task 04 — use direct server start for now)
  curl -X POST http://localhost:3000/api/pipelines \
    -H 'Content-Type: application/json' \
    -d '{"workflow":"examples/hello.dot","input":"say hi"}'
  ```

## Out of scope

- No auth, no rate limits (single-user local)
- No worker queue — one pipeline per request spawned via `child_process.spawn`
- No graph SVG endpoint (task 03)
- No interview endpoints (task 03)
- `swarm serve` CLI wiring (task 04)

## Reusable patterns

- List logic: `packages/cli/src/commands/list.ts` reads `.swarm/runs/` and returns recent outcomes
- Cost aggregation: `packages/events/src/console.ts:ConsoleSink.totals`
- Provider checks: `packages/agent/src/providers.ts:hasProviderCredentials`
- Spawn pattern: use `Bun.spawn` or Node's `child_process.spawn` with `packages/cli/bin/swarm.ts` as the binary
