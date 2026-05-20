---
title: Reserved `fail` sink — a failure terminal mirroring `exit`
summary: "DISCARDED. Considered adding `fail` as a second reserved terminal (mirror of `exit`) so routing nodes could author a failure terminal. Existing primitives cover every case: `abort(reason)` for llm failure, bounded loop-back edges for redo, `exit` for graceful, and `intent.cancel(note)` for operator discard-as-failure. The valuable output — the four-mechanism terminal model — is recorded in the swarm-author SKILL. Kept as the design record."
status: discarded
maturity: sketch
last-reviewed: 2026-05-20
---

# Reserved `fail` sink — a failure terminal mirroring `exit`

> **Decision (2026-05-20): discarded.** The four-mechanism model (below) is
> sound and worth keeping, but the `fail` *primitive* is not needed. Every
> outcome a routing node could want is already expressible:
> redo → a loop edge to an upstream node; goal met / sanctioned no-op →
> `exit`; an llm that can't proceed → `abort(reason)`; an operator who wants
> to discard-and-fail → `intent.cancel`, which already carries an optional
> `note`. The lone residual that motivated the sink — a *human* node ending
> the run as failed — is exactly `cancel`. The only thing that would reopen
> this: wanting a human rejection to project `halted` (red) rather than
> `cancelled` in the feed; today `cancelled` is judged sufficient. The
> authoring guidance lives in `.agents/skills/swarm-author/SKILL.md` §1
> (workflow boundaries / four-mechanism terminals).
>
> Before: there is exactly one reserved terminal, `exit`. After the opt-in
> fail-edge change (commit `73344bd4`), reaching `exit` always emits
> `fact.run_completed`. A routing node (`type: human`, or an llm node with
> `routes:`) must point every declared route at *something* — a real node
> or `exit` — so a route meant to terminate the run as a *failure* can only
> be spelled `→ exit`, landing green.
>
> After (if adopted): a second reserved terminal, `fail`, mirrors `exit`. A
> route or edge to `fail` drives the run to `fact.run_halted`. The author
> picks the terminal that matches intent: `exit` for a graceful landing,
> `fail` for a sanctioned failure.

## The four-mechanism terminal model

The load-bearing realisation is that "negative" routes are not one thing.
Every non-forward route sorts into one of four buckets, and the authoring
question for any route is *which bucket*:

| Bucket | Means | Mechanism | Terminal? |
|---|---|---|---|
| **Forward** | proceed | route/edge → next node | no |
| **Loop back** | "redo / send back to the drawing board" | route/edge → an upstream node, bounded by `max-retries` / goal-gate cap | no |
| **Graceful done** | goal met, or sanctioned no-op | → `exit` | `run_completed` |
| **Failed done** | goal unreachable; no path forward | → `fail` *(or llm `abort`)* | `run_halted` |

