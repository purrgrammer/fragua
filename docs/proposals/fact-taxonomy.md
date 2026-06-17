---
title: fact.* event taxonomy — the shared engine contract (v0)
summary: "The versioned event contract that fragua and Ernesto both implement — the load-bearing half of two-engines-one-contract (ernesto-interop.md §4). Stance: CONVERGE, don't reconcile — where the engines encode the same event differently, pick one encoding and move both to it. Defines the envelope ({runId, seq, type, payload, ts, routing?}), the fact.<subject>_<event> naming grammar, a small CORE event set both engines emit with agreed payload minima (run_started, run_resumed, run_paused_human, node_completed, plus a terminal), and the v0 convergence target for the terminal: ONE fact.run_terminated { status: completed | errored | aborted } (status vocabulary RESOLVED to Ernesto's wire) — Ernesto already emits this; fragua converges (collapsing its three terminal facts is a losslesss discriminated-union change, a fragua-side work item). Convergence runs in three tiers: tier-1 pure-encoding (converge now — terminal fact, PAUSE fact, and usage carrier; the pause fact converges to one fact.run_paused { reason: human | signal | auto | operator } the way the terminal converges to one run_terminated { status } — fragua folds its separate run_paused_human into reason:human, Ernesto folds run_paused_human + run_paused_signal in; usage converges on a sibling fact.usage); tier-2 converge-on-capability (gated on the laggard building it — fragua gaining external-wait, i.e. emitting the already-defined reason:signal once it builds the primitive; needs its own design); tier-3 stays-divergent-by-design (streaming granularity, workflow-identity form). Plus the extension rule (promoting into core is a versioned change PR'd to both repos) and the forward-compat rule (consumers ignore unknown types, never throw — what lets a convergence land in one repo before the other and a tier-3 difference coexist). NOT a shared npm package — each repo checks in a copy carrying the same taxonomy_version; fragua is the canonical home (this file), Ernesto mirrors. Vocabulary RESOLVED: terminal status = Ernesto's completed|errored|aborted; pause reason = human|signal|auto|operator (human/signal Ernesto's, auto/operator fragua-only). v0 / DRAFT."
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
> bug. **fragua is the canonical home** (this file); Ernesto checks in a
> mirror — the engines don't share a review loop, and fragua is where the
> shared maintainer reviews, so the contract lives here and Ernesto pulls it.
> While it is `v0`/draft it sits in `proposals/`; it graduates to a top-level
> `docs/` contract doc when it freezes.
>
> `taxonomy_version` is the **cross-engine** contract version. It is distinct
> from each engine's internal fold/contract version (fragua's
> `EVENT_CONTRACT_VERSION`, Ernesto's store schema) — those govern an engine's
> own replay; this governs what crosses between them.

## 0. Stance — converge, don't reconcile

Where the two engines encode the *same* event differently, the contract's job
is to pick **one** encoding and move both to it — not to bless two wire forms
and translate forever. Reconciliation (a mapping table) is the *migration
bridge*, not the destination. But not every difference is an accident to
erase. Each one falls into one of three tiers (cataloged in §6):

1. **Converge now — pure encoding.** Same event, same information, different
   shape. The contract picks one form; both move. Closed in v0: the terminal
   fact (§3.1), the pause fact (§3.2), and the usage carrier (§4).
2. **Converge on capability.** One engine has a primitive the other lacks;
   convergence is wanted but waits on the laggard *building* the capability
   (its own design), after which the taxonomy adopts the shared shape.
   Live: the `signal` pause-reason value, once fragua builds external-wait
   (§6.2) — the pause *event* shape itself already converged in tier 1.
3. **Architectural choice — stays divergent by design.** A deliberate
   difference (e.g. fragua keeping token deltas off-log), carried by the
   forward-compat rule (§5.2), not erased.

The forward-compat rule is what lets a tier-1 convergence land in one repo
before the other, and a tier-3 difference coexist permanently, without either
breaking the consumer.

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
| `fact.node_completed` | `{ nodeId }` | A step finished. Its **result** rides as an engine-specific extension — fragua a typed `outputs` record (plural for `inputs:` symmetry, §6.3), Ernesto an `output` value; **cost does not ride here**, it rides `fact.usage` (§4). A core consumer learns *that* the node finished. |
| `fact.usage` | `{ nodeId, inputTokens, outputTokens, costUsd }` | Cost/usage for a node that incurred it (LLM steps; a pure tool step may emit none). The converged carrier — §4. |
| `fact.run_paused` | `{ reason }` (§3.2) | The run parked, classified by `reason` (who/what resumes). Per-reason payload follows. |
| `fact.run_terminated` | `{ status }` (§3.1) | The run reached a terminal state, classified by `status`. |

### 3.1 The terminal fact — one `fact.run_terminated { status }`

