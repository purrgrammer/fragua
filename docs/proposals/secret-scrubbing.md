---
title: Secret scrubbing for run bundles — egress-time redaction, not ingress
summary: "Bundles are the only thing that leaves the machine, so they are the only thing that must be secret-free. The scrubber runs ONCE, at the egress boundary (`exportRunBundle`), over a terminal run — NOT at store-write time. This is forced by correctness: persisted `messages` and `routing.inputs` are read back into execution (shared-thread hydration, `${{ inputs.x }}` substitution, resume), so redacting them in place would feed `[REDACTED]` to the LLM. The local store stays RAW (execution truth); the bundle is REDACTED (publication truth) — and that is fully compatible with I3, which forbids rewriting a committed fact, not transforming a read into a new artifact. `fragua ci` gets a distinct high-assurance profile (fail-closed, job-fails on a live-cred hit, env-seed registry) because its bundle is the least-trusted destination and the threat model there is adversarial. Disclosure rides inline `[REDACTED:source]` markers, not a manifest that travels in the tar."
status: sketch
maturity: sketch
last-reviewed: 2026-05-27
---

# Secret scrubbing for run bundles

> **Sketch — egress-only, correctness-forced.** The scrubber is an export-time
> filter in `exportRunBundle`, not a store-write interceptor. The local SQLite
> stays raw because the executor reads persisted `messages` / `routing` back into
> execution; the bundle (the only artifact that leaves the machine) is the thing
> that gets redacted. `fragua ci` runs a stricter, fail-closed profile of the
> same engine. The former open knobs (marker granularity, entropy, `cwd`, tar
> reproducibility) now resolve onto the two-profile trust split — see
> [§13](#13-resolved-decisions-was-open-questions).

## 1. The two load-bearing principles

If this design is cut to the bone, keep these:

- **The store is execution truth; the bundle is publication truth.** The local
  store must stay *raw* — the executor reads persisted state back into execution.
  Only the bundle leaves the machine, so only the bundle must be secret-free.
  Redaction happens once, at the egress boundary, over a run that will not
  execute again.
- **The scrubber catches accidents, not attacks.** In the adversarial case
  (`fragua ci` PR-review: untrusted PR author, public bundle) a scrubber cannot
  win against an adversary who can transform their own output. The only control
  that holds is the *perimeter* — the secret never reaches the agent. The
  scrubber is insurance against accidental verbatim echoes, never the defense.

## 2. Leak surfaces

In rough order of severity / scrubber-friendliness:

1. **Worktree snapshots** (`refs/fragua/snapshots/<runId>`) — literal git trees.
   **Not an egress surface: `exportRunBundle` never reads them** (`store.ts:1311`
   tars events + messages + artifacts + workflow + blobs — no refs). They leak
   only through *local* operator actions (`gitDiff`, `applyAccept`), which is a
   separate concern from the bundle — see [§9](#9-snapshots-not-an-egress-surface).
2. **Artifacts** (`blobsDir`, CAS by sha256) — raw tool outputs. Redaction
   changes the sha; the bundle re-hashes into its own independent CAS.
3. **Messages** (`AgentMessage`, ≤1 MiB) — `role=tool` carries stdout/stderr;
   `role=assistant` can echo secrets; thinking blocks paraphrase them.
4. **Observability deltas** (`llm.text_delta`, `llm.thinking_delta`,
   `llm.toolcall_delta`) — streaming; a secret can split across two deltas.
5. **Event payloads** (≤4 KB): `fact.tool_completed.preview`,
   `intent.steering_requested.text`, `fact.run_paused_human.text`,
   `intent.human_input.note`, `errorMessage`.
6. **Routing** (`run_state.routing`, ≤8 KB): `routing.input` / `routing.inputs`.
7. **Bundle manifest metadata**: `cwd` (a filesystem path — username, project
   codename), `title` (LLM-generated free text), input/description.

## 3. The architectural decision: egress, not ingress

**The drift this corrects.** `exportRunBundle`'s docstring already asserts the
bundle is *"credential-free by construction"* (`store.ts:1304`) — its reasoning is
"secret + machine-local tables are never read." That reasoning is wrong: not
reading the `provider_credentials` table does **not** make the bundle
credential-free, because secrets flow into the bundle as *content*, not as table
rows. `getEvents` returns observability deltas verbatim (`store.ts:672`, no type
filter) and `messages` carry the raw transcript. The export is secret-bearing
today; this proposal makes the docstring's claim true, and the docstring is
corrected in the same change.

The first instinct is to scrub at *write time* (`appendMessage`, `appendFact`, …)
so "the DB lives clean by construction." **That is wrong, for a correctness
reason, not a stylistic one.** Persisted state is read back into execution:

- **Shared-thread hydration.** A step that reads a `thread:` calls
  `ctx.messages.since(0)` (`handler-bridge.ts:145` → `context.ts:91` →
  `store.getMessages()`) and passes those rows to the backend as `priorMessages`.
  Resume after a daemon restart relies on `since(0)` returning the full
  transcript (§3.6).
- **`${{ inputs.x }}` substitution.** The substitution map comes from
  `routing["inputs"]` on the effective routing (`executor-helpers.ts:207`), which
  is seeded from persisted `state.routing`.

If we redacted `messages` or `routing` at write time, a downstream step — or the
same run after a restart — would receive `[REDACTED]` as its execution context
and silently hallucinate. The highest-value surface (messages) is *not*
scrubbable in its persisted form, because the persisted form **is** the execution
context.

**This does not violate I3, and I3 never forced ingress.** I3 forbids rewriting a
*committed fact in place* (which would break OCC and replay). Export does not
rewrite anything — it *reads* the log and *produces a new artifact* (the tar).
Egress-time redaction is therefore fully compatible with immutability. The honest
framing:

> **Execution truth** = the local store, **raw** (the executor needs it raw to
> resume and to pass threads).
> **Publication truth** = the bundle, **redacted** in `exportRunBundle`.

Egress also dissolves *every* correctness trap at once: export runs over a
terminal run, so at export time `routing.inputs`, `messages`, and artifacts have
no future readback — all become safe to redact. And it keeps the scrubber out of
the store-append hot path, so the tested invariants (I1, I3, the 4 KB cap) and
the PBT corpus are untouched (no self-redaction of test fixtures, no flake when
`fast-check` emits an `AKIA…`-shaped string).

The one thing egress gives up — secrets *at rest* in the local DB — was never the
threat model: the `.env`, the worktree, and shell history already hold those
secrets on disk. The scrubber's job is *sharing*, and the boundary of sharing is
the tar, not the row.

> **No second egress (for now).** The Web UI / SSE serves the raw local store; we
> assume `serve` is local-only and the operator's browser is trusted. If remote
> `serve` (non-local bind) ever becomes a supported posture, the UI becomes a
> second publication boundary that egress-at-export does not cover — revisit then.
> **Cheap guard to add now, before that day:** have `serve` refuse a non-loopback
> bind unless an explicit `--allow-remote` is passed. The assumption "`serve` is
> local-only" is currently unenforced; one startup check turns a silent
> raw-store-over-the-wire footgun into a deliberate opt-in.

## 4. What the egress pass does

A single transform in `exportRunBundle` that, per run:

1. **Drops content-bearing observability events** — `llm.text_delta`,
   `llm.thinking_delta`, `llm.toolcall_delta`, `tool.output_chunk`, `agent.*`.
   These persist (`appendObservabilityEvents` → `events` table, `store.ts:486`)
   and currently export verbatim (`getEvents` has no type filter,
   `store.ts:1311`), but they are **redundant** with the finalized `messages`
   transcript and are pure streaming scaffolding. The UI renders an imported
   run's conversation, thinking, and tool calls from `messages`
   (`RunConversation`), not from deltas — confirmed: a terminal run never opens
   SSE. Dropping them is the security fix **and** lossless.
2. **Keeps `cost.recorded`** — numeric/structural, no secret payload, and the
   sole source of the cost view (`CostInspector` → `/steps` →
   `getStepAggregates`). Dropping it would zero out cost on imported runs.
3. **Scrubs text fields** — `messages` content blocks, fact
   `preview`/`text`/`note`/`errorMessage`, `routing.input`/`routing.inputs`, the
   workflow body copy, and the titling fact's text. Replacement is a fixed
   `[REDACTED]` / `[REDACTED:source]` marker (label per profile —
   [§13](#13-resolved-decisions-was-open-questions)) with **no length
   preservation** (length is a side channel).
4. **Re-CASes artifacts** after scrubbing text-ish blobs. A scrub changes a blob's
   bytes, hence its sha256 — so the new sha must be rewritten *consistently* across
   all three places it appears: the blob entry name (`blobPath(sha)`), the
   `blobSha` in `run-artifacts.jsonl`, and the `blobs[]` manifest entry
   (`store.ts:1323-1340`). Import verifies every blob against the manifest, so an
   inconsistent re-CAS fails import — the re-hash is load-bearing, not cosmetic.
   Text-ish blobs (mime in a text allowlist — `text/*`, `application/json`,
   `application/x-yaml`, …) get the full scrub; **binary blobs are skipped** and
   marked `binary, not inspected`. A secret embedded in a binary artifact is a
   known residual hole (deferred — see [§13](#13-resolved-decisions-was-open-questions)).
5. **Snapshots: nothing to do** — they are not in the bundle ([§9](#9-snapshots-not-an-egress-surface)).

`deriveRunState` skips all non-fact events (`reducers.ts:302`, the
`!e.type.startsWith("fact.")` continue), so dropping
observability from the bundle does not affect replay on import.

## 5. The `ci` profile vs the export profile

Same engine, two postures. The difference is the *destination's* trust floor.

| | `fragua runs export` (local) | `fragua ci` |
|---|---|---|
| Destination | chosen parties, deliberate share | CI artifact / PR comment, possibly public |
| Human in loop | yes (operator) | no (unattended) |
| Scrub error | warn-and-proceed (operator decides) | **fail-closed: no bundle** |
| Live-cred (`provider_creds`) hit | noisy stdout warning | **fails the job** |
| Marker labels | `[REDACTED:source]` (review value) | `[REDACTED]` generic (no type-census) |
| Entropy detector | off; `--entropy` opt-in (recoverable) | off, **not available** (no human to catch FP) |
| Literal registry | `provider_credentials` (present-tense) | `process.env` captured at seed time |

`ci` is fail-closed because nobody is watching: a leak in an unattended pipeline
that posts to a public PR is silent and permanent. A `provider_creds` hit during
a `ci` scrub means the perimeter leaked a *live* key into the bundle path — that
must turn the job red, not print a line nobody reads.

**Entropy stays off even in `ci`.** The bundle exists to be *reviewed*; an
entropy detector that shreds legitimate hashes, diffs, and base64 blobs defeats
that purpose. `ci` is aggressive on credential-*shaped* content (patterns +
env-literals), not blind high-entropy.

## 6. Threat model: `ci` PR-review is adversarial

In the PR-review flow the **PR author is untrusted**, controls the code the agent
runs against, and the resulting bundle is **public**. That is a live exfiltration
incentive: a malicious PR tries to get the agent to read `GITHUB_TOKEN` / a
provider key and emit it in a scrubber-evading form (base64, split, transformed,
LLM-reworded), then reads it from the public bundle.

Against an adversary who can transform their own output, **the scrubber cannot
win** — it is whack-a-mole by construction. Therefore, in `ci`, the *perimeter*
is the only line that holds:

- explicit, minimal `env` on the bash-tool subprocess — never inherit the
  runner's full env (so `printenv` can't dump CI secrets into tool output);
- path deny-list on the read tool;
- host allowlist on the http tool.

This is tractable precisely because `ci`'s secret set is small and known (provider
keys + whatever the workflow needs). The perimeter env-strip list and the scrub
registry are **the same secret set viewed two ways** — what you strip from the
subprocess env is what you add as scrub needles; derive both from one config.

## 7. The registry

`scrub(text, compiledRegistry)` — pure, no I/O, no store, **no clock, no random**.
Aho-Corasick over the literal set (O(n) in text length, indifferent to registry
size) + cached compiled regexes for known formats. **Pass a compiled automaton,
not the raw needle list** (the egress pass scans many messages of one run against
the same registry — build once). At compile time each *literal* needle is
**expanded into its declared encodings** (verbatim, base64, base64url,
percent-encode) and all forms are added to the automaton, so an accidentally
base64'd cred is caught directly. This expansion set is the exact contract the
PBT asserts ([§12](#12-assurance-an-end-to-end-pbt)) — patterns are *not* expanded
(a regex over already-encoded text is hopeless; rotated/encoded coverage there is
ceded to the perimeter).

Determinism is a hard requirement, not a nicety: the bundle is content-addressed
and re-export is meant to be byte-stable (`store.ts:1308-1310`), and a CAS dedup
of two runs sharing a blob only holds if `scrub` maps identical input to identical
output. No timestamps, no counters, no map-iteration-order in markers.

**Match-merge semantics.** Literal and pattern hits will overlap (an env-value
literal sitting inside a JWT, a cred inside a connection string). Collect all
match spans, **union overlapping/adjacent intervals into one redaction**, and emit
a single marker per merged span — never nested or back-to-back `[REDACTED]`. When
sources disagree on a merged span, the `source` label is the most-specific
contributor (`provider_creds` > `env:NAME` > `pattern:*`); in generic-label mode
the merge is invisible anyway.

The registry is **assembled at the egress boundary from whatever is available**,
and the source is context-dependent:

- **`fragua ci`** — `process.env` (secret-named vars) captured at *seed time*
  (`env-creds.ts` already reads them at startup) + seeded `provider_credentials`.
  Single ephemeral process, env still live at export → env-value literal matching
  is feasible **and critical** (CI injects secrets as env vars). Capturing at
  seed time also sidesteps mid-run rotation.
- **`fragua runs export`** (persisted store) — `provider_credentials`
  (present-tense) + patterns only. The worktree is gone, so per-run env needles
  are unavailable. **Present-tense is a real gap for OAuth:** a refreshed/rotated
  access token in the store no longer equals the (now-stale) token embedded in the
  transcript, so the literal match silently misses it. Patterns are the only
  guarantee for rotated creds — which is why patterns, not the literal registry,
  carry the load (below).

**The run's own `cwd` is a needle.** `cwd` leaks not only as a manifest field
([§11](#11-manifest-metadata-cwd-and-title)) but as an absolute path embedded in
tool output and stack traces (`/Users/alice/clients/acme-merger/…` discloses
username + client codename). Add the run's `cwd` absolute path to the literal set
so those embedded occurrences redact to a stable token, independent of the
manifest-field decision.

**Patterns are the primary guarantee** in both cases (registry-independent, robust
to rotation). Literal cred-match is a best-effort bonus when the cred is still
present at export. Env-value needles only exist for `ci`.

**Default-deny on var *names*.** A CI runner's env is huge and mostly non-secret;
treating all of `process.env` as needles is catastrophic (`GITHUB_REPOSITORY`,
`GITHUB_SHA`, `NODE_ENV`, `PORT` would redact repo names, shas, and common words
everywhere). No `GITHUB_*` globs — `GITHUB_TOKEN` is secret, `GITHUB_REF` is not.
Use a precise name allowlist (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`,
`*_CREDENTIAL` + known provider var names) plus a length/entropy floor.

**A value-length floor on *needles*, not just names.** A short or empty
credential value (a 3-char token, a `""` env var, `PASSWORD=x`) promoted to a
needle redacts everywhere it coincidentally appears — catastrophic over-redaction
that also shreds the bundle. Drop any literal needle below a minimum length
(≈8 chars) and any with whitespace; rely on patterns for the rest. This floor is
independent of the name allowlist — a secret-*named* var with a junk short value
still must not become a needle.

## 8. Disclosure: inline markers, no manifest in the bundle

Redactions do **not** travel in the tar. Disclosure rides the inline
`[REDACTED:source]` markers — self-locating (the reviewer sees the redaction
exactly where it happened) and grep-recomputable (a recipient can census the
markers themselves), so a separate `redactions` table in the bundle would be both
redundant *and* a side channel (handing the recipient a "this run touched N keys
of these types" map). It is dropped.

**Markers in the tar are advisory, not evidence.** An untrusted agent can emit the
literal string `[REDACTED:provider_creds]` in its own output — inflating a
recipient's grep-census, or worse, camouflaging a real leak as "already handled."
So the **authoritative** disclosure is the count the *scrubber itself* computed at
egress (it knows what it replaced), surfaced on the exporter's stdout — never a
grep of the shipped bundle. The grep-census is a convenience for recipients, not a
guarantee.

The manifest's real audience is the **exporter**, not the recipient: "what did I
just publish, and what did the scrubber catch?" — especially the
perimeter-failure signal of a `provider_creds` hit. So the redaction summary is
**output of the `export`/`ci` command** (stdout, e.g.
`redacted 5 hits — 4×pattern:github_token, 1×provider_creds ⚠`), and in `ci` a
`provider_creds` hit fails the job. No tar entry, no format change, no outbound
side channel — for the *census*. (The single `scrubberVersion` stamp added to the
existing `manifest.json` in [§13](#13-resolved-decisions-was-open-questions) is
*not* a census: it is one version string with no per-secret information, so it
carries no "which/how-many keys" side channel — it is an audit pin, and it does
bump `bundleVersion`.)

`source` examples: `provider_creds | env:NAME | pattern:anthropic_key |
pattern:jwt | …`. Marker *granularity* is the real disclosure dial (see
[§11](#11-open-questions)).

## 9. Snapshots: not an egress surface

**`exportRunBundle` does not read snapshot refs** (`store.ts:1311` tars events,
messages, artifacts, workflow, blobs — no `refs/fragua/*`). So the
highest-severity leak surface — literal git trees — *does not leave the machine
via the bundle at all*. For an egress-boundary proposal, that closes it: there is
nothing to scrub and nothing to exclude.

Snapshots still leak through **local operator actions** — `gitDiff` renders the
tree (`run-actions.ts:170`), `applyAccept` materializes it back into the cwd
(`run-actions.ts:99`). A *tracked* secret (a committed `.env`, an uncovered
`credentials.json` with no `.gitignore`) shows in the diff and lands on accept,
and only snapshot-*creation*-time exclusion could stop it — `git add -A` without
`--force` (`snapshotter.ts:160`) already drops gitignored files, but not tracked
ones. **That is a separate, local-hygiene concern, deliberately out of scope
here.** A snapshot deny-list (builtin `.env*`, `*.pem`, `id_*`, `credentials.json`,
`.aws/`, `.ssh/`, `.netrc`, `*.kdbx` over the gitignore-honoring base, plus an
optional `.fraguasnapshotignore`) belongs in its own proposal, because it changes
*execution/local* behavior (a tracked file vanishing from the operator's own diff),
which the egress thesis ("only the bundle is transformed, the store stays raw")
explicitly does not touch. Tracking it here only as the one surface this proposal
does **not** own.

## 10. Patterns

Base set (registry-independent): `sk-ant-`, `ghp_/gho_/ghs_`, `sk-proj-/sk-`,
`AKIA[0-9A-Z]{16}`, `xox[bp]-`, JWT `eyJ…\.eyJ…\..*`, PEM
`-----BEGIN .* PRIVATE KEY-----`, **connection strings with embedded creds**
`://user:pass@host` (postgres, redis, mongo, amqp). The last is **promoted into
the base set** (not deferred): it is endemic in `errorMessage` / stack traces —
exactly the surface a registry can't help with — and `://user:pass@` is low-FP and
catches the secret regardless of provider. Redact only the `user:pass` userinfo,
keep the scheme/host for review context.

One **candidate** remains deferred on FP grounds:

- URL query tokens `[?&](token|api_key|access_token|sig|signature|key)=…` — real
  value, but collides with legitimate API documentation and query examples that a
  `ci` reviewer wants to see. Hold for V2 behind the same review-value reasoning
  that keeps entropy off.

## 11. Manifest metadata: `cwd` and `title`

Neither is stripped — stripping forces `deriveRunState` and the UI to tolerate
absent fields (a new correctness surface) and gains little:

- **`title`** is a text field (the titling fact) → it rides the existing egress
  text scrub. A credential in the title is caught; the field stays present (a
  string), so derive is unaffected. The residual *semantic* paraphrase risk is the
  same irreducible thinking-block problem, on a short, prompt-controlled surface.
- **`cwd`** is **basename-normalized by default** at egress (`--keep-cwd-path` to
  retain), and is additionally a literal needle so embedded path occurrences in
  tool output redact too ([§7](#7-the-registry)). The anti-correlation argument
  (`ci`/public cwd is a boring runner path; a sensitive local path only ships in a
  deliberate low-exposure share) is why this is *normalize*, not *strip* — but it
  is not strong enough to justify shipping `/Users/alice/clients/acme-merger`
  verbatim to a colleague, so the basename default wins.

Both `cwd` and `title` live in the **event log** (genesis `routing.cwd`; the
titling fact), not only `manifest.json`, and import re-derives state from the log
— so transforming the manifest copy alone would not be enough. Scrub-in-place of
the titling fact covers the title in both places; the `cwd` basename-normalization
must likewise be applied to the genesis `routing.cwd` in the exported event log,
not just the manifest field, or import re-derives the full path.

## 12. Assurance: an end-to-end PBT

"Secret-free by construction" is only falsifiable with a property test: **seed
secrets** (synthetic provider keys + values matching each pattern) → flow them
into messages/facts/artifacts/manifest → **export** → assert the tar contains
**none** of the seeded values across all surfaces. Because the scrubber lives at
egress (outside store-append), this test runs in isolation without touching store
invariants.

**The PBT must assert exactly what the scrubber guarantees — no more.** A
literal-and-pattern scrubber cannot catch an *arbitrarily* transformed secret (an
LLM-reworded key, a custom XOR); asserting it could would make the gate a lie and
push the test toward green-by-luck. So pin a **declared encoding set** and test
precisely it:

- **In scope (the scrubber owns):** verbatim; and for *literal* needles, a fixed,
  enumerated transform set — base64, base64url, percent/URL-encode. These are
  generated by *expanding each literal needle into its encodings at
  registry-compile time* ([§7](#7-the-registry)), so the automaton matches them
  directly. The PBT seeds each literal in each declared encoding and asserts all
  are gone.
- **Out of scope (the perimeter owns, [§6](#6-threat-model-ci-pr-review-is-adversarial)):**
  any encoding *not* on the declared list — split-across-blocks, reworded,
  homebrew. The PBT does **not** assert these vanish; the proposal is explicit
  that against a transforming adversary the scrubber loses and only the `ci`
  perimeter holds. Patterns (not literal-encodings) are what catch a *rotated* or
  registry-absent secret, so the PBT also seeds pattern-only secrets with no
  registry entry and asserts the pattern catches them.

## 13. Resolved decisions (was: open questions)

Each former open question now tracks to a profile we already have, so it resolves
without a new axis:

- **Marker granularity → profile-defaulted.** `[REDACTED:source]` in `export`
  (chosen recipients, review value > census risk); generic `[REDACTED]` in `ci`
  (public/adversarial, deny the recipient a "this run touched N keys of these
  types" census). A `--redaction-labels=source|generic` flag overrides per export.
  This is the same trust-floor split as everything else in [§5](#5-the-ci-profile-vs-the-export-profile) —
  not a new decision.
- **Entropy default → off; opt-in only on `export`.** Off everywhere by default
  (shreds legitimate hashes/diffs/base64 → kills review value). Available behind
  `--entropy` *only* in `export`, where a false positive is recoverable (the local
  store is still raw — re-export) and a human is watching. **Not available in
  `ci`:** unattended, no one catches a false positive that silently degrades the
  artifact, and `ci`'s known secret set is already covered by patterns + env
  literals.
- **`cwd` normalization → basename-normalize by default.** Strip to the final path
  component at egress (`acme-merger` not `/Users/alice/clients/acme-merger`);
  `--keep-cwd-path` retains the full path for trusted local shares. Independently,
  cwd is a *needle* ([§7](#7-the-registry)) so embedded path occurrences in tool
  output are redacted regardless of the manifest-field choice.
- **Tar reproducibility → deferred to V2, prerequisites landed now.** Byte-identical
  re-export (→ content-addressed/dedup bundles) is V2, but its two enablers are
  *required by this proposal already*: `scrub` is pure/deterministic ([§7](#7-the-registry)),
  and the manifest stamps a **`scrubberVersion`** (registry + pattern-set +
  encoding-set version) so an auditor knows which detector ran and a future
  reproducibility check has a pin. Remaining V2 work is purely the tar envelope
  (zero mtime/uid/gid, sorted entries, fixed compression) — none of it security.

### Genuinely still open

- **Where the shared scrubber config lives** (`~/.fragua/scrubber.yaml` vs the
  existing config cascade) and whether the `ci` perimeter env-strip list and the
  scrub registry read from one block or two — MVP item 7 sketches one file; the
  exact schema is unsettled.
- **Re-export of an *imported* run.** An imported run's messages already carry
  `[REDACTED]` and its env-literal registry is gone (only patterns re-apply). This
  is acceptable (idempotent on already-redacted text), but the disclosure summary
  on re-export will under-count vs the original — confirm that's tolerable or stamp
  provenance.
- **Binary artifacts ship un-inspected.** A secret embedded in a binary blob
  ([§4](#4-what-the-egress-pass-does)) is not caught. ASCII needles *are* findable
  in a byte buffer, so a scan-then-drop (don't redact-in-place — exclude the blob
  on a hit) is the likely answer, but it is deferred until the leaner egress
  filter + registry ship.

## 14. MVP order

1. **Egress filter in `exportRunBundle`** — drop content-bearing observability,
   keep `cost.recorded`; **correct the false "credential-free by construction"
   docstring** ([§3](#3-the-architectural-decision-egress-not-ingress)) in the same
   change. Closes the active leak (deltas export verbatim today) and dissolves the
   streaming problem. Trivial.
2. **Registry + literal scrub** over messages / artifacts / fact-text / routing
   (Aho-Corasick, compiled, deterministic; encoding-expanded literals; cwd needle;
   value-length floor), per-context registry, with **match-merge** semantics.
3. **Known patterns** (§10 base set, incl. promoted connection-string).
4. **Re-CAS consistency** (skip binary, scrub text-ish) + **`scrubberVersion`
   manifest stamp** (bumps `bundleVersion`).
5. **`ci` profile** — fail-closed, env-seed registry, job-fails on `provider_creds`,
   generic markers, perimeter env-strip on the bash subprocess.
6. **PBT** end-to-end (§12) — the gate for the "secret-free" claim; asserts the
   *declared encoding set* only.
7. Allowlist + name-list config (`~/.fragua/scrubber.yaml`), shared by the
   perimeter env-strip and the scrub registry.

**Out of this proposal** (tracked, not done here): the **snapshot deny-list**
([§9](#9-snapshots-not-an-egress-surface)) — snapshots don't egress via the bundle;
it changes *local* diff/accept behavior, so it is its own proposal. The
**non-loopback `serve` guard** ([§3](#3-the-architectural-decision-egress-not-ingress))
is a cheap adjacent hardening but a different surface.

V2: URL-token pattern (§10 candidate), high-entropy behind a flag (export only),
tar-envelope reproducibility (§13), `ctx.artifacts.putRaw()` opt-out.