The single axis that separates the two terminals is **did the run achieve
its declared goal?** — yes → `exit`, no → `fail`. "Decide later" is not a
terminal (it is the `paused_human` state — just don't answer); "operator
kills it" is not a route (it is `intent.cancel`, projecting `cancelled`).

This model is worth codifying in the authoring docs **regardless of whether
`fail` is added** — it is the clean mental model for routing terminals.

## Problem

Failure handling for **outcome-based** nodes is already expressive: a node
that fails with no fail-edge halts (`aborted_exit`); an explicit
`on: {fail: exit}` is a graceful landing; `on: {fail: <upstream>}` is a loop.
The gap is on **routing nodes** (discriminated by `route=`, not `outcome=`),
where every declared route must name a target and the only terminal target
is the graceful `exit`.

Re-bucketing the routes in shipped workflows under the model above:

| Workflow | Node | Route | Correct bucket | Target |
|---|---|---|---|---|
| `work` | `approve` (human) | `no` / "Send back" | **loop back** — revise | → `implement` |
| `work` | `approve` (human) | `defer` | graceful (only if "fine, not now"; else drop → stay paused) | → `exit` |
| `work` | `triage` (llm) | `blocked` | **failed** — can't work the task | → `fail` *(or `abort`)* |
| `doc-sync` | `signoff` (human) | `reject` | loop (re-audit) **or** graceful (like `output_only`) — author's call | → upstream / `exit` |
| `doc-sync` | `signoff` (human) | `output_only` | graceful — report produced, edits skipped | → `exit` |

Only `triage blocked` is an unambiguous failure terminal — and `triage` is
an llm node, so it can already `abort`. So the strictly-needed `fail`-sink
count across today's set is **~0**.

## Does `fail` earn its place?

Re-bucketing dissolves most of the motivation. The residual case for adding
`fail` is *not* a capability gap — it is:

1. **Human-node failure.** A `type: human` node has no `abort`. If a human
   route must end the run *failed* — distinct from looping back, exiting
   gracefully, or operator `cancel` (which projects `cancelled`, reading
   "stopped", not "rejected as broken") — `fail` is the only way to author
   it. How often this is real (vs. "send back" or "cancel") is the crux.
2. **Legibility + symmetry.** `blocked → fail` is a *visible edge to a sink*
   in the graph; an `abort` buried in a prompt is not. `fail` completes the
   `exit`/`fail` terminal pair so the topology shows both outcomes.

The fork:

- **(A) Add `fail`.** Declarative, graph-visible failure terminal usable by
  any node type incl. human; mirrors `exit`. One new concept.
- **(B) Don't.** Codify the four-mechanism model; route `send_back →
  implement`, `blocked → abort`, `exit` for graceful, `cancel` for kill.
  Zero new primitive — leans on the minimal-primitives bias.

Lean: **(A), narrowly** — the human-node-failure gap is genuine and `cancel`
reads wrong for a reviewer rejection. But it is close; if (B) wins, the
model section above still lands as authoring guidance.

## Design (if (A))

Add `fail` as a reserved terminal node id, synthesised on demand exactly
like `exit`:

- **Authoring.** Authors never declare it; they target it. Primary case is
  `routes: {blocked: fail}` on routing nodes. `on: {fail: fail}` / `next:
  fail` are accepted but degenerate (an outcome node with no fail-edge
  already halts).
- **Semantics.** Reaching `fail` → `fact.run_halted`; reaching `exit` →
  `fact.run_completed`. Both terminal; the reducer already maps `halted →`
  the UI's `"fail"` status.
- **Reserved id.** `fail`, like `exit`, cannot be a regular step id.

### Node model

`NodeType` gains `fail` alongside `start | exit | llm | human | tool`. The
synthetic sink carries `type: fail`. `result-to-facts`'s terminal-fact
branch splits on the node:

- terminal is `fail` → `fact.run_halted{reason}`
- terminal is `exit` (or success-reached `__end__`) → `fact.run_completed`
- terminal is `__end__` + `outcome=fail` → `fact.run_halted{aborted_exit}`
  (unchanged — the bare-fail path)

### Where the reason comes from

A `→ fail` route should carry a human-readable reason into
`fact.run_halted.detail`, sourced from wherever the choice was made — the
same channel `abort` already uses (`failureReason` → detail):

- **llm route.** Augment the synthesised `route` tool with an optional
  `reason: string`: `route({ name: "blocked", reason: "task already
  shipped" })`. On a `→ fail` route the `reason` becomes the detail; on any
  route it doubles as choice provenance (today invisible — *why* the LLM
  branched). This makes `route(...)→fail` functionally equal to
  `abort(reason)` for llm nodes; the difference is graph legibility, so a
  node should use one idiom, not both.
- **human route.** `intent.human_input` *already* carries `note?`
  (`{ route, note? }`) — but `handlers/human.ts` reads only `route` and
  drops the note. Propagate it: the handler sets `failureReason` from the
  note, and `result-to-facts` uses it as detail when the chosen route lands
  on `fail`. The web HITL panel can prompt for the note when the focused
  route targets `fail` (a rejection-reason box).

Both paths set `failureReason` on the handler result (ignored unless the
terminal is `fail`/`__end__`), falling back to a generic `"<route> via
<node>"` string when absent — exactly like `abort`.

### Halt reason

- **Reuse `aborted_exit` (recommended for v1).** No new `HaltReason`
  literal; the rich detail (note / route reason) carries the meaning, and
  `aborted_exit` already classifies "deliberately failed with a reason".
  Zero contract churn. swarm-debug §8 gets one added line.
- **New `rejected` literal.** Reads truer in the runs feed for *human*
  rejections and lets operators filter them, but costs the full enum sweep
  (`types/events.ts`, ARCHITECTURE §3, schema `CHECK`, swarm-debug §8,
  STATUS.md, drift-lint coverage in `handler/types.ts`). Add only if the
  human-rejection-reads-wrong concern bites — cheaper in the same change if
  already known-wanted.

### Goal-gate interaction

`isTerminalNext` (executor) must treat `fail` as a terminal. A `fail`
arrival halts unconditionally — it does **not** run the goal-gate retarget
(the author is asserting termination, like `<abort>`). Verify a sibling
route landing on `fail` wins over a mid-flight gate retarget.

## Impact (files, if (A))

- `packages/core/src/types/graph.ts` — `NodeType` gains `fail`.
- `packages/core/src/parser/yaml.ts` — recognise `fail` as a reserved sink;
  synthesise the node when targeted (mirror of the `exit`/`needExit` block);
  reserve the id.
- `packages/core/src/engine/validator.ts` — new **E031**: node id `fail`
  reserved (mirror of E028). `fail` is optional (E003 unaffected).
- `packages/agent/src/backend.ts` (route-tool synthesis) — optional
  `reason` param on the `route` tool; thread it to the outcome.
- `packages/core/src/handler/handlers/human.ts` — propagate
  `ctx.humanInput.note` to `failureReason`.
- `packages/daemon/src/result-to-facts.ts` — `isTerminalNode` includes
  `fail`; emit `run_halted` for the `fail` sink with the carried detail.
- `packages/daemon/src/executor.ts` — `isTerminalNext` includes `fail`;
  `fail` halts ahead of the goal-gate check.
- `packages/web/src/components/GraphView.tsx` — render the `fail` sink (red
  terminal, mirror of the `exit` chip); HITL panel reason box on fail routes.
- Docs: SPEC §3.6, handler-contract, swarm-author SKILL +
  `references/validator-codes.md` (E031); ARCHITECTURE §3 only if `rejected`.

## Workflow migrations (after the primitive lands)

These mostly are *not* `fail` — that is the point of the model:

- `work` `approve`: `no` ("Send back") → **`implement`** (revision loop, not
  fail); `defer` → `exit` only if "fine, not now", else drop the route.
- `work` `triage`: `blocked` → `fail` (or `abort` under (B)). Lets `triage`
  own the blocked terminal and deletes the duplicate `blocked` guard in
  `plan`.
- `doc-sync` `signoff`: `reject` → re-audit loop or `exit` (graceful),
  author's call; likely *not* `fail`.

## Alternatives considered

- **`outcome=fail` on a route edge.** Rejected: routes and outcomes are
  deliberately orthogonal (a route may be named `success`/`fail`), and
  routing nodes discriminate on `route=` only.
- **Route to a node whose handler aborts.** Works today (this is option (B)
  for llm nodes) but adds a no-op step for human nodes and buries intent.
- **Per-route `terminal: fail` flag.** More surface than a reserved sink and
  doesn't compose with `on:`/`next:`.

A reserved `fail` sink mirrors the existing `exit` reservation, adding one
concept readers already understand rather than a new edge attribute — but
only if the human-failure / legibility case is judged worth it over the
four-mechanism model on existing primitives.