A run ends with exactly **one** `fact.run_terminated`, carrying a terminal
`status`:

| `status` | Meaning | beyond-minimum detail |
|---|---|---|
| **completed** | reached a sanctioned terminal (incl. an author-sanctioned `fail`-edge-to-`exit`) | `finalNode` |
| **errored** | ended on an unrecovered fault | `reason` / `message` |
| **aborted** | ended by operator/caller request | `intentSeq` |

One fact, one discriminant. A consumer switches on `status` and reads the run
as ended; everything past `status` is per-status detail (an engine-specific
`finalNode` / `reason` / `intentSeq`), an extension, not the minimum. This is
what lets the `kind: 'fragua'` handler
([`ernesto-interop.md`](ernesto-interop.md) §5) map a fragua run's terminal to
an Ernesto `HandlerResult` with one switch.

**Convergence state — DONE (both engines).** Both engines emit this shape.
fragua converged at `EVENT_CONTRACT_VERSION = 4`: its three former terminal
facts (`run_completed { finalNode }` / `run_halted { reason }` /
`run_cancelled { intentSeq }`) collapsed into one `run_terminated { status, … }`,
the per-status detail a union discriminated on `status` (**lossless** — every
field above is preserved). fragua's `run_state.status` **projection** keeps its
terminal values (the *fact* collapsed; the projection it folds into did not):
`completed` → `completed`, `errored` → `halted`, `aborted` → `cancelled`.

**Status vocabulary — resolved (2026-06-16):** `completed | errored | aborted`
— Ernesto's existing wire. fragua adopts it (its `HaltReason`/`run_halted` →
`errored` + detail, `run_cancelled` → `aborted`); zero Ernesto churn, and not
worth a bikeshed over `failed` vs `errored`.

### 3.2 The pause fact — one `fact.run_paused { reason }`

The same shape as the terminal (§3.1), one level over: a paused run emits one
`fact.run_paused`, carrying a `reason` that classifies **who or what resumes**
it:

| `reason` | Resumed by | beyond-minimum payload |
|---|---|---|
| **human** | an operator answering a prompt (HITL) | `{ nodeId, text, routes }` |
| **signal** | a durable worker, on an external state-change | `{ nodeId, signalKey }` |
| **auto** | the engine itself, on a timer (retry backoff, rate-limit wait) | `{ resumeAt?, detail? }` |
| **operator** | an operator explicitly resuming a hold | `{ detail? }` |

One fact, one discriminant. Minimum is `{ reason }`; the `human` / `signal`
variants additionally carry their resume payload (`text`+`routes` /
`signalKey`). Engine-specific sub-reasons ride as a `detail` extension —
fragua's `PauseReason` (`budget`, `max_retries`, `provider_error`,
`provider_retry`, …) collapses under the coarse `auto` / `operator` core,
exactly as `HaltReason` is failed-disposition detail (§3.1). `fact.run_resumed`
is the matching re-entry event (core).

**Convergence state — fragua DONE (HITL fold); `signal` is tier-2.** fragua's
`fact.run_paused` is one discriminated event (`{ reason, … }`); at
`EVENT_CONTRACT_VERSION = 4` its separate HITL pause fact folded in as
`reason: human` (carrying `{ nodeId, text, routes, routeLabels?, snapshot? }`),
joining `auto` + `operator` (its 13-value `PauseReason`, split by
`AUTO_WAKE_PAUSE_REASONS`). Ernesto has **two** pause facts (`run_paused_human`
+ `run_paused_signal`) that fold into `run_paused { reason: human | signal }`.
Both lossless; fragua's `run_state.status` (`paused` / `paused_auto` /
`paused_human`) keeps its values, folded from `reason`, as with the terminal.
fragua does **not** emit `reason: signal` yet — that arrives with the
external-wait primitive (§6.2).

**`signal` is the tier-2 value.** Ernesto emits `reason: signal` today; fragua
emits it once it builds the external-wait primitive (§6.2). The pause *event*
converges now (tier-1); the `signal` *reason value* arrives with the
capability. This is the `human | signal` split generalized — the resume-by axis
is just the `reason` discriminant, with `auto`/`operator` the engine-resumed
ends.

**Open sub-decision — the reason vocabulary.** `human | signal | auto |
operator` (proposed) is the cross-engine core; it folds into the same naming
call as the terminal status set ([`ernesto-interop.md`](ernesto-interop.md) §9).

## 4. Cost / usage — converge on `fact.usage` (tier 1)

The converged carrier is a sibling **`fact.usage`** fact, with the minimum:

```
fact.usage { nodeId, inputTokens, outputTokens, costUsd, cacheRead?, cacheWrite?, modelUsage? }
```

Ernesto's form is the chosen one because it is the more general carrier — a
sibling fact admits **per-turn** and **per-model** granularity, and run-level
(non-node) usage, that a field inlined on `node_completed` cannot express.

