---
title: Large run inputs — spill oversized routing to the blob CAS, reference by sha
summary: "A run's typed inputs (`routing.inputs`, the `${{ inputs.x }}` substitution source) ride inside the genesis `intent.run_enqueued` event, which is subject to the 4 KB event-payload cap (MAX_EVENT_PAYLOAD_BYTES). So a run's inputs are silently capped at ~4 KB — a pasted spec, a long brief, or several sizeable typed inputs can't be enqueued. The cap is correct for events (they're folded, streamed, replayed — they must stay lean) but wrong as a ceiling on *content*. Fix: at enqueue, spill oversized `routing.inputs` string values (lossless execution data) to the content-addressed blob store and leave a `{ $fragua_blob: sha }` reference in the event; resolve on read (substitution, auto-title, UI, export). The legacy free-form `routing.input` description is truncated, not spilled — it's not execution data and is a deprecation candidate. This preserves both invariants — events stay small AND events are truth (the ref is in the log; the blob is immutable CAS) — and makes input size unbounded. It reuses the existing blob CAS (the same store artifacts use) so spilled inputs already travel in bundles, and it composes with secret-scrubbing: a spilled input blob is scrubbed by the same blob path as any text artifact, so this MUST land after the scrubber's artifact re-CAS unit (else the scrubbed-content sha and the routing ref diverge)."
status: sketch
maturity: sketch
last-reviewed: 2026-05-27
---

# Large run inputs

> **Sketch.** Run inputs are content stored in a structural event. Move the bulk
> to the blob CAS (where messages/artifacts already put bulk), keep a
> content-addressed reference in the genesis event. Common small runs are
> untouched (no spill, no blob, zero overhead); only oversized inputs spill.

## 1. The limitation

A run's inputs live in the genesis `intent.run_enqueued` event's `routing`
object (`events.ts:286`, `routing: Record<string, unknown>`). Two distinct things
live there, and they have **opposite size-handling needs**:

- **`routing.inputs`** — the typed input map, the `${{ inputs.x }}` substitution
  source (`executor-helpers.ts:214`). This is **execution-critical and must be
  lossless** — it is read back into the run. This is the real spill target.
- **`routing.input`** — the legacy free-form positional description
  (`fragua run wf "describe it"`). It is **not** substituted (CLAUDE.md rule 13),
  not execution data; only the UI (run description / title fallback) and the
  auto-titler seed read it — and the titler already falls back to composing from
  `routing.inputs`. It predates typed inputs and is redundant with `--input` +
  `--title`. It does **not** need lossless preservation — truncate it to a
  title-seed length, or deprecate it; never spill it.

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
{ "input": "rename foo to bar", "inputs": { "task": "…short…" } }

// routing, spilled (large run): only the typed inputs spill; the description
// is truncated, not spilled (it's not execution data).
{ "input": "Implement the spec for the new export… [truncated]",
  "inputs": { "task": { "$fragua_blob": "<sha256>", "bytes": 9211 } } }
```

- **Spill policy.** Inline as today when `routing` serializes under a margin
  (e.g. 3 KB) — the common case pays nothing (no blob write, no read
  indirection). Only when over the margin, spill the largest **`routing.inputs`**
  string values until under it (these are lossless execution data). Structural
  entries (numbers, override objects) never spill.
- **`routing.input` is truncated, not spilled.** It's a description / title
  seed, not execution data, so a long one is clipped to a title-seed length
  (the auto-titler asks for short titles anyway) rather than blob-spilled. The
  cleaner long-term move is to deprecate it in favor of typed inputs + `--title`
  ([§7](#7-open-questions)); spilling it would be optimizing a legacy surface.
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
- **Deprecate `routing.input`?** It's a legacy free-form description, redundant
  with typed inputs + `--title`, read only by the UI (description / title
  fallback) and the auto-titler seed (which already falls back to composing from
  `routing.inputs`). Removing it — point those two consumers at
  `routing.inputs`/workflow name — would let this proposal ignore it entirely
  rather than truncate it. Bounded cleanup, separate decision.

## 8. MVP order

1. **Spill at enqueue** — intent-plane commit: serialize `routing`, spill string
   leaves over the margin to blobs, write refs. Inline path unchanged for small
   runs.
2. **`materializeRouting`** — one resolver; wire into substitution, auto-title,
   read-plane.
3. **GC roots** — `gc-blobs` counts routing blob refs as roots. (Data-loss
   guard; do not defer.)
4. **Bundle export/import** — add routing-referenced blobs to the bundle blob
   set; resolution works on import.
5. **Scrubber composition** — spilled input blobs scrub via the artifact re-CAS
   path; routing ref sha rewritten to the scrubbed sha. PBT: a secret in a
   *spilled* input is absent from the export.
