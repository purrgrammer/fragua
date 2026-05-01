---
title: Sane + configurable handler timeouts
status: proposed
maturity: specified
last-reviewed: 2026-05-01
---

# Plan: sane + configurable handler timeouts

## Context

Four runs halted with `fact.run_halted{reason:"error", detail:"Request was aborted."}` at exactly 300.0–302.7 s into the `implement` node (e.g. `01kpr6js26nc8txhr6`, `01kpr6w71v28f45t29`). The cause: the codergen handler's hardcoded 5-minute default at `packages/agent/src/handler-bridge.ts:48`, enforced via `AbortSignal.timeout(spec.maxMs)` in `packages/daemon/src/executor.ts`. The agent was mid-stream finishing a tool-loop turn when the deadline fired.

Three problems, not one:

1. **The 5-minute default is too tight for LLM work.** Observed-successful durations from the event log:

   | node | n | max | avg | 5-min margin |
   | --- | --- | --- | --- | --- |
   | implement | 11 | 251.7 s | 111.5 s | 48 s |
   | plan | 8 | 242.3 s | 167.1 s | 58 s |
   | verify | 9 | 89.0 s | 41.7 s | comfortable |
   | review / commit / merge / update_docs | — | ≤ 57 s | — | comfortable |

   Both `implement` and `plan` (same codergen backend) sit within a minute of the cap in their observed max. One slow tool call → lost run.

2. **Timeouts are not configurable.** DOT nodes cannot override `maxMs`, and `SwarmConfig` in `packages/cli/src/config.ts` has no `timeouts:` key. The `auto-dispatcher.ts` even has a TODO comment acknowledging `timeout` attr parsing is unwired.

3. **The timeout-to-halt path is silently lossy.** When the deadline fires, the Anthropic SDK surfaces `AbortError{ message: "Request was aborted." }`, the codergen handler catches it as a generic error, and the daemon writes `fact.run_halted { reason: "error", detail: "Request was aborted." }`. The event taxonomy already has a slot for this — `fact.node_aborted { cause: "timeout" }` — and it is not being filled. Run status does not reflect that a timeout occurred. Post-mortems are harder than they should be.

Goal: bump unsafe defaults, plumb per-node `maxMs` / `timeout` overrides through the DOT parser, add a `timeouts:` config layer, fix the observability bug so timeouts are labeled as timeouts, and leave internal correctness-critical knobs (supervisor tick, SQLite busy_timeout, SSE poll) alone.

## Scope — what's in / what's not

**In scope (user-tunable):**

| Kind | File:line | Current default | Proposed default | Config key |
| --- | --- | --- | --- | --- |
| codergen (LLM agent) | `packages/agent/src/handler-bridge.ts:48` | 5m | **30m** (safety net, see below) | `timeouts.codergen` |
| tool (shell) | `packages/core/src/handler/handlers/tool.ts:72` | 5m | 5m (keep) | `timeouts.tool` |
| worktree bootstrap | `packages/workspace/src/worktree-env.ts:47` | 10m | 10m (keep) | `timeouts.bootstrap` |
| local-env shell default | `packages/workspace/src/local-env.ts:14` | 30s | 30s (keep) | `timeouts.shell` |
| HTTP client | `packages/core/src/handler/http-client.ts:21` | *unset* | 30s | `timeouts.http` |
| supervisor leak grace | `packages/daemon/src/executor.ts:56` + `supervisor.ts:31` | 5s | 10s | `timeouts.leak_grace` |
| shutdown drain | `packages/daemon/src/executor.ts:57` | 30s | 30s (keep) | `timeouts.shutdown_drain` |

**Rationale for the 30m codergen default**: a cap is **not** there to police slow LLMs — it is there to catch **runaway tool loops** (agent stuck re-running the same failing bash command, consuming tokens indefinitely). Without a cap, a wedged run silently burns money until a human notices. Budgets (`graph.attrs.budget_usd`, `budget.warn`, `budget.stop`) are the right abstraction, but are declared-not-wired today (per `docs/ARCHITECTURE.md §13.1`). 30 minutes is ~7× the observed max (251.7 s) — zero false positives, still catches a wedged agent within half an hour. **Once budgets enforce, drop this cap.** Document inline in `handler-bridge.ts` so the intent survives.

**Parallel — no own cap.** The original plan proposed bumping parallel from 10m → 15m. We are instead **removing parallel's independent timeout** entirely and letting child nodes self-police via their own `maxMs`. Parallel is orchestration, not a deadline in its own right. Simpler, one fewer knob, matches the natural "parallel completes when slowest child completes" semantics.

**Out of scope (correctness-critical internal knobs, keep hardcoded):**

