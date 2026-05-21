---
title: Resume continuity for fresh-thread nodes
status: proposed
maturity: designed
last-reviewed: 2026-05-21
---

# Resume continuity for fresh-thread nodes

> Resuming a paused node should pick up where it left off — even when the
> node is on a fresh thread. Today it restarts from its prompt, re-burning
> budget without converging. The fix: decouple **resume continuity**
> (within-node, across a pause/resume of the same `(nodeId, iteration)`)
> from **thread membership** (cross-node conversation sharing).

---

## The bug

`shouldHydrateFromStore` and `shouldPersistToStore` are both gated purely
on thread membership:

```ts
// packages/agent/src/thread.ts
export function shouldHydrateFromStore(hasThread: boolean): boolean { return hasThread; }
export function shouldPersistToStore(hasThread: boolean): boolean { return hasThread; }

// packages/agent/src/backend.ts:505
hydrateMessages = effectiveHydrate && threadId ? storedForThread : [];
```

So a **fresh-thread node** (no `thread:` attr — e.g. `work.yaml`'s `fix`,
documented "Fresh thread — read state via git") does two things on every
dispatch:

- **doesn't persist** the messages it produces, and
- **doesn't rehydrate** any prior messages — it starts with only its prompt.

That's correct for *cross-node* isolation. But it also means that when the
node is **budget-paused mid-work and resumed**, it restarts from scratch —
its own in-flight reasoning and tool results are gone. Combined with a
cumulative per-node budget (`max-cost`), each resume re-burns the cap on the
same doomed attempt and the run never converges. Observed in practice: a
`fix` node with `max-cost: 0.30` chasing a flaky test paused 7×, escalated
$0.3 → $0.8 → $1.0, each resume re-running the same opening moves.

**Thread membership and resume continuity are different concerns.** "Fresh
thread" should mean *"don't inherit other nodes' conversation,"* not *"throw
away my own progress when paused."*

---

## Design

Add a **node-local resume buffer**: persist a node's own completed turns —
even when it isn't on a shared thread — under a per-node session key, and
rehydrate them when the **same `(runId, nodeId, iteration)`** re-dispatches
after a pause/abort.

- **Key.** `resolveSessionId` already namespaces persistence by `threadId`.
  For a non-threaded node, derive a node-local session id
  (`__node:<nodeId>:<iteration>`) so its transcript is isolated — it never
  feeds the shared cross-node thread and never leaks to sibling nodes.
- **Persist.** `shouldPersistToStore` becomes "threaded **or** node-local
  resume buffer" — a fresh-thread node writes its turns to its node-local
  session as they complete.
- **Hydrate.** On re-dispatch, hydrate from the node-local session **only
  when it's a resume of the same `(nodeId, iteration)`** — i.e. the node
  was paused/aborted and is being re-entered at the same iteration, not
  advanced by a loop back-edge or goal-gate retarget (those bump
  `iteration` and *should* start fresh).
- **Iteration is the discriminator.** A budget/provider/operator pause
  re-dispatches the **same** iteration → hydrate (continue). A loop or
  retarget produces a **new** iteration → empty seed (fresh, as designed).
  So keying the buffer on `(nodeId, iteration)` distinguishes "resume" from
  "loop" with no extra signal.

### Scope

Applies to re-dispatches that re-enter the same `(nodeId, iteration)`:
operator-resumable pauses (`budget`, `provider_error`, `payment_required`,
operator pause) and auto-resume (`handler_retry`, `provider_retry`). It does
**not** change loop / goal-gate / retry-with-new-iteration semantics, and it
does **not** alter cross-node thread sharing.

### Caveat — the in-flight turn is still lost

A budget/abort interrupts the node mid-turn; pi-agent-core ends the in-flight
turn with `stopReason: "aborted"`. Only **completed** turns persist, so
resume continues from the **last complete turn**, not mid-tool-call (an
interrupted `bash` is not resumed — the node re-issues from the last complete
state). That's a large improvement over a full restart and an acceptable
boundary: the unit of resume is a turn.

---

## Alternatives considered

- **Make `fix` a threaded node.** It would then persist/hydrate — but on the
  *build* thread, so it would inherit the whole plan/implement/review
  conversation it was deliberately isolated from. Wrong fix: it conflates the
  two concerns in the other direction.
- **Persist everything unconditionally.** Hydrating a fresh-thread node's
  buffer across *loop iterations* would defeat the "fresh per iteration"
  intent. Keying on `(nodeId, iteration)` avoids this.

---

## Complementary mitigation (orthogonal)

Resume continuity stops a resume from *wasting* work, but a node chasing a
genuinely **unfixable** failure (a flaky test) will still loop until budget.
`fix`-class nodes should **give up after N non-converging cycles** (mirroring
`implement`'s "cap fixes at 5 cycles, then abort") rather than loop. That's a
workflow-level guard, separate from this engine change, but the two together
close the "stuck `fix` burning budget" hole.

---

## Implementation sketch

1. `thread.ts` — add `nodeLocalSessionId(nodeId, iteration)`; widen
   `shouldPersistToStore` / `shouldHydrateFromStore` to accept a
   "resume-eligible" flag, or split into `persistTarget(...)` /
   `hydrateSource(...)` returning the session id (shared thread, node-local,
   or none).
2. `backend.ts` — when not on a shared thread, persist completed turns to the
   node-local session; on dispatch, hydrate from it iff the dispatch is a
   re-entry of the same `(nodeId, iteration)` (the executor already knows
   this — it re-dispatches the same node after a pause without bumping
   iteration).
3. Executor — pass a `resumeOf` / `sameIterationReentry` signal so the backend
   can distinguish resume from a fresh loop iteration. (`fact.run_resumed`
   already marks the transition; the dispatch carries the iteration.)
4. Tests — a fresh-thread node that pauses mid-turn and resumes hydrates its
   prior completed turns; a loop back-edge (new iteration) does not.

> Status: designed, not yet built. Spec-first per `AGENTS.md` ground rule 1
> before touching the agent/backend resume path.
