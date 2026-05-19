---
title: Sub-agent crash resilience — resume up to last completed turn
status: shipped
maturity: specified
last-reviewed: 2026-05-06
---

> **Shipped (2026-05-06).** Deterministic `subagent_id` (sha256 of
> parent runId/nodeId/iteration/tool_call_id), `priorMessages`
> hydration on respawn, and already-completed-transcript detection
> all landed in `packages/daemon/src/spawn-subagent.ts`. The
> `subagent.resumed` event (`{reason: "already_completed" |
>
> **Doc note (post-shipped).** Body references `fidelity=full` /
> `FidelityMode` — the runtime knob has since collapsed to "node has
> a thread_id ⇒ raw hydration; optional `summary=low|medium|high` for
> a summariser-compressed view." The shipped resilience behaviour is
> unchanged; only the authoring surface differs.
> "transcript_hydrated"}`) brackets the resume path; tests in
> `packages/daemon/test/subagent.test.ts:924,1036` cover both
> branches. The narrative below is preserved as the design record.

# Sub-agent crash resilience — resume up to last completed turn

> Make sub-agents survive a daemon crash the way codergen nodes already
> claim to: hydrate their transcript on respawn, identify them
> deterministically, and synthesise the parent's missing tool-result
> when the work was already done. Driven by orchestrate run
> `01kqyjswq14xnv2kts` losing a 48-tool-call sub-agent's worth of work
> after a daemon crash mid-flight.

## The failure

Run `01kqyjswq14xnv2kts` (orchestrator with 6 sub-agents) survived a
daemon crash at seq 2617–2629:

```
seq 2617  subagent.end          commit-2-stats-route   status: cancelled  total_tool_calls: 48
seq 2628  fact.node_aborted     cause: aborted
seq 2629  fact.run_requeued_after_crash
seq 2630  fact.dispatch_started
…
seq 2850  subagent.start        commit-2-stats-route-retry             ← fresh subagent_id, started over
seq 4933  subagent.end          status: completed                       total_tool_calls: 97
```

The first sub-agent finished 48 tool calls; the retry redid the work
from zero in 97 more. Approximately $5 of duplicate spend, ~10 min of
duplicate wallclock.

For comparison, codergen nodes nominally survive the same crash: their
transcript persists at every `message_end`, and on re-dispatch the
backend rehydrates `priorMessages` from the `messages` table. The
asymmetry is real — but verifying it required reading pi-ai internals
to confirm the contract pi-ai expects on rehydrate.

## Pi-ai contract — verified

Three pi-ai behaviors load-bear on any resume design.

### 1. `toolCall.id` round-trips byte-identically

Pi-ai's anthropic provider passes `block.id` straight through on the
provider request:

```js
// node_modules/@mariozechner/pi-ai/dist/providers/anthropic.js:844-850
else if (block.type === "toolCall") {
    blocks.push({
        type: "tool_use",
        id: block.id,                  // ← preserved verbatim
        name: ...,
        input: block.arguments ?? {},
    });
}
```

And on the receiving side, `tool_use_id` matches by id — `msg.toolCallId`
is also passed through verbatim. **Deterministic-id-from-tool_call_id
is sound.** No fallback id-mapping table required.

### 2. `agent.continue()` requires the last message to be `user` or `toolResult`

```js
// node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:61-63
if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
}
```

Swarm doesn't actually use `continue()` — it always calls
`agent.prompt(effectivePrompt)`, which appends a fresh user message and
runs the loop. But:

### 3. Anthropic rejects unpaired `tool_use` blocks

When pi-ai's `prompt()` flow runs after rehydration of a transcript
that ends `[..., assistant{toolCall}, user]`, the anthropic provider
sends both messages. Anthropic's API requires every `tool_use` block in
an assistant message to be followed by a user message containing
`tool_result` blocks for every one of them. Inserting a fresh user
prompt between them is invalid.

### What today's behavior actually is

Today this bug is *masked* because almost no production workflow uses
`fidelity=full`:

```ts
// packages/agent/src/fidelity.ts:32-35
export function shouldHydrateFromStore(fidelity: FidelityMode, isFresh: boolean): boolean {
  if (isFresh) return false;
  return fidelity === "full";
}
```