- Supervisor tick (`50ms` — `supervisor.ts:29`) and heartbeat (`5s` — `supervisor.ts:30`)
- Daemon lock TTL (`30s` — `entrypoint.ts:42`, tied to heartbeat; changing one without the other breaks crash detection)
- SSE poll (`100ms` — `server/src/store/routes.ts:48`)
- SQLite `busy_timeout` (`5s` — `store/src/pragmas.ts:14`)
- Fan-in reducer (`1s` — `fan-in.ts:30`) and wait-human (`1s` — `wait-human.ts:41`) — these are synchronous; exceeding 1s means a bug, not a slow model
- Auto-dispatcher 50ms fallback specs (start/exit/conditional) — pure transitions
- Executor poll (`50ms` — `executor.ts:55`)

**Also fix:** `packages/daemon/src/entrypoint.ts:87` — the `handlerMaxMsFor` fallback of `30_000` when the dispatcher has no spec. Should fall back to the codergen default (the expensive case) so the supervisor watchdog never trips a legit LLM node earlier than the executor's own deadline. Read the file to confirm the exact shape before editing.

## Precedence

For any timeout:

1. DOT node attr — `maxMs=<number ms>` or `timeout="<duration string>"`
2. `.swarm/config.yaml` → `timeouts.<kind>`
3. Hardcoded default

CLI flags are not added here (no current use case; they can ride on top later).

## Observability fix: timeouts must be tagged

When `ctx.signal.aborted` fires due to the handler's `maxMs` deadline (not an operator intent), the flow must be:

1. Codergen handler's catch block distinguishes `AbortError` caused by deadline from a generic error. Simplest test: `err.name === "AbortError" && ctx.signal.aborted && !ctx.signal.reason?.startsWith("intent.")`. Prefer stamping the abort reason on `ctx.signal` at abort-time (`controller.abort("timeout")` in the executor) so the handler can read `ctx.signal.reason` directly — that's the canonical AbortSignal mechanism and avoids string sniffing.
2. Handler returns a handler result that the dispatcher projects as `fact.node_aborted { cause: "timeout" }` **before** the run-level halt.
3. Run-level halt uses `fact.run_halted { reason: "error", detail: "node <id> exceeded maxMs <N>" }` (or similar — the existing `"Request was aborted."` is fine if the preceding `fact.node_aborted { cause: "timeout" }` is present; the post-mortem reads the node-abort first).

Same pattern applies to the tool handler's shell timeout — if a tool hits its own `maxMs`, emit `fact.node_aborted { cause: "timeout" }` with the tool context.

Net effect: `run_state.status = "halted"` + last `fact.node_aborted { cause: "timeout" }` is a clean one-query diagnosis. The swarm-debug skill's §8 failure-mode playbook already describes this path; it just isn't wired.

## Invalid attr behavior: fail fast at enqueue

If a DOT node declares `timeout="garbage"` or `maxMs=-5`, the run must **never reach the dispatcher**. Parse happens at `POST /runs` (where DOT is parsed for the `workflow_sha` lookup / graph validation). On invalid duration → return HTTP 400 with a clear message naming the node + attr. No run row is created.

This is cleaner than the original plan's "halt spec with detail": no orphaned halted run, faster feedback to the user, no daemon work wasted.

## Implementation

### 1. Duration parser (shared util)

New file: `packages/core/src/duration.ts`

```ts
// Accepts "500ms" | "30s" | "5m" | "2h" | plain integer (ms). Throws on
// invalid input — callers that want a soft fallback wrap in try/catch.
export function parseDurationMs(input: string | number): number
```

Minimal grammar: `/^(\d+)(ms|s|m|h)?$/`. Reject negatives, zero (caller-friendly error), NaN. Existing `packages/web/src/lib/time.ts` formats durations for display; this is the inverse and belongs in core so both CLI (config) and daemon (DOT) and API (enqueue validation) can import it without pulling in web.

Unit tests: `packages/core/test/duration.test.ts` — happy path for each unit, plain-int pass-through, invalid input throws.

### 2. DOT attr → `maxMs` wiring

File: `packages/daemon/src/auto-dispatcher.ts`

In `specForNode` (around line 170) and at the codergen-factory call site in `packages/cli/src/commands/daemon.ts:190`, resolve `maxMs` from node attrs:

```ts
function resolveMaxMs(attrs, fallback): number {
  if (typeof attrs.maxMs === "number") return attrs.maxMs;
  if (typeof attrs.timeout === "string") return parseDurationMs(attrs.timeout);
  return fallback;
}
```

Wire it into:

- `makeCodergenHandler({ node, backendOpts, maxMs })` — `handler-bridge.ts:175` already forwards `opts.maxMs ?? DEFAULT_MAX_MS`, so this just needs the factory site at `daemon.ts:190` to read attrs.
- `makeToolHandler({ toolCommand: cmd, maxMs })` — `tool.ts:144` already accepts it; pass from `auto-dispatcher.ts:190`.

