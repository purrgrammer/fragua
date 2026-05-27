---
title: Run inputs — remove the legacy free-form routing.input, spill oversized typed inputs to the blob CAS
summary: "A run's typed inputs (`routing.inputs`, the `${{ inputs.x }}` substitution source) ride inside the genesis `intent.run_enqueued` event, which is subject to the 4 KB event-payload cap (MAX_EVENT_PAYLOAD_BYTES). So a run's inputs are silently capped at ~4 KB — a pasted spec, a long brief, or several sizeable typed inputs can't be enqueued. The cap is correct for events (they're folded, streamed, replayed — they must stay lean) but wrong as a ceiling on *content*. Fix: at enqueue, spill oversized `routing.inputs` string values (lossless execution data) to the content-addressed blob store and leave a `{ $fragua_blob: sha }` reference in the event; resolve on read (substitution, auto-title, UI, export). The legacy free-form `routing.input` description was REMOVED entirely (Part A — schedules' free-form description now becomes the fired run's title; schema migrated v1→v2), so the only run-input surface is typed `routing.inputs`. This preserves both invariants — events stay small AND events are truth (the ref is in the log; the blob is immutable CAS) — and makes input size unbounded. It reuses the existing blob CAS (the same store artifacts use) so spilled inputs already travel in bundles, and it composes with secret-scrubbing: a spilled input blob is scrubbed by the same blob path as any text artifact, so this MUST land after the scrubber's artifact re-CAS unit (else the scrubbed-content sha and the routing ref diverge)."
status: implemented-experimental
part-a-status: shipped (routing.input removed; schedule desc→title; schema v1→v2 migration)
part-b-status: shipped (B1 spill+materializeRouting+gc-roots; B2 bundle export/import + scrubber composition)
maturity: experimental
last-reviewed: 2026-05-28
experimental: "Part A (routing.input removal + schema v2) is a landed schema/contract change. Part B (input spill to CAS) shares the bundle/scrubber surface, which stays EXPERIMENTAL until a v1 contract is cut (see secret-scrubbing.md) — the $fragua_blob ref shape and spill thresholds are not frozen."
---

# Large run inputs

> **Sketch.** Two coupled cleanups of the same surface (a run's inputs):
> **(A)** remove the legacy free-form `routing.input` description entirely, and
> **(B)** spill oversized typed `routing.inputs` to the blob CAS (where
> messages/artifacts already put bulk), keeping a content-addressed reference in
> the genesis event. Doing (A) first removes a confusing, redundant field and
> shrinks what (B) must handle; (B) then makes typed-input size unbounded. Common
> small runs are untouched.

## 1. The limitation

A run's inputs live in the genesis `intent.run_enqueued` event's `routing`
object (`events.ts:286`, `routing: Record<string, unknown>`). Two distinct things
live there, and they have **opposite size-handling needs**:

- **`routing.inputs`** — the typed input map, the `${{ inputs.x }}` substitution
  source (`executor-helpers.ts:214`). This is **execution-critical and must be
  lossless** — it is read back into the run. This is the real spill target.
- **`routing.input`** — the legacy free-form positional description. It was
  **not** substituted (CLAUDE.md rule 13), not execution data — only the UI and
  the auto-titler seed read it. **Part A removed it entirely** (§1a): it predated
  typed inputs and was redundant with `--input` + `--title`, so there is no spill
  question for it — the only run-input surface left is typed `routing.inputs`.

That event is validated against
`MAX_EVENT_PAYLOAD_BYTES = 4096` at `enqueueRun` (`store.ts:597`). So **the
combined serialized size of a run's inputs is capped at ~4 KB**, minus the room
taken by `routing`'s structural entries (`budget_override`,
`max_retries_override.<nodeId>`, …). A multi-paragraph brief, a pasted ticket, a
long prompt, or simply several sizeable typed inputs is rejected
`PayloadTooLargeError` at enqueue.

The mismatch: inputs are **content** (potentially large, agent-read), stored in
a **structural event**. The 4 KB cap is right for events — they are folded into
state, streamed over SSE, and replayed; they must stay lean. It is wrong as a
ceiling on input content.

## 1a. Part A — remove `routing.input` entirely

`routing.input` is the legacy free-form positional description, predating typed
inputs. It is **not execution data** (never substituted — CLAUDE.md rule 13), and
its only consumers are cosmetic:

- the **auto-titler** seeds from it (`auto-titler.ts:51`) — but already falls back
  to composing a title from `routing.inputs` `name=value` lines;
- the **UI** shows it as the run description / null-title fallback
  (`read-plane/projections.ts:141`, `RunDetail.tsx`, `reducers.ts:255`).