`compact` / `truncate` / `summary:*` modes never hydrate priorMessages.
The orchestrate workflow uses `default_fidelity="compact"`, so its
post-crash respawn produced a fresh agent with a digest seed — no
unpaired toolCall, but also no resume. The orchestrator just
re-decomposed the task.

So the resilience claim for codergen needs qualification:

| Mode | Crash mid-tool | Behavior on resume |
|---|---|---|
| `full` | Anywhere | Last `message_end` was assistant with toolCall → unpaired tool_use → API rejects |
| `compact` / `summary:*` | Anywhere | Fresh agent + digest seed; work redone from a coarse summary |
| `truncate` | Anywhere | Fresh agent, no transcript at all; work redone from goal |

Sub-agents specifically use `fidelity: "full"` (`spawn-subagent.ts:289`)
but receive `priorMessages: undefined` from the spawn site, so the
backend's hydration path resolves `storedForThread = []` after a daemon
restart anyway. The child always starts from zero.

## Design

Three primitives, one optional pre-flight on the parent side.

### A. Deterministic `subagent_id`

Replace `randomUUID()` (`packages/daemon/src/spawn-subagent.ts:87`) with:

```ts
const subagentId = sha256Hex(
  `${parentRunId}\0${parentNodeId}\0${parentIteration}\0${spec.tool_call_id}`
).slice(0, 32);
```

`spec.tool_call_id` is already plumbed through from
`packages/workspace/src/agent.ts:152` via `opts?.tool_call_id` on the
agent-tool's execute path. Make it required (today optional):

```ts
// packages/workspace/src/types.ts — SubagentSpec
tool_call_id: string;  // required, no longer optional
```

Concurrent siblings (parallel `agent` toolcalls in one parent message)
get distinct `tool_call_id`s from pi-ai naturally, so they hash to
distinct subagent_ids. No special handling needed.

### B. Hydrate child on respawn

In `spawn-subagent.ts`, before `deps.backend.run({...})`:

```ts
const priorRows = deps.store.getMessages(parentRunId, { nodeId: subagentNodeId });
const priorMessages = priorRows
  .map((r) => r.content)
  .filter((m) => m.role !== "system")
  // Same shape as PiCodergenBackend's externalPrior path.
  ;

// Then on the run() call:
deps.backend.run({
  ...,
  ...(priorMessages.length > 0 ? { priorMessages } : {}),
});
```

The backend already accepts `priorMessages` and feeds it into
`Agent.initialState.messages` when fidelity is full
(`backend.ts:483, 542`). For the child this is automatic — `fidelity:
"full"` is hard-coded at the spawn site.

### C. Detect already-completed sub-agents

When the parent's `agent` toolCall has already produced a final summary
(the sub-agent finished pre-crash, but the daemon died before the
parent's tool-execute promise resolved), the persisted transcript ends
with a `stopReason: "stop"` assistant message and no pending tool calls.
On respawn:

```ts
function isTranscriptComplete(messages: AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return false;
  if (last.stopReason !== "stop" && last.stopReason !== "endTurn") return false;
  // No unpaired toolCalls in the last assistant turn.
  return !last.content.some((b: any) => b.type === "toolCall");
}
```

If true, skip the LLM call entirely and synthesise the
`SubagentResult` from the existing transcript:

```ts
if (priorMessages.length > 0 && isTranscriptComplete(priorMessages)) {
  const summary = extractAssistantText(priorMessages[priorMessages.length - 1]);
  await parentCtx.parentEmit("subagent.resumed", { subagent_id, reason: "already_completed" });
  await parentCtx.parentEmit("subagent.end", {
    subagent_id, status: "completed",
    summary_chars: summary.length,
    total_tool_calls: countToolCalls(priorMessages),
    // cost rollup: zero on this resume turn — the work was already
    // billed pre-crash. Per-spawn rollup fields default to 0.
    costUsd: 0, totalTokens: 0, ...
  });
  return { summary, subagentId, status: "completed", totalToolCalls: ... };
}
```

This is the "we recover up until last finished turn" case — the
finished turn IS the whole sub-agent.

Mid-tool partial cases (the sub-agent itself was running a child tool
when the daemon died) are recursive: the child's transcript ends with
its own unpaired toolCall. Same constraint — we'd need the child to
sanitise its rehydrated transcript before pi-ai sees it. See open
questions below.

### D. Bracketing on resume

Don't re-emit `subagent.start` — the original `start` is already in the
event stream. Add `subagent.resumed { subagent_id, reason }` so:

- The parent's `useRunLive` hook can collapse the slice (UI shows one
  card with a "resumed after crash" badge instead of two starts).
