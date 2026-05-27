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
> host on fragua ci (shipped) and cli-store-client (shipped).

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
> answer intent is constructed via the intent plane (shipped).

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

- **Depends on:** the intent plane (shipped) — construct `intent.human_input`.
  Concrete channels host on `fragua ci` (auto-approve) and `cli-store-client`
  (console TTY). The web channel exists.
- **Wins independently:** the resolver *seam* + the queue resolver land alone and
  immediately unblock deterministic HITL testing.
- **MVP:** the resolver seam + the auto-approve channel — i.e. give `fragua ci`
  a responder for the *unanswerable* pauses (`paused` / `paused_human` /
  `quarantined`) it currently stops on, via `--on-pause`. (`paused_auto` already
  continues — the drive loop rides the daemon-owed retry tick.) Console + queue
  are fast-follows. The complementary case — externalizing a human gate to *some*
  responder rather than auto-deciding it — is the `emit` seam in §5; `auto`/`emit`
  share the one `--on-pause` switch.

## 4. Open notes

- ~~The Question presented to a channel is reconstructed from the pause fact +
  the node's outgoing edges / route options; settle exactly what the pause fact
  carries vs. what the channel re-derives from the workflow.~~ **Settled in §5:**
  the route options ride on the pause fact, so no channel re-derives them from
  the workflow YAML.
- Timeout/default handling (attractor §6.5) maps onto the existing `paused_auto`
  / `auto_resume_at` machinery — decide whether a human-gate timeout reuses it or
  stays channel-local.

## 5. The `emit` seam — the actual MVP

> Status: proposed. This is the transport-agnostic core. Once it lands, *any* CI
> transport (GitHub Environments, the Interactive Inputs action, a Slack
> receiver, a `curl` one-liner) drives a human gate in user-authored YAML with no
> further fragua code. The concrete transports in §6 are documentation, not
> engine work.

Two small additions turn `fragua ci`'s dead stop at `paused_human` into a
resumable hand-off:

### 5.1 `fragua ci --on-pause=emit`

A fourth `--on-pause` mode alongside `auto|fail|first`. The first three *decide*
(pick default / error / pick first edge); `emit` *externalizes*: on
`paused_human` it writes a machine-readable question descriptor and exits `0`, so
the surrounding orchestrator owns the human turn.

```
$ fragua ci ship.yaml --db "$RUNNER_TEMP/ci.db" --on-pause=emit
# stdout (JSON, one object) when the drive loop parks at a human gate:
{
  "paused": true,
  "run_id": "run_01h…",
  "node": "approve-deploy",
  "question": "Approve production deploy?",
  "routes": [
    { "route": "approve", "label": "Ship it" },
    { "route": "hold",    "label": "Hold for review" },
    { "route": "reject",  "label": "Abort" }
  ]
}
# exits 0; if the run reaches a terminal state instead, emits {"paused": false, …} and exits 0.
```

In GHA these fields are mirrored to step outputs (`steps.drive.outputs.paused`,
`…run_id`, `…routes`) so later `if:`-guarded steps can branch on them.

### 5.2 Route options ride on the pause fact

`fact.run_paused{reason:human}` gains a `routes: { route, label }[]` field,
folded by the recorder at park time from the parked node's outgoing edges. This
resolves the §4 open note: the channel reads the renderable Question straight off
the fact (and off `fragua runs status --json`) instead of re-parsing the workflow
YAML. Route labels are small and well inside the 4 KB payload cap (I-…); if a
node ever carries enough routes to threaten the cap, the fact stores route *keys*
only and the renderer falls back to keys-as-labels.

### 5.3 Resume

The write side already exists — `fragua runs respond <run> --route … --note …`
constructs `intent.human_input` via the intent plane. Resuming the drive loop
re-opens the same store and continues:

```
$ fragua runs respond "$RUN" --db "$DB" --route approve --note "lgtm"
$ fragua ci --resume "$RUN" --db "$DB" --on-pause=emit   # drives on; emits again at the next gate
```

`--resume` reuses `buildExecutorDeps` over the existing store; it is `ci` minus
the save+enqueue of a fresh workflow. A run with several gates is just `emit →
respond → resume` repeated — but note the cardinality limit in §6.3 for what that
costs inside GHA specifically.

## 6. CI wiring recipes (documentation, not engine work)

All three sit on the §5 seam. Pick by gate shape:

| Gate shape | Transport | fragua-side glue |
|---|---|---|
| Approve / reject (binary route) | **GitHub Environments + required reviewers** | none — native GHA |
| Rich input (note / multiselect / file) | **Interactive Inputs** action (ngrok web form) | none beyond §5 |
| Answer-from-Slack (in-channel buttons) | Block Kit + a webhook → `runs respond` | a receiver service (out of scope) |

### 6.1 Environments — the default for approvals

For a binary gate, GitHub's native deployment-protection pause is strictly
better than any web form: no ngrok, no secret, no custom UI. The job blocks on
`environment:` until a named reviewer clicks Approve/Reject in the GitHub UI; a
follow-up step maps that to a route and calls `runs respond`.

```yaml
- id: drive
  run: fragua ci ship.yaml --db "$RUNNER_TEMP/ci.db" --on-pause=emit
- id: gate
  if: steps.drive.outputs.paused == 'true'
  environment: production            # ← required-reviewers protection rule pauses here
  run: |
    fragua runs respond "${{ steps.drive.outputs.run_id }}" \
      --db "$RUNNER_TEMP/ci.db" --route approve
    fragua ci --resume "${{ steps.drive.outputs.run_id }}" \
      --db "$RUNNER_TEMP/ci.db" --on-pause=emit
```

### 6.2 Interactive Inputs — the rich-input escape hatch

When the gate genuinely needs free text / multiselect / a file upload, the
[Interactive Inputs action](https://github.com/marketplace/actions/interactive-inputs)
renders a web form (via an ngrok tunnel) and returns the answer as step outputs.
The `interactive:` form spec is built from `steps.drive.outputs.routes` (§5.2).
Caveats to weigh: it **blocks the runner** for the whole human-think window
(billing minutes, capped by the 6 h job limit), needs an **ngrok authtoken
secret** and exposes a public form, and its Slack/Discord support is
**notify-only** — the human still answers in the portal, not in Slack.

### 6.3 Cardinality limit

GHA `uses:` steps can't be looped or dynamically dispatched, and fragua's
sequential gates can't be batched into one form (a later gate's routes aren't
known until the earlier one is answered). So a GHA-hosted human turn is
**single-gate per run** in practice. For a small known number of gates,
statically unroll `emit → respond → resume` triplets, each `if:`-guarded on the
prior step's `paused` output. For **many or unbounded** gates, do not host the
loop in GHA — drive the run from a long-lived daemon and answer on the **web
channel** (shipped) or a Slack receiver, where the resolve loop isn't bounded by
GHA's step model.