**Convergence state.** Ernesto already emits `fact.usage`. fragua today
inlines cost on `fact.node_completed` (`{ tokens, costUsd }` + input/output/
cache split); it converges by **also emitting `fact.usage`** at node
completion — cheap, it already has the numbers — while keeping the inline
`node_completed` cost fields as a **fragua-internal extension** that its budget
reducer and `total_cost_usd` / `billed_tokens` generated columns fold from. So
the cross-engine carrier becomes `fact.usage`; the inline fields stay, demoted
from contract to fragua-internal. A consumer reads cost from `fact.usage` on
either engine.

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

## 6. Beyond the core — the three tiers (informative)

A classification of every non-core `fact.*`, so a reader knows what is
converging, what is waiting on a build, and what stays divergent by design
(§0). The core (§3) stays small; the periphery is sorted, not erased.

### 6.1 Converging — pure encoding (tier 1)

Same event and information, different shape; the contract picks one form and
both engines move. **Closed in v0:** the terminal fact (§3.1), the pause fact
(§3.2), and the usage carrier (§4). No open tier-1 items remain.

### 6.2 Converge-on-capability (tier 2)

One engine has a runtime primitive the other lacks. Convergence is *wanted*
but waits on the laggard building it (its own design); the taxonomy then adopts
the shared shape. A real capability gap, not an encoding one.

- **External wait — the `signal` pause-reason value.** The pause *event* shape
  already converged (§3.2): one `fact.run_paused { reason }`, `reason ∈ human |
  signal | auto | operator`. What's tier-2 is the **`signal` reason value** —
  Ernesto emits it (park on an opaque `signalKey`, a durable worker resumes;
  its `monitor` kind rides this); fragua has no external-wait primitive, so it
  never emits `reason: signal` yet. A fragua workflow can't wait on CI, a
  deploy, or a remote job without an LLM step polling. **fragua intends to add
  one; it needs its own design** (the resume mechanism, the durable watcher,
  how it folds — fragua's single-daemon model differs from Ernesto's any-pod
  worker). When it lands, fragua simply starts emitting the already-defined
  `reason: signal`; no new event type. Tracked:
  [`ernesto-interop.md`](ernesto-interop.md) §6.4.

(The per-step *result* payload — fragua's `outputs` record vs Ernesto's
`output` value — is **not** a tier-2 gap: both carry a node's typed result, it
is a naming/shape alignment, §6.3.)

### 6.3 Architectural choice — stays divergent (tier 3)

- **Streaming granularity.** fragua keeps per-token deltas **off the log**
  (message-level `message_appended` on-log; deltas SSE-only, ephemeral);
  Ernesto puts `assistant_delta` / `tool_call` / `tool_result` / `thinking`
  **on-log**. A fragua → Ernesto bridge forwards at message granularity —
  faithful, not lossy (the core never promised token deltas). Convergence
  would mean a side reversing a deliberate architectural call; not a target.
- **Workflow identity on `run_started`.** fragua identifies a workflow by
  content `workflowSha`; Ernesto by `workflow` name + `inputs`. Different
  identity models (sha-pinned static IR vs named declaration); the identifier
  form stays engine-specific, which is why §3's `run_started` minimum is `{}`.
- **Result-payload naming (cosmetic, alignable).** fragua's `node_completed`
  carries a typed `outputs` **record** — plural for symmetry with `inputs:`
  (both are records of named, individually-addressable fields), emitted
  atomically via one `emit_output`; it is **not** "many outputs vs one," it is
  one typed result whose fields are named. Ernesto carries a single `output`
  value (with optional `outputFormat` validation). The field name and the
  cross-step read token (`steps.*.outputs.*` vs `outputs.*`) are cosmetic, not
  a capability gap — and the read token is **both-aliased** by contract
  ([`ernesto-interop.md`](ernesto-interop.md) §9.3), neither engine renaming.
  Listed here only so it isn't mistaken for a capability difference.

### 6.4 Engine-specific lifecycle (tier 3, by nature) — §5-promotion candidates

Each engine's own runtime surface, not a divergence to erase — though some are
worth promoting into core later:

- **fragua:** `dispatch_started`, `node_aborted`,
  `tool_completed`, `message_appended`, `snapshot_recorded` (git provenance),
  `fanout_started` / `fanout_joined`, `schedule_*`, and the durable-daemon
  family `run_quarantined` / `run_requeued_after_crash` / `daemon_takeover` /
  `provider_retry_attempted` / `handler_timeout_leaked` — the last group a
  candidate Ernesto may want once it runs durable cross-pod work.
- **Ernesto:** `subagent_started` / `subagent_completed`; `fact.component`
  (typed UI intents per-transport renderers consume — a candidate fragua may
  want for its web UI, which today re-derives everything from raw facts).