- Operators reading the event stream see the resume cleanly.
- `tool_call_id` discriminator stays valid across resume.

### E. Pre-flight rehydrate sanitisation (every codergen dispatch)

When ANY codergen call (parent or sub-agent) rehydrates a transcript
ending in an unpaired toolCall, pi-ai sends it verbatim and the
provider rejects. We sanitise before pi-ai sees it. One generic pass
handles every depth — depth is bounded at 2 anyway (sub-agents can't
nest; `agent` is structurally stripped from child pools).

Lands in `PiCodergenBackend.run`, right after `hydrateMessages` is
computed, before `new Agent({initialState: ..., messages: hydrateMessages})`:

```ts
hydrateMessages = await sanitiseUnpairedToolCalls(hydrateMessages, {
  toolRegistry: this.registry,
  swarmContext,           // for tool execution (agent tool needs spawnSubagent)
  signal: input.signal,
});
```

The sanitiser scans the trailing assistant message for unpaired
`toolCall` blocks (where no following `toolResult` row exists for the
same `toolCallId`), and per block:

- **`name === "agent"`** — re-execute the agent tool via the registry
  with `tool_call_id: block.id`. The agent tool's hydrate-or-detect-
  completed path (primitives B + C above) does the right thing
  recursively: child rehydrates from `__subagent:<id>`, detects
  completed-pre-crash, synthesises `SubagentResult` without an LLM
  call, returns the toolResult.
- **Idempotent reads** (`read`, `grep`, `glob`, `ls`, `find`) — re-
  execute. Same input, same output; cheap.
- **Side-effecting tools** (`bash`, `edit`, `write`, anything else) —
  synthesise a structured error toolResult:
  ```json
  {
    "is_error": true,
    "content": "Tool '<name>' execution was interrupted by a daemon
    restart and cannot be safely replayed (the prior partial effect
    on the working tree is unknown). Re-issue the call if you still
    need this work; verify state first if the operation was
    destructive."
  }
  ```
  The parent's LLM sees the error on its next turn and decides — retry,
  reverify, abandon. **Never silently re-run a destructive tool**;
  re-running `rm -rf foo` after partial completion can cascade.

The classification lives on the tool definition itself — extend
`Tool<...>` with `idempotentOnReplay?: boolean` (default `false`,
opt-in for the small set of pure reads). Tool authors who want
re-execution opt in explicitly; the safe default is error-synthesise.

After sanitisation, hydrateMessages contains a well-paired transcript
ending in a `toolResult` message. Pi-ai's `agent.prompt(...)` flow
appends the new user message and continues cleanly.

### F. Cost rollup on resumed `subagent.end` is cumulative

The cancelled `subagent.end` from the pre-crash bracket carries the
partial cost (per the just-shipped `SubagentEndData` cost fields,
commit `19fe15a`). The resumed bracket's `subagent.end.costUsd` carries
**the cumulative total across all spawns of this subagent_id** — not
just the new turns since respawn.

On respawn, before initialising `localCostUsd` to 0, query prior
`subagent.end` events for the same `subagent_id` and seed:

```ts
const priorEnds = deps.store
  .getEventsByType(parentRunId, "subagent.end")
  .filter((e) => e.payload.subagent_id === subagentId);
const priorCost = priorEnds.reduce((s, e) => s + (e.payload.costUsd ?? 0), 0);
let localCostUsd = priorCost;
let localTotalTokens = priorEnds.reduce((s, e) => s + (e.payload.totalTokens ?? 0), 0);
// ... same for input/output/cache fields
```