Removing it (set at `plane.ts:214` from `EnqueueInput.input`):

1. Drop `EnqueueInput.input` and the `initialRouting["input"]` assignment; stop
   threading it from `fragua run` / the server.
2. Auto-titler seeds only from `routing.inputs` (+ workflow name/goal); drop the
   `routing.input` branch. **Consequence (intended):** a run with no typed inputs
   (a schedule fire, or `fragua run` with no `--input`) now has an empty seed, so
   `run_state.title` stays `null` and the UI shows the workflow name. Titles are
   effectively opt-in via typed inputs; this is the chosen behavior, not a
   regression.
3. Read-plane: drop `RunSummary.input`; the UI's description/fallback uses the
   generated title, else the workflow name + a compact `routing.inputs` render.
4. Update CLAUDE.md rule 13 and SPEC §3 (the "free-form positional lands on
   `routing.input`" wording goes away).

**The one entanglement — schedules (minimal resolution).**
`fragua schedule add --input <text>` is a *free-form description for every fire*
(`schedule.ts:221`, `schedule_create` payload `input?`, `events.ts:897`) → becomes
`routing.input` on each fired run. Removing `routing.input` means that description
needs a new home. The **minimal** fix — and the one that keeps this a single
focused removal — is to route the schedule's description to the fired run's
**title** (the existing `--title` mechanism, which already suppresses
auto-titling) instead of `routing.input`. Schedules keep a human label; nothing
gains a new input system.

> **Decoupled, not bundled:** schedules having **no typed-input path** (you can't
> schedule a workflow that needs non-default typed inputs) is a real *separate*
> gap — orthogonal to this removal, and a feature, not a cleanup. Track it on its
> own; do **not** fold a typed-input-for-schedules system into the
> `routing.input` removal.

## 2. The load-bearing principles

- **Events stay small; bulk goes to the CAS.** This is already how the system
  handles size: message content (≤1 MiB) and artifacts live in the blob store
  (`BlobFS`, sha256), and small records *reference* them (an artifact row
  carries `blobSha`). Inputs should follow the same rule.
- **Events are truth.** Whatever the fix, a run's inputs must remain
  reconstructable from its event log (replay, import). So the genesis event keeps
  the *reference*; the referenced blob is immutable, content-addressed, and
  travels with the run.

## 3. The fix: spill-by-reference

At enqueue, if the serialized `routing` would exceed a margin under the cap,
**spill its largest string values to the blob CAS and replace each with a
reference**, leaving the genesis event small:

```jsonc
// routing, inline (small run — unchanged, no blobs):
{ "inputs": { "task": "…short…" } }

// routing, spilled (large run): the oversized typed input value spills.
{ "inputs": { "task": { "$fragua_blob": "<sha256>", "bytes": 9211 } } }
```

(`routing.input` no longer appears — Part A removed the free-form description
field entirely; `routing.inputs` is the only run-input surface.)

- **Spill policy.** Inline as today when `routing` serializes under a margin
  (e.g. 3 KB) — the common case pays nothing (no blob write, no read
  indirection). Only when over the margin, spill the largest **`routing.inputs`**
  string values until under it (these are lossless execution data). Structural
  entries (numbers, override objects) never spill.
- **Reference sentinel.** A distinctively-keyed object (`$fragua_blob`) that
  cannot collide with a legitimate JSON value the caller would pass. Carries the
  sha and original byte length (the length is non-secret structural metadata,
  useful for UIs and the GC root scan).
- **Write seam.** The spill happens in the intent-plane enqueue commit (the write
  surface both the CLI and server route through) — it already has the store +
  blob handle. Blob writes are idempotent (CAS), so a re-enqueue of identical
  input is a no-op.

## 4. Resolution on read

Anywhere `routing` content is *read*, resolve refs through one helper —
`materializeRouting(routing, blobs)` — that deep-walks and replaces each
`$fragua_blob` ref with its blob bytes:

- **Substitution** — `executor-helpers.ts:214` builds the `${{ inputs.x }}` map
  from `routing.inputs`; resolve first.
- **Auto-title** — reads `routing.input` as the title seed; resolve first.
- **UI / read-plane** — resolve when surfacing inputs.

The blob store is the same `~/.fragua` CAS the daemon already reads, so the
executor resolves locally; `fragua ci`'s ephemeral store holds its own spilled
blobs.

## 5. Bundles, GC, and the scrubber (the three interactions)

- **Bundles.** Spilled-input blobs are referenced by the genesis `routing`, so
  export must add them to the bundle's blob set (today the set is artifact
  `blobSha`s only). Import already verifies every blob against the manifest;
  resolution on the imported (inert) run then works unchanged.
