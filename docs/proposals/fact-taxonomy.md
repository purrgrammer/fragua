---
title: fact.* event taxonomy — the shared engine contract (v0)
summary: "The versioned event contract that fragua and Ernesto both implement — the load-bearing half of two-engines-one-contract (ernesto-interop.md §4). Stance: CONVERGE, don't reconcile — where the engines encode the same event differently, pick one encoding and move both to it. Defines the envelope ({runId, seq, type, payload, ts, routing?}), the fact.<subject>_<event> naming grammar, a small CORE event set both engines emit with agreed payload minima (run_started, run_resumed, run_paused_human, node_completed, plus a terminal), and the v0 convergence target for the terminal: ONE fact.run_terminated { status: completed | failed | cancelled } — Ernesto already emits this; fragua converges (collapsing its three terminal facts is a losslesss discriminated-union change, a fragua-side work item). Plus the extension rule (an engine may emit beyond core; promoting into core is a versioned change PR'd to both repos) and the forward-compat rule (consumers ignore unknown types, never throw — this is what lets a convergence land in one repo before the other). NOT a shared npm package — each repo checks in a copy carrying the same taxonomy_version. Open sub-decision: the status string set (neutral completed|failed|cancelled vs Ernesto's errored|aborted vs fragua's halted). This is the fragua-side copy; canonical home TBD. v0 / DRAFT."
status: draft
maturity: sketch
taxonomy_version: 0
last-reviewed: 2026-06-15
---

# fact.* event taxonomy (v0)

> **The shared contract, not shared code.** fragua and Ernesto are two
> separate workflow engines ([`ernesto-interop.md`](ernesto-interop.md));
> what they share is *this* — a versioned event vocabulary both emit and both
> can consume. Ernesto already borrowed fragua's event names ad hoc when it
> was built; this spec turns that accident into a contract. **No runtime
> package** is shared (that would couple release cadences and recreate the
> embedding problem at the type layer): each repo checks in a copy of this
> file carrying the same `taxonomy_version`, and divergence is a review-caught
> bug. This is the fragua-side copy; the canonical home is open
> ([`ernesto-interop.md`](ernesto-interop.md) §9.1).
>
> `taxonomy_version` is the **cross-engine** contract version. It is distinct
> from each engine's internal fold/contract version (fragua's
> `EVENT_CONTRACT_VERSION`, Ernesto's store schema) — those govern an engine's
> own replay; this governs what crosses between them.

## 0. Stance — converge, don't reconcile

Where the two engines encode the *same* event differently, the contract's job
is to pick **one** encoding and move both to it — not to bless two wire forms
and translate between them forever. Reconciliation (a mapping table) is the
*migration bridge*, not the destination. v0 applies this to the terminal fact
(§3.1): one `fact.run_terminated { status }`, which Ernesto already emits and
fragua converges toward. The live follow-on convergence candidates are the
usage carrier (§4) and node-completion payload (§6). The forward-compat rule
(§5.2) is what lets a convergence land in one repo before the other without
breaking either in the interim.

## 1. The envelope

Every event is one append-only record:

```
{ runId: string, seq: number, type: string, payload: object, ts: number, routing?: object }
```

- **`runId`** — the run the event belongs to.
- **`seq`** — monotonically increasing per `runId`, gap-free, assigned by the
  writer. Defines the run's total event order.
- **`type`** — the `fact.*` tag (§2).
- **`payload`** — type-specific (§3). An object, never a bare scalar.
- **`ts`** — epoch milliseconds when the event was produced.
- **`routing`** — optional per-run blob (transport, scopes, parent run id,
  …). Engine- and transport-specific; **no consumer reads keys here to make
  control-flow decisions.** A carrier, not a contract surface.

An engine MAY add envelope fields for its own audit (Ernesto stamps a
`writer: 'engine' | 'handler' | 'subscriber'`; fragua does not). Added
envelope fields are ignored by a consumer that doesn't know them — they never
change the meaning of the six above.

## 2. Naming grammar