Operators reading `subagent.end.costUsd` for the latest bracket of a
given `subagent_id` get the truthful end-to-end cost of the logical
sub-agent's work. Naïve summation across ALL `subagent.end` rows for
the same id over-counts — document that consumers should filter by
`subagent_id` and take the terminal (non-cancelled) bracket. The
parent's `total_cost_usd` projection is unaffected — that still folds
each `fact.node_completed`'s costUsd once.

## What this doesn't change

- **Compact-mode orchestrators still re-decompose.** A compact
  orchestrator can't see prior turns, so it emits a fresh assistant
  message with new `tool_call_id`s after restart. Those hash to fresh
  `subagent_id`s — no rehydration. The fix is for those operators to
  flip `default_fidelity="full"` if they want resume; the proposal
  doesn't change compact's semantics.
- **Cost accounting.** Per the just-shipped `[daemon] budget gate`
  fix (commit `741b0fe`), `fact.node_completed` lands on halt and the
  reactive `cost.recorded` check bounds peak overshoot. This proposal
  is orthogonal — it changes what survives across restarts, not what
  the gate sees.
- **`fact.run_requeued_after_crash`.** Already emitted by the startup
  sweep; no change needed. The new path just reads the existing fact
  as the trigger to scan for resumable sub-agents.

## Open questions (resolved)

These were genuine design choices when the proposal was first drafted;
the user signed off on the recommendations on 2026-05-06.

1. ~~**Parent rehydrate sanitisation — defer or in?**~~ **Decision: in.**
   Option E ships in v1 as a generic pre-flight that runs at every
   codergen dispatch. Closes the door on full-fidelity callers crashing
   mid-spawn instead of leaving them to discover the unpaired-tool_use
   rejection at runtime.
2. ~~**Recursive mid-tool crashes inside the sub-agent — depth bound?**~~
   **Decision: full fix regardless of depth.** Same generic sanitiser
   covers parent and child. Depth is bounded at 2 by the no-nesting
   invariant on `agent`, but the sanitiser doesn't care — it runs
   wherever a codergen call rehydrates.
3. ~~**Cost rollup on resumed `subagent.end` — per-spawn or
   cumulative?**~~ **Decision: cumulative.** The resumed bracket
   carries the truthful end-to-end cost of the logical sub-agent's
   work, seeded from prior `subagent.end` events for the same
   `subagent_id`. Documented that consumers summing cost across
   spawns must dedupe by `subagent_id` and take the terminal bracket.

## Open questions (still open)

1. **Concurrent siblings sharing `parentIteration`.** Two `agent`
   toolcalls in one assistant message both have `parentIteration:0`;
   their `tool_call_id`s differentiate them. Verified pi-ai preserves
   these (`anthropic.js:847`). Test the deterministic-hash collision
   avoidance explicitly. **Operational, not a design risk.**
2. **Agent profile drift between crash and resume.** If
   `~/.agents/agents/<name>.md` was edited mid-run, the resumed
   sub-agent's system prompt differs from the persisted system
   message. Recommendation: ignore — let the new prompt take effect on
   the next turn (the persisted system message stays in the
   transcript). Add a `system_prompt_drift: true` flag on the existing
   `agent.info { event: "thread_rehydrated" }` when the SHA changes,
   so debug can spot it.
3. **Quarantine semantics on rehydration failure.** If `JSON.parse`
   fails on a persisted message row OR the sanitiser hits a malformed
   `toolCall.arguments` (partial JSON from an aborted-mid-stream
   message), the dispatch can't recover. For sub-agents: surface as
   tool-error (`SubagentResult { status: "halted", haltReason:
   "rehydration_failed" }`) — keeps the parent's LLM in control. For
   parent-level rehydrate failure: `fact.run_quarantined { reason:
   "rehydration_failed" }` — operator decides.
4. **Idempotency classification on existing tools.** The opt-in
   `idempotentOnReplay?: boolean` flag on `Tool<...>` needs an audit
   pass: `read`, `grep`, `glob`, `ls`, `find` clearly yes; `bash`
   sometimes (depends on the command, but we can't classify
   per-invocation, so default no); `edit`/`write`/`agent` no by
   default (`agent` has its own resume path that's safer than
   re-execution). The safe-default is `false`; opt-in is the
   conscious decision per tool.

