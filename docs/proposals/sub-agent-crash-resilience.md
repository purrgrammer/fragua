---
title: Sub-agent crash resilience — resume up to last completed turn
status: proposed
maturity: designed
last-reviewed: 2026-05-06
---

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

### E. Parent pre-flight (optional follow-up — full-fidelity callers)

When the parent itself uses `fidelity=full` and rehydrates a transcript
ending in an unpaired `agent` toolCall, the child rehydration kicks in
via the natural agent-tool execute path — but pi-ai needs to actually
EXECUTE that tool, which only happens on a fresh assistant turn. The
rehydrated transcript would have to be sanitised first.

Two options:

1. **Pre-spawn sweep.** Before `agent.prompt(effectivePrompt)`, scan
   `priorMessages` for unpaired `toolCall { name: "agent" }` blocks,
   resolve them via the tool registry directly (running the agent tool
   with its hydrate-+-detect-completed path), insert synthesised
   `toolResult` messages after the assistant turn. Pi-ai sees a valid
   transcript and continues from a clean boundary.
2. **Wait for compact-fidelity orchestrators only.** Punt full-fidelity
   resume until someone actually wants it; document that
   `fidelity=full` runs lose work on crash today and the proposal
   covers the sub-agent slice only.

Option 2 keeps the scope tight. Production today is compact; the
sub-agent recovery primitive is the immediate win. Mark Option 1 as a
deferred follow-up.

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

## Open questions

1. **Parent's pi-ai `agent.prompt` after rehydrate.** Even with
   deterministic ids and child hydration, the parent still needs a
   valid transcript before pi-ai's call. Option E above covers this;
   the open question is whether to land it in this PR or defer.
   Recommendation: defer — compact-mode orchestrators are the v1
   target; the sub-agent primitive is independently useful for
   future-proofing.
2. **Mid-tool crashes inside the sub-agent.** The child's transcript
   could end with an unpaired toolCall (e.g. `bash` was running when
   the daemon died). Same recursive problem. Acceptable v1 behavior:
   the child rehydrates whatever's there, pi-ai sends the unpaired
   toolCall to the provider, the provider rejects, the child's run()
   returns `Outcome.fail(...)`, the parent gets a tool-error
   `SubagentResult` and decides what to do. Not great but bounded —
   the child can be re-spawned by the parent's LLM with a different
   prompt.
3. **Concurrent siblings sharing `parentIteration`.** Two `agent`
   toolcalls in one assistant message both have `parentIteration:0`;
   their `tool_call_id`s differentiate them. Verified pi-ai
   preserves these (anthropic.js:847). Test the deterministic-hash
   collision avoidance explicitly.
4. **Agent profile changes between crash and resume.** If
   `~/.agents/agents/<name>.md` was edited mid-run, the resumed
   sub-agent's system prompt would differ from the persisted system
   message. Options: (a) ignore — let the new prompt take effect on
   the next turn (the persisted system message stays in the
   transcript), (b) refuse to resume on system-prompt drift. The
   resume signal already lands as `agent.info { event:
   "thread_rehydrated" }`; adding a `system_prompt_drift: true` flag
   when the SHA changes is cheap.
5. **Quarantine semantics on child rehydration failure.** If
   `JSON.parse` fails on a persisted message row, the child can't
   recover. Should this halt the parent (`fact.run_quarantined`) or
   surface as a tool-error (`SubagentResult { status: "halted",
   haltReason: "rehydration_failed" }`)? Tool-error is the natural
   shape — keeps the parent's LLM in control. Add a structured
   `haltReason: "rehydration_failed"` so debug can spot it.

## Implementation sketch

Four commits, each independently shippable:

1. **`[workspace,daemon]` deterministic subagent_id + required
   tool_call_id.** Replace `randomUUID()` in `spawn-subagent.ts:87`.
   Make `tool_call_id` required on `SubagentSpec`. Update tests for the
   new contract.
2. **`[daemon]` hydrate child on respawn.** Query
   `deps.store.getMessages(parentRunId, { nodeId: subagentNodeId })` in
   `spawn-subagent.ts`, pass via `priorMessages`. Add a test that a
   second spawn with the same deterministic id picks up where the
   first left off.
3. **`[daemon]` detect already-completed sub-agents on respawn.** Add
   `isTranscriptComplete` + the synthesise-result branch. Emit
   `subagent.resumed`. Add a test for the post-summary-pre-tool-result
   crash case.
4. **`[types,web]` `subagent.resumed` event.** New event type in
   `packages/types/src/events.ts`; UI collapses the resumed slice.
   `useRunLive` folds the new event into the existing `subagentByToolCallId`
   map. Same-PR docs obligation: ARCH §3 event taxonomy.

Total ~250–350 lines plus tests. Smaller than the [agent-tool](./agent-tool.md)
landing.

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
  apply. Scope of this proposal is sub-agent slices only.
- Resuming **mid-LLM-stream** assistant messages where the partial
  toolCall arguments are malformed JSON. Pi-ai persists at
  `message_end` only; partial streams aren't persisted. Out of scope
  by construction.
- Resuming **parent transcripts with unpaired toolCalls** (Option E
  above). Deferred — only matters when full-fidelity orchestrators
  exist in production.