Parallel: no `maxMs` parameter — remove the `DEFAULT_PARALLEL_TIMEOUT_MS` fallback in `packages/core/src/handler/handlers/parallel.ts:64` and the corresponding usage site; children's own `maxMs` governs.

Invalid duration attrs do **not** reach this path — rejected at enqueue (see §3 below). `resolveMaxMs` can therefore trust its inputs and skip re-validation.

### 3. Enqueue-time validation

File: wherever `POST /runs` parses the DOT source (likely `packages/server/src/routes/runs.ts` — confirm by reading the file). After graph validation but before `INSERT INTO runs`:

```ts
for (const node of parsed.nodes) {
  if (node.attrs.timeout != null) {
    try { parseDurationMs(node.attrs.timeout); }
    catch (e) { return res.status(400).json({ error: `node "${node.id}": invalid timeout "${node.attrs.timeout}" — ${e.message}` }); }
  }
  if (node.attrs.maxMs != null && (typeof node.attrs.maxMs !== "number" || node.attrs.maxMs <= 0)) {
    return res.status(400).json({ error: `node "${node.id}": invalid maxMs "${node.attrs.maxMs}"` });
  }
}
```

### 4. `.swarm/config.yaml` `timeouts:` section

File: `packages/cli/src/config.ts`

Extend `SwarmConfig`:

```ts
timeouts?: {
  codergen?: string | number;
  tool?: string | number;
  bootstrap?: string | number;
  shell?: string | number;
  http?: string | number;
  leak_grace?: string | number;
  shutdown_drain?: string | number;
};
```

(No `parallel` key — parallel has no own cap, per §Scope.)

Resolution happens in `packages/cli/src/commands/daemon.ts`:

- Parse each present key once via `parseDurationMs` at daemon startup.
- Pass the resolved ms numbers into the codergen factory / tool factory as the per-kind default, replacing the hardcoded fallbacks in `resolveMaxMs`.
- Pass `leak_grace` to `startExecutor` (currently uses `DEFAULT_LEAK_GRACE_MS` — add an opt).
- Pass `shutdown_drain` similarly.
- Pass `bootstrap` to `WorktreeProvisioner` (currently reads `bootstrapTimeoutMs` from its own opts; wire through).
- Pass `http` to the `makeHttpClient` factory in `core/src/handler/http-client.ts` (opt already exists — just supply it).

Invalid config values → daemon startup fails loudly with a clear error naming the key. Don't silently fall through to defaults; config errors are user-visible only at daemon start, so ignoring them means confusing mid-run behavior.

### 5. Bump codergen default

`packages/agent/src/handler-bridge.ts:48` — `DEFAULT_MAX_MS = 5 * 60 * 1000` → `30 * 60 * 1000`.

Inline comment:
```
// Safety net for runaway tool loops, NOT a policy ceiling for legitimately
// long agent work. Observed max successful implement/plan is ~4m on this
// codebase; 30m gives 7x headroom. When budget enforcement lands
// (ARCHITECTURE §13.1, `budget.stop`), this cap can be dropped — the
// $-budget is the correct fence, wall-clock is just a proxy.
```

Update the two `supervisor`/`executor` `DEFAULT_LEAK_GRACE_MS` constants from 5s → 10s (`packages/daemon/src/executor.ts:56`, `packages/daemon/src/supervisor.ts:31`). At 30-minute agent calls, a 5-second grace is twitchy; 10s is still quick without being flaky.

### 6. Fix the supervisor fallback

`packages/daemon/src/entrypoint.ts:87` — the unknown-spec fallback of 30s will trip any codergen node that somehow escapes the dispatcher before the executor's own deadline fires. Change to the codergen default (or, better, pass the resolved config so it stays in sync).

### 7. Timeout → `fact.node_aborted { cause: "timeout" }` wiring

File: `packages/daemon/src/executor.ts` (around line 271 where `AbortSignal.timeout(spec.maxMs)` is set).

- Replace `AbortSignal.timeout(ms)` with an explicit `AbortController` so we can call `controller.abort("timeout")` on expiry. This stamps `signal.reason = "timeout"` (or a structured reason object) which the handler reads to distinguish.
- Wrap handler invocation: on `signal.aborted && signal.reason === "timeout"` (or the structured equivalent), project the result as a `node_aborted` with `cause: "timeout"` instead of a generic handler error.

File: `packages/agent/src/handler-bridge.ts` — codergen catch block does **not** need to change if the dispatcher wrapper handles it. Verify the call stack by reading the file before writing the fix.

File: `packages/core/src/handler/handlers/tool.ts` — same pattern for shell-tool timeouts (its `maxMs` is enforced locally; it should emit `{ kind: "abort", cause: "timeout" }` in its return, which the dispatcher already projects to `fact.node_aborted { cause: "timeout" }` per `docs/ARCHITECTURE.md §3`).

