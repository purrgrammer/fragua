---
title: LLM-emit HITL via `<ask>` marker
status: proposed
maturity: sketch
last-reviewed: 2026-05-02
---

# LLM-emit HITL via `<ask>` marker

> Today, HITL pauses are workflow-graph features: a `wait.human` node
> declared by the workflow author, with edges-as-choices parsed by
> `accelerator.ts` and resumed via `intent.hitl_input { selected, note }`.
> An LLM mid-step has no way to say "I need a human answer to continue."
> If a planner needs clarification, the only options are abort the run
> or guess. Attractor's interviewer pattern (§4.6, §6) covers the
> static-gate case the way swarm already does — but the dynamic, LLM-
> initiated clarification case is missing in both specs.

## Motivation

A codergen step occasionally needs information that wasn't in
`$ARGUMENTS` and that no upstream node provides. Three real shapes:

- **Disambiguation.** "Did you mean `packages/store` or `packages/server`?"
- **Missing input.** "What's the failing test signature?"
- **Confirmation under risk.** "About to delete 47 stale branches — proceed?"

Today the workflow author has to either (a) pre-author a `wait.human`
node for every conceivable clarification (impossible — the LLM doesn't
know what it doesn't know up front), or (b) tell the LLM to emit a
prose question and rely on a human noticing the pause via steering.
Option (b) doesn't pause the run; the LLM keeps generating against
its best guess until the steer arrives, by which point it's already
gone the wrong way.

What's missing is a marker the LLM can emit at end-of-turn that says
"pause this run with my question; on resume my next message is the
user's answer." Same trailing-line discipline as `<abort>`, same
parser surface, same `paused_hitl` engine status — but the question
and the answer flow through the LLM's own transcript instead of an
edge-choice mapping.

## Shape

A new emit marker, parsed alongside `<abort>`:

```
<ask>question</ask>
```

Strict rule (mirrors the abort contract): the marker must be the
entire last non-empty line of the assistant's final message — no
prose before it on the line, nothing after it on the message.

Behaviour:

1. Codergen handler parses the marker and returns
   `kind: "yield_hitl"` with `label = question`, `options = []`.
2. Engine commits `fact.run_paused_hitl { label: question }` and
   transitions the run to `paused_hitl`. (Existing machinery.)
3. Operator answers via `POST /runs/:id/hitl` with free-text input;
   web posts `intent.hitl_input { selected: "", note: <answer> }`.
   (Existing machinery.)
4. **New**: when a resumed `paused_hitl` node was emit-driven (the
   `yield_hitl` had `options=[]`), the executor appends the answer
   as a **user message** in the codergen call's transcript instead
   of routing via outgoing edges. The same node re-enters with the
   rehydrated thread, the LLM sees the answer, and continues the
   work.
5. Static `wait.human` nodes are unchanged — `options.length > 0`
   keeps today's edge-choice semantics.

## Why this fits the existing architecture

Most of the engine surface is already in place:

| Piece | Status |
|---|---|
| `kind: "yield_hitl"` handler return | exists (`packages/core/src/handler/types.ts:241`) |
| `paused_hitl` run status | exists |
| `fact.run_paused_hitl { label }` | exists |
| `intent.hitl_input { selected, note }` | exists |
| Resume path on `intent.hitl_input` | exists for static `wait.human` |
| Free-text web/CLI answer surface | exists (steer plumbing) |

The new surface is small:

- One marker (`<ask>`) and its parser branch.
- One resume convention: when `options=[]` on the paused node,
  append `note` as a `role:"user"` message in the next codergen
  turn's thread rather than writing into `routingDelta`.
- One system-prompt protocol-block addition (joined with the
  `<abort>` contract that lives in the same block).
- One web-UI affordance: render a freeform text input alongside the
  multi-choice picker for emit-driven HITL pauses.

## Why this does not conflict with `SPEC.md` §6.5

§6.5 says swarm "replaces the question/answer Interviewer interface
with `wait.human` nodes plus the `intent.hitl_input { selected, note }`
event." That holds for the **static gate** path — the typed Question
model with accelerator-key edge mapping isn't coming back. The
`<ask>` path is **additive** and doesn't reintroduce attractor's
typed `Question` interface or pluggable `Interviewer` backends — it
just lets an LLM step trigger the same pause-and-resume flow that
`wait.human` triggers today, with the answer flowing through the
transcript instead of through routing.

## Open questions

1. **Freeform-only MVP, or typed questions from day one?**
   - MVP: `<ask>question</ask>` is freeform. Answer is text.
   - Richer: `<ask type="yesno">…</ask>`, `<ask type="choice">[a] foo / [b] bar</ask>` to constrain answers.
   - The richer form starts looking like attractor's `QuestionType`,
     which §6.5 explicitly chose not to ship. Lean freeform-first;
     re-evaluate if real workflows pinch.

2. **Bound or unbound asks per node?**
   - With resume-as-user-message, a single codergen node can ask
     repeatedly in a chain: ask → answer → ask → answer → done.
     Falls out for free.
   - Risk: misbehaving prompt traps a run in a question loop. The
     existing `max_loops` ceiling and operator pause/cancel cover
     this, but worth pinning before implementation.

3. **Does `<ask>` count toward the run's budget / goal-gate retry
   counter?**
   - Treat as a pause: no budget consumed, no retry counter
     incremented. Matches operator intuition — the run isn't
     failing, it's waiting.
   - Cost still accrues for the codergen turn that emitted the
     question; that's correct (the LLM did work).

4. **What does the answer look like to the LLM?**
   - Naïve: `role:"user", content: <answer text>`. The LLM sees a
     normal user reply.
   - Considered: wrap the answer in `<answer>…</answer>` so the LLM
     can distinguish operator answers from `$ARGUMENTS` / steers.
     Probably unnecessary — the LLM already handles a mid-thread
     user message naturally.

5. **What if the operator cancels instead of answering?**
   - `intent.cancel` already terminates `paused_hitl` runs cleanly.
     No new path; the question simply isn't answered and the run
     ends.

6. **Web UI: which input surface?**
   - Existing wait.human renderer shows an accelerator-key picker.
     Emit-driven pauses (options=[]) need a freeform text box. Both
     surfaces coexist on the run page: picker when options exist,
     text box when they don't.
   - The HITL `label` is rendered as the question prompt — already
     true today; no copy change needed.

7. **Parser unification.**
   - Today: `parseAbortMarker(text) → {reason} | null`.
   - Proposed: `parseTerminalMarker(text) → {kind:"abort",reason} | {kind:"ask",question} | null`.
   - Requires renaming the export. Caller (`backend.run`) routes on
     the `kind`. Tests fork into two describe blocks but share the
     strict-line rule.

8. **Multi-turn ergonomics: does the LLM need a hint that it's
   resumed from a HITL pause?**
   - The answer-as-user-message is sufficient context.
   - But: the LLM doesn't know whether the answer is from a human
     or an upstream node's structured output. Probably fine — the
     transcript carries enough — but worth confirming with a real
     workflow before declaring done.

9. **Marker collision risk.**
   - `<ask>` is short and could appear as documentation in agent
     output (e.g. an LLM writing a tutorial about this very
     feature). The strict last-non-empty-line rule is the same
     defence used for `<abort>`; the documented self-reference
     mode (model writing about the contract) is the canonical
     stress test.

## What this does not commit to

- **Reintroducing attractor's typed `Question` / `Answer` /
  `Interviewer` interfaces.** §6.5 stands; this proposal adds an
  emit pathway, not a reified question model.
- **Mid-turn pause.** `<ask>` is end-of-turn, parsed after the
  codergen call returns. There is no plan to interrupt a streaming
  LLM call mid-message and return a tool result back into the same
  call.
- **Multi-choice edges from emit-driven asks.** Routing on the
  `<ask>` path goes back to the same node, not to a chosen edge.
  Static `wait.human` keeps the edge-choice path.
- **Tool-call routing.** The `<ask>` marker stays text-emit so the
  contract is provider-portable. No dependency on tool-using
  providers.

## Implementation sketch (when scheduled)

1. Generalise `parseAbortMarker` → `parseTerminalMarker` (strict
   last-non-empty-line, returns abort | ask | null). Tests already
   cover the discipline; add ask-side cases.
2. Codergen handler routes `ask` → `yield_hitl(label=question, options=[])`.
3. Resume path: in `handler-bridge.ts`, on entry to a node where
   the prior pause was emit-driven (`options=[]` recorded with the
   pause), inject the answer as a user message in the thread before
   the codergen call.
4. System-prompt `<protocol>` block gains the `<ask>` clause
   alongside `<abort>`. Same constant text for every codergen call;
   cache-key-clean.
5. Web: add freeform input next to the existing wait.human picker
   on `paused_hitl` runs.
6. Update `docs/SPEC.md` §6.4 to list `<ask>` as an extension and
   §6.5 to clarify what's still deliberately omitted. Update
   `docs/handler-contract.md` to document the `<ask>` self-emission
   path.
7. Add an example workflow that demonstrates clarification mid-step.
