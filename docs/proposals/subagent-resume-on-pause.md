---
title: Graceful sub-agent resume across pause boundaries
status: shipped
maturity: specified
last-reviewed: 2026-05-19
---

# Graceful sub-agent resume across pause boundaries

> **Status: shipped via a different path than Options A/B sketched
> below.** The implementation is a content-addressed FIFO queue in
> `packages/daemon/src/spawn-subagent.ts:findPendingResumeCandidate`,
> driven by `subagent.start.args_hash` (sha256 over the spec's
> canonical args, computed by the `agent` tool at execute time).
> A cancelled bracket enters a queue keyed by `(parent_run,
> parent_node_id, iteration, args_hash)`; the next spawn with
> matching args pops the oldest pending entry and resumes it.
> Symmetric with regular-tool rehydrate (nothing is silently
> rewritten — the cancelled toolResult stays in the transcript),
> no LLM cooperation required, no asymmetry between sub-agents
> and other tools. See `packages/daemon/test/subagent.test.ts` →
> "content-addressed pending-resume FIFO queue" suite for the
> proof.
>
> The Options A (silent rollback of cancelled toolResults at
> pause-commit) and B (explicit `resume_subagent_id` parameter)
> sketched below are obsolete — they were inconsistent with
> regular-tool rehydrate (A) or relied on LLM cooperation (B).
> Kept here for design-history context.

## Problem

When a parent run pauses mid-flight (today: budget cap, provider
error, watchdog timeout), in-flight `agent`-tool sub-agents are
aborted via the `steerCtrl → agent.abort() → tool.execute(signal) →
spec.signal → childCtrl` cascade. The cascade is intact (see
`packages/daemon/test/subagent.test.ts` →
"mid-flight parent abort propagates into sub-agent's already-running
backend signal"). The sub-agent unwinds, its partial transcript stays
durable in the `messages` table keyed by `__subagent:<id>`, and
`subagent.end{status:"cancelled"}` lands on the parent's stream with
the partial cost rolled up.

On resume after the operator lifts the cap (or the provider clears):

1. The parent's last assistant turn already has a paired toolResult
   for each cancelled sub-agent (`agent` tool returned
   `is_error:true, text:"(sub-agent terminated with status=cancelled …)"`
   before the abort caught it; pi-agent persisted that toolResult via
   `persistMessage`).
2. `sanitiseUnpairedToolCalls` on the parent's rehydrate sees only
   paired toolCalls → no re-execution.
3. Pi-agent's loop continues from the resumed transcript. The LLM
   reads the cancelled toolResult and decides on its own whether to
   retry. A retry generates a fresh `tool_call_id` (pi-ai mints a new
   id per emitted toolCall) → fresh deterministic `subagent_id` → the
   crash-resilience path in `spawn-subagent.ts` finds no prior
   messages → the sub-agent starts from scratch.

Concretely: the cost was incurred ($1.21 → $1.60 in the original
incident), the transcript is durable, but the LLM gets no automatic
benefit on retry — it can either redo the work or skip it based on
the cancelled toolResult text.

## Why this is the next layer down's problem

The lower-level invariant — "same `(parentRunId, parentNodeId,
parentIteration, tool_call_id)` ⇒ same `subagent_id` ⇒ prior
transcript is replayed" — already holds. The gap is in WHICH
`tool_call_id` the resumed parent's pi-agent loop ends up calling
the agent tool with.

Two ways to close the gap:

### Option A — leave the cancelled toolCall unpaired

When the parent pauses with in-flight sub-agents, DON'T persist their
cancelled toolResults. The parent's prior transcript on resume has
unpaired `agent` toolCalls; `sanitiseUnpairedToolCalls` re-executes
them; spawn-subagent gets the same `tool_call_id` (recovered from the
prior assistant message); deterministic `subagent_id` matches; prior
transcript hydrates; the sub-agent picks up where it left off.

Implementation surface:
- `packages/agent/src/handler-bridge.ts` — `persistMessage` already
  appends every message pi-agent emits. Need to roll back the
  cancelled toolResult rows for `agent` tool calls when the parent
  commits `fact.run_paused` due to abort.
- Cleanest place to roll back: the executor's pause-commit path
  (`packages/daemon/src/executor.ts:946–959`). After the abort,
  before committing `fact.run_paused`, query the messages table for
  toolResult rows that match cancelled sub-agents (by `tool_call_id`
  appearing in `subagent.end{status:"cancelled"}` events for this
  dispatch) and delete them.
- `sanitiseUnpairedToolCalls` already re-executes `agent` (it's the
  hard-coded "can re-execute" case in
  `packages/workspace/src/tools.ts:559`), so the resume side needs
  no changes.

Pro: invisible to the LLM; "just works".
Con: a partial assistant turn is persisted with toolCalls that no
longer have results — replay relies on the sanitiser, which is a
contract the user can't see in the UI without explanation.

### Option B — expose the prior `subagent_id` to the LLM for explicit resume

Add a `resume_subagent_id` optional parameter to the agent tool.
When set, spawn-subagent uses it directly instead of computing the
deterministic id from inputs. The cancelled toolResult text already
carries the `subagent_id` in its `data` field; surface it in the
visible text so the LLM can echo it back on retry.

Implementation surface:
- `packages/workspace/src/agent.ts` — add `resume_subagent_id` to
  `AgentToolArgs` schema; forward to `SubagentSpec.resume_subagent_id`.
- `packages/daemon/src/spawn-subagent.ts` — when
  `spec.resume_subagent_id` is set, use it as `subagentId` instead of
  the deterministic hash; hydration follows the same path.
- `packages/workspace/src/agent.ts` execute return value — when
  status === "cancelled", include the `subagent_id` in the text body
  along with a hint like "resume by passing
  `resume_subagent_id: <id>` on retry".

Pro: explicit; the LLM and the operator both see it.
Con: relies on the LLM following the hint; a model that doesn't
read tool data will redo the work; introduces a new parameter that
needs documentation.

## Recommended path

Option A (silent rollback) is the right end-state because it makes
graceful resume the default. Operators expect "pause + resume" to
mean "pick up where you left off", and the deterministic-id
machinery already exists to support that — only the rollback of
cancelled toolResults is missing.

Option B is a cheap stop-gap if Option A's rollback is delayed:
ship the `resume_subagent_id` parameter + LLM hint first, observe
how often the LLM uses it, then decide whether to also do the
silent rollback.

## Open questions

- **Which pause reasons should trigger the rollback?** Budget pause
  and watchdog timeout are the obvious candidates. Provider error
  may not need it — the sub-agent itself didn't fail, the parent's
  next provider call did, so the cancelled toolResult is misleading.
  Probably: rollback whenever `subagent.end{status:"cancelled"}`
  appears in the dispatch's event slice.
- **Partial-assistant-message replay.** Pi-agent's
  `sanitiseUnpairedToolCalls` re-executes the agent tool but the
  ASSISTANT message itself (containing the toolCall) is unchanged.
  Does pi-agent's replay handle "assistant + replayed toolResult"
  cleanly, or does it re-emit the assistant turn? Verify before
  shipping.
- **Per-sub-agent rollback granularity.** A parent turn may have
  N parallel sub-agents, M of which completed successfully before
  the budget pause. The rollback must touch only the M+1..N
  cancelled toolResults, not the completed ones.
