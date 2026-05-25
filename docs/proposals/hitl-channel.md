---
title: Pluggable HITL channel — the interviewer pattern over pause-fact/answer-intent
summary: "Make the human-in-the-loop channel pluggable, porting attractor's Interviewer pattern mutatis mutandis. fragua's HITL is already event-sourced (fact.run_paused{reason:human} parks the run; intent.human_input answers it), so the port is an async resolver — observe the pause fact, write the answer intent — not a blocking ask(). Built-ins: auto-approve (CI), console (TTY), web (exists), queue (tests); recording is subsumed by the event log."
status: proposed
maturity: sketch
last-reviewed: 2026-05-21
parent: cli-topology.md
---

# Pluggable HITL channel

> Child of [`cli-topology.md`](cli-topology.md). An additive tail; blocks
> nothing. The resolver seam + queue resolver can land alone; concrete channels
> host on [`fragua-ci.md`](fragua-ci.md) and [`cli-store-client.md`](cli-store-client.md).

## 1. What already exists

fragua's HITL is **already** event-sourced and decoupled (`events.ts:157–265`):
`fact.run_paused` with `reason: "human"` / status `paused_human` parks the run;
`intent.human_input { route, note? }` answers it; `intent.resume` resumes. The
web UI already drives this over HTTP. The gap is that the channel is implicit —
there is no abstraction for *who answers a pending human gate*, so CI and
scripted/test contexts have no first-class path.

## 2. The port: attractor's interviewer, mutatis mutandis

attractor's `Interviewer.ask(Question) → Answer` (`~/attractor/attractor-spec.md`
§6) is a **blocking, in-handler** call. fragua cannot block the executor on a
human — the executor parks the run via a fact and moves on. So the abstraction
is ported as an **async resolver**, not a synchronous `ask`:

> A HITL channel observes `fact.run_paused{reason:human}` on the store and writes
> back an `intent.human_input`. It is a store-client like everything else; the
> answer intent is constructed via the [intent plane](intent-plane.md).

The Question/Answer/Option models port near-verbatim; the transport changes from
a function return to a store intent.

| attractor interviewer | fragua channel | role |
|---|---|---|
| `AutoApproveInterviewer` | **`fragua ci` default** | resolve `paused_human` with the default/first route, or fail. Surfaced as `--on-pause=auto\|fail\|first`. |
| `ConsoleInterviewer` | **`fragua watch` in a TTY** | prompt the human, write `intent.human_input`. |
| `CallbackInterviewer` | **web UI** | the existing pause→respond flow. Already shipped. |
| `QueueInterviewer` | **PBT / replay tests** | pre-filled answers; fits the `fast-check` suites. |
| `RecordingInterviewer` | **subsumed** | every `intent.human_input` is already durably in the event log. Audit/replay for free; no implementation. |

## 3. Scope / dependencies / MVP

- **Depends on:** [`intent-plane.md`](intent-plane.md) (construct
  `intent.human_input`). Concrete channels host on `fragua-ci` (auto-approve) and
  `cli-store-client` (console TTY). The web channel exists.
- **Wins independently:** the resolver *seam* + the queue resolver land alone and
  immediately unblock deterministic HITL testing.
- **MVP:** the resolver seam + the auto-approve channel — i.e. give `fragua ci`
  a responder for the *unanswerable* pauses (`paused` / `paused_human` /
  `quarantined`) it currently stops on, via `--on-pause`. (`paused_auto` already
  continues — the drive loop rides the daemon-owed retry tick.) Console + queue
  are fast-follows.

## 4. Open notes

- The Question presented to a channel is reconstructed from the pause fact +
  the node's outgoing edges / route options; settle exactly what the pause fact
  carries vs. what the channel re-derives from the workflow before building the
  console renderer.
- Timeout/default handling (attractor §6.5) maps onto the existing `paused_auto`
  / `auto_resume_at` machinery — decide whether a human-gate timeout reuses it or
  stays channel-local.