## Implementation sketch

Six commits, each independently shippable:

1. **`[workspace,daemon]` deterministic subagent_id + required
   tool_call_id.** Replace `randomUUID()` in `spawn-subagent.ts:87`
   with `sha256(parentRunId, parentNodeId, parentIteration,
   tool_call_id).slice(0,32)`. Make `tool_call_id` required on
   `SubagentSpec`. Update tests for the new contract; add an explicit
   collision test for two parallel siblings sharing `parentIteration`.
2. **`[daemon]` hydrate child on respawn.** Query
   `deps.store.getMessages(parentRunId, { nodeId: subagentNodeId })`
   in `spawn-subagent.ts`, pass via `priorMessages`. Test: a second
   spawn with the same deterministic id picks up where the first
   left off.
3. **`[daemon]` detect already-completed sub-agents on respawn.** Add
   `isTranscriptComplete` + the synthesise-result branch (`stopReason
   ∈ {"stop", "endTurn"}` and no unpaired toolCalls). Skip the LLM
   call, synthesise `SubagentResult`. Test: post-summary-pre-tool-
   result crash case.
4. **`[types,web]` `subagent.resumed` event.** New event type in
   `packages/types/src/events.ts`; UI collapses the resumed slice.
   `useRunLive` folds the new event into the existing
   `subagentByToolCallId` map. Same-PR docs obligation: ARCH §3.
5. **`[workspace,agent]` rehydrate sanitiser at every codergen
   dispatch.** New `sanitiseUnpairedToolCalls` helper in
   `packages/workspace/src/tools.ts` (or similar). Add
   `idempotentOnReplay?: boolean` to `Tool<...>`. Mark `read` /
   `grep` / `glob` / `ls` / `find` opt-in. In
   `PiCodergenBackend.run`, call sanitiser on `hydrateMessages`
   before `new Agent({...})`. Tests: agent-tool round-trip via
   sanitiser (deterministic id resolves to completed child),
   non-idempotent tool synthesises error toolResult, idempotent
   read re-executes successfully.
6. **`[daemon]` cumulative cost rollup on resumed `subagent.end`.**
   In `spawn-subagent.ts`, query prior `subagent.end` events for
   the same `subagent_id` before initialising local accumulators;
   seed from the sum. Test: resumed bracket carries cancelled +
   new totals. Same-PR doc update: ARCH §3 — note "consumers must
   dedupe by `subagent_id` and take the terminal bracket".

Total ~500–650 lines plus tests. Bigger than the original 4-commit
sketch; the additions (#5, #6) close the door on full-fidelity
callers.

## What this commits to

- Sub-agents resumed across daemon crashes are observationally
  indistinguishable from sub-agents that completed in one go (modulo
  the `subagent.resumed` event in the trace).
- The `__subagent:<id>` namespace is stable across resume — UI deep
  links keep working.
- No new database tables. The messages table already keys on
  `(run_id, node_id, iteration, ordinal)`; deterministic
  `subagent_id` slots into the existing `node_id` column under
  `__subagent:<id>`.

## What this doesn't commit to

- Resuming **compact-mode** orchestrator transcripts — those re-emit
  fresh tool_call_ids on restart, so deterministic hashing doesn't
  apply. Compact orchestrators recover by re-decomposing from a
  digest seed, finding any completed sub-agents via the deterministic
  id only when the new decomposition happens to produce the same
  tool_call_id (rare). Authors who want full crash-resilience flip
  `default_fidelity="full"` and rely on primitive E.
- Resuming **mid-LLM-stream** assistant messages where the partial
  toolCall arguments are malformed JSON. Pi-ai persists at
  `message_end` only; partial streams aren't persisted. The sanitiser
  rejects malformed JSON it finds in priorMessages and surfaces
  `rehydration_failed` per the open-question table.
- Replaying **non-idempotent tools** silently. The opt-in
  `idempotentOnReplay` flag is the only authorised re-run path;
  everything else gets an error toolResult that surfaces the
  interruption to the LLM. Operators who want a tool to re-run on
  resume opt in explicitly per tool definition.