`fact.<subject>_<event>` — `subject` is the thing the event is about (`run`,
`node`, …), `event` is what happened, in the **past tense**
(`started`, `completed`, `resumed`, `terminated`). A qualifier may follow
(`run_paused_human`). The `fact.` prefix marks a recorded fact about what
*did* happen — distinct from an `intent.*` (a request for something to happen),
which is an engine-internal namespace and **not** part of this cross-engine
contract.

## 3. The core event set

Both engines emit these, and a consumer that understands only this set can
follow any run from start to terminal. Each row lists the **payload
minimum** — the fields a cross-engine consumer may rely on. An engine emits a
superset; extra fields are §5 extensions, read only by consumers that know
the emitting engine.

| `type` | Payload minimum | Meaning |
|---|---|---|
| `fact.run_started` | `{}` (the run is identified by the envelope's `runId`) | The run began. A workflow identifier rides as an extension — fragua `workflowSha`, Ernesto `workflow` name — because the two identify workflows differently (§6). |
| `fact.run_resumed` | `{}` | A paused run resumed (re-entry after a human/auto/signal pause or a crash). |
| `fact.node_started` | `{ nodeId }` | A step began. *(Optional in core — fragua emits it; an engine may go straight to `node_completed`.)* |
| `fact.node_completed` | `{ nodeId }` | A step finished. Its result and cost ride as extensions: fragua inlines `outcomeStatus` + `tokens`/`costUsd` + typed `outputs`; Ernesto inlines `output` and emits cost as a separate `fact.usage`. A core consumer learns *that* the node finished; *what* it produced is read per-engine (§4 cost, §6 outputs). |
| `fact.run_paused_human` | `{ nodeId, text, routes }` | The run parked for a human decision. `text` is the operator prompt; `routes` the choices. Strongly aligned already — fragua adds `routeLabels` + an embedded snapshot, Ernesto adds `promptId`. |
| `fact.run_terminated` | `{ status }` (§3.1) | The run reached a terminal state, classified by `status`. |

### 3.1 The terminal fact — one `fact.run_terminated { status }`

A run ends with exactly **one** `fact.run_terminated`, carrying a terminal
`status`:

| `status` | Meaning | beyond-minimum detail |
|---|---|---|
| **completed** | reached a sanctioned terminal (incl. an author-sanctioned `fail`-edge-to-`exit`) | `finalNode` |
| **failed** | ended on an unrecovered fault | `reason` / `message` |
| **cancelled** | ended by operator/caller request | `intentSeq` |

One fact, one discriminant. A consumer switches on `status` and reads the run
as ended; everything past `status` is per-status detail (an engine-specific
`finalNode` / `reason` / `intentSeq`), an extension, not the minimum. This is
what lets the `kind: 'fragua'` handler
([`ernesto-interop.md`](ernesto-interop.md) §5) map a fragua run's terminal to
an Ernesto `HandlerResult` with one switch.

**Convergence state.** Ernesto already emits exactly this shape
(`fact.run_terminated { status }`). **fragua does not yet** — it emits three
separate terminal facts (`run_completed { finalNode }` / `run_halted { reason }`
/ `run_cancelled { intentSeq }`), a pre-convergence artifact. Collapsing them
into one `run_terminated { status, … }` (the per-status detail becomes a
union discriminated on `status` — **lossless**, every field above is
preserved) is a fragua-side work item
([`ernesto-interop.md`](ernesto-interop.md) §8): a discriminated payload, an
`EVENT_CONTRACT_VERSION` bump, and the enum-literal sweep across consumers.
fragua's `run_state.status` **projection** keeps its terminal values
regardless — the *fact* collapses; the projection it folds into needn't.
Until the collapse lands, the migration bridge is `completed` ↔
`run_completed`, `failed` ↔ `run_halted`, `cancelled` ↔ `run_cancelled`.

**Open sub-decision — the status vocabulary.** Convergence forces one set of
strings, and the three engines-in-play disagree:

| Option | Strings | Note |
|---|---|---|
| neutral *(proposed)* | `completed \| failed \| cancelled` | clearest English; both engines move |
| Ernesto's wire | `completed \| errored \| aborted` | zero Ernesto churn; `errored`/`aborted` read worse |
| fragua's | `completed \| halted \| cancelled` | `halted` is fragua-idiomatic, opaque cross-engine |

This is the single string-level call the convergence forces — see
[`ernesto-interop.md`](ernesto-interop.md) §9.

## 4. Cost / usage

Cost attribution must reach a cross-engine consumer, but the two engines
*carry* it differently:

- **fragua** inlines it on `fact.node_completed`: `{ tokens, costUsd }` plus an
  input/output/cache split.
- **Ernesto** emits a sibling `fact.usage { inputTokens, outputTokens,
  cacheRead?, cacheWrite?, costUsd?, modelUsage? }` per step.

The **core usage minimum**, wherever it rides, is `{ inputTokens,
outputTokens, costUsd }` attributable to a `nodeId`. A consumer aggregating
cost reads it from `node_completed` (fragua) or `fact.usage` (Ernesto). Which
carrier an engine uses is an engine choice; that a per-node usage signal
exists is the contract. (Unifying the carrier — `fact.usage` on both, or a
generic `cost {unit,value}` — is a §5 candidate, not a v0 requirement.)

## 5. Extension and versioning rules

1. **Emit-beyond-core is allowed.** An engine may emit `fact.*` types outside
   §3 and extra payload fields within core types. These are visible only to
   consumers that know the emitting engine.
2. **Consumers ignore the unknown.** A consumer that meets an unrecognised
   `type`, or an unknown field in a known payload, **skips it** — never throws,
   never halts. (Both engines already require this: Ernesto's subscriber rule,
   fragua's forward-compat fold.) This is what makes a version skew between the
   two repos safe rather than fatal.
3. **Promotion is a versioned change to both.** Moving an extension into the
   core set (§3) — or changing a core payload minimum, or the disposition
   set — bumps `taxonomy_version` and lands as a PR to **both** repos' copies
   in the same change. Per-engine review (Alejandro on Ernesto-lib,
   [`ernesto-interop.md`](ernesto-interop.md) §8) is the divergence guard.
4. **`taxonomy_version` is monotonic and additive-by-default.** A bump that
   only *adds* a core event or an optional minimum field is backward-readable
   by an older consumer (rule 2 covers it). A bump that *removes* or *retypes*
   a core minimum is breaking and must be called out as such.

## 6. Engine-specific extensions (informative)

Not part of the contract — a catalogue, so a reader knows what is core (§3)
versus what belongs to one engine. These are the raw material for §5
promotions and for the convergence candidates in
[`ernesto-interop.md`](ernesto-interop.md) §6.

**fragua-only, on `main`:**
`run_paused` / `paused_auto` (operator + daemon-owed clock pauses);
`dispatch_started`, `node_aborted`, `tool_completed`, `message_appended`;
`snapshot_recorded` (git provenance); `fanout_started` / `fanout_joined`
(parallel regions); `schedule_*`; `run_quarantined` / `run_requeued_after_crash`
/ `daemon_takeover` (the durable-daemon lifecycle); `provider_retry_attempted`,
`handler_timeout_leaked`, `side_effect_*`. Workflow identity is a content
`workflowSha`; `node_completed` carries typed `outputs` (the structured-outputs
MVP).

**Ernesto-only:**
`run_paused_signal` (park on an opaque `signalKey`, a durable worker resumes —
the cleaner external-wait primitive [`ernesto-interop.md`](ernesto-interop.md)
§6.4 flags for fragua); streaming deltas on-log (`assistant_delta`,
`assistant_message`, `tool_call`, `tool_result`, `thinking`); `fact.usage`
(§4); `subagent_started` / `subagent_completed`; `fact.component` (typed UI
intents per-transport renderers consume — a candidate fragua may want).
Workflow identity is a `workflow` name + `inputs`; `node_completed` carries a
single `output` value.

The asymmetry to keep in mind: **fragua's message-level facts are coarser**
(whole `message_appended`; per-token deltas are off-log, SSE-only) while
**Ernesto's are finer** (per-token `assistant_delta` on-log). A bridge from
fragua → Ernesto forwards at message granularity; that is faithful, not lossy
(§3's core never promised token deltas).