### 8. Explicit override on the hot workflow

`workflows/build-feature.dot` — **skip for now.** The 30m default is already ~7× the observed max, so explicit overrides would just be clutter. If a specific node ever needs a different cap, add `timeout="…"` then. Intent is better documented by the comment on `DEFAULT_MAX_MS`.

## Critical files

- `packages/agent/src/handler-bridge.ts` (bump default, comment the intent)
- `packages/core/src/duration.ts` (new)
- `packages/core/src/handler/handlers/parallel.ts` (remove own-cap fallback)
- `packages/core/src/handler/handlers/tool.ts` (no default change — confirm factory path forwards maxMs; wire timeout→abort-with-cause)
- `packages/core/src/handler/http-client.ts` (supply default timeout)
- `packages/daemon/src/auto-dispatcher.ts` (DOT attr → maxMs via `resolveMaxMs`)
- `packages/daemon/src/executor.ts` (bump leak grace, accept opts, explicit AbortController + `abort("timeout")`, project timeout cause)
- `packages/daemon/src/supervisor.ts` (bump leak grace default)
- `packages/daemon/src/entrypoint.ts` (fix 30s fallback, plumb config)
- `packages/server/src/routes/runs.ts` (enqueue-time validation) — **confirm path by reading before editing**
- `packages/workspace/src/worktree-env.ts` / `local-env.ts` (accept config-injected defaults)
- `packages/cli/src/config.ts` (schema extension)
- `packages/cli/src/commands/daemon.ts` (wire config → factories)

## Existing utilities to reuse

- `packages/workspace/src/local-env.ts:14` already accepts `defaultTimeoutMs` via constructor — just supply it from config, don't rewrite.
- `packages/core/src/handler/http-client.ts:5` already has `defaultTimeoutMs` optional opt — same.
- `packages/agent/src/handler-bridge.ts:175` already has `opts.maxMs ?? DEFAULT_MAX_MS` — just feed it from the factory.
- `packages/core/src/handler/handlers/tool.ts:144` — same pattern, already plumbed.

The plumbing is mostly "read the config + DOT attr, pass to existing opts." No handler internals change except the abort-with-cause plumbing in §7.

## Verification

1. **Unit tests (fast, deterministic):**
   - `packages/core/test/duration.test.ts` — parser covers `ms/s/m/h`, bare ints, rejects `"-5s"`, `"0"`, `"5x"`, `""`.
   - `packages/daemon/test/auto-dispatcher.test.ts` — new cases: DOT with `maxMs=60000` → spec.maxMs=60000; DOT with `timeout="2m"` → 120_000; no attr → fallback.
   - `packages/server/test/routes.runs.test.ts` (or equivalent) — enqueue with `timeout="garbage"` → 400; enqueue with `maxMs=-5` → 400; no run row created.
   - `packages/cli/test/config.test.ts` — `timeouts.codergen: "30m"` parses to 1_800_000; absent section → `undefined` (defaults apply downstream); invalid value at daemon start → startup error.
   - `packages/agent/test/handler-bridge.test.ts` — existing test file; add case for explicit `maxMs` override.
   - New: timeout-cause projection test — stub a handler that hangs, set `maxMs=50`, assert the event stream contains `fact.node_aborted { cause: "timeout" }` before `fact.run_halted`.

2. **End-to-end (the original failure):**
   - `bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot --input="<the input from run 01kpr6js26nc8txhr6>"` and confirm it reaches `merge` (or at minimum `implement → review` without an `aborted` halt at 5 min).
   - Query: `sqlite3 .swarm/swarm.db "SELECT status FROM run_state WHERE run_id=<new_id>"` — expect no `halted` from timeout.

3. **Regression check:**
   - `bun run ci` (full suite).
   - Confirm fan-in / wait-human / SSE / SQLite tests still pass — those paths shouldn't have changed.

4. **Config smoke:**
   - Add `timeouts: { codergen: "1s" }` to `.swarm/config.yaml`, run any LLM workflow, confirm it halts near 1 s AND the terminal event is `fact.node_aborted { cause: "timeout" }` followed by `fact.run_halted`. Revert.

5. **DOT smoke:**
   - Add `timeout="1s"` to an `implement` test-workflow node, confirm the per-node override beats the config, same observability invariant holds.
   - Add `timeout="garbage"` to a node, `POST /runs`, confirm 400 + no run row.

## Non-goals

- No CLI flags for timeouts (can layer on later).
- No per-run override via API/web (out of scope — users edit config or DOT).
- No changes to supervisor tick, SSE poll, SQLite busy_timeout, heartbeat, or daemon lock TTL.
- No fix for `<abort>REJECT: …</abort>` showing up as `reason:"error"` in `fact.run_halted` (separate bug — should route through the documented `aborted_exit` path per swarm-debug §8). File its own ticket.