- **GC.** `fragua db gc-blobs` collects unreferenced blobs. Routing-referenced
  blobs must be counted as **roots** alongside artifact blobs, or a GC would
  delete a live run's inputs. This is the one place the change is a *latent
  data-loss bug* if missed — call it out in the implementation.
- **Secret-scrubbing (ordering constraint).** The scrubber deep-scrubs
  `routing`'s string values at export ([secret-scrubbing.md](secret-scrubbing.md)
  §unit-5). But once an input is spilled, `routing.input` is a **ref object, not
  a string** — so the routing-scrub pass sees no content to scrub; the secret
  sits in the blob. The blob must therefore be scrubbed by the **blob/artifact
  re-CAS path**, and the routing ref's sha rewritten to the scrubbed sha
  (exactly the re-CAS consistency the scrubber already does for artifacts). **So
  this feature must land after the scrubber's artifact re-CAS unit**, and its
  tests must assert a secret placed in a *spilled* input is absent from the
  exported bundle (not just inline inputs).

## 6. What this is not

- **Not raising the cap.** The 4 KB cap stays — it protects the hot
  fold/stream/replay path for *every* event. Spilling exempts only the bulk, not
  the invariant.
- **Not truncation.** No input is silently lost; the full content is preserved
  in CAS.
- **Not a new coordination surface.** The blob store is part of `@fragua/store`;
  no new table, no filesystem coordination. The genesis event remains the source
  of truth (it carries the ref).

## 7. Open questions

- **Spill granularity.** Per-value (spill any string leaf over N bytes) vs.
  total-routing-over-margin (spill largest leaves until under). Per-value is
  simpler and more predictable; total-margin minimizes blob count. Lean
  per-value with a small N (≈1 KB) plus a hard total guard.
- **Sentinel shape + escaping.** Is `$fragua_blob` safe against a user input that
  is literally that JSON? A typed input value is always a *string* at the leaf,
  so a ref *object* in value position is unambiguous — but confirm the
  read-plane/UI never round-trips a raw object into routing.
- **`fragua ci` parity.** CI seeds an ephemeral store; spilled blobs live there
  and export into the CI bundle. Confirm the ephemeral blob dir is wired the same
  as the persistent one.
- **Schedule input migration.** Adding typed `--input name=value` to
  `fragua schedule add` (Part A) changes the `schedule_create` payload shape. No
  back-compat is required pre-release, but confirm no existing schedule rows in a
  dev store rely on the old free-form `input` (or accept that they re-create).

## 8. MVP order

**Part A — remove `routing.input`** (one focused unit; shrinks Part B's surface):

1. **Drop `routing.input`** — remove `EnqueueInput.input` + the
   `initialRouting["input"]` write; re-point the auto-titler (seed from
   `routing.inputs` + workflow name) and the read-plane/UI (drop
   `RunSummary.input`; title fallback → workflow name); route the schedule
   description to the fired run's **title** instead of `routing.input`. Update
   CLAUDE.md rule 13 + SPEC §3. (Typed-inputs-for-schedules is a separate gap,
   not part of this.)

**Part B — spill oversized typed inputs:**

2. ✅ (B1) **Spill at enqueue** — `store.ts enqueueRun` spills `routing.inputs` string
   leaves over the margin to the blob CAS via `spillRoutingInputs` (`routing-blobs.ts`);
   blob rows inserted inside `writeTxn`; small runs unchanged.
3. ✅ (B1) **`materializeRouting`** — resolver in `routing-blobs.ts`; wired into
   `executor.ts effectiveRouting` build (covers substitution and auto-titler seed).
4. ✅ (B1) **GC roots** — `gcBlobs` collects routing blob shas from all `run_state.routing`
   rows and passes them as a protected set to both GC passes (SQL anti-join +
   file-sweep skip). Single reachability decision point extended.
5. ✅ **Bundle export/import** — routing-referenced blobs seeded into `reCasMap`
   alongside artifact blobs; blob travels in the bundle, integrity-checked on
   import; `materializeRouting` resolves cleanly in the imported store.
6. ✅ **Scrubber composition** — spilled input blobs scrub via `scrubText` (the
   re-CAS path); routing ref sha rewritten to the scrubbed sha; shared `reCasMap`
   deduplicates routing/artifact blobs consistently. PBT (`scrub-e2e.property`)
   now seeds a large (>1 KiB) spilled routing input so the spilled-blob path is
   covered by the §12 capstone gate.
