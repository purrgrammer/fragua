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
> same engine. Several knobs (marker granularity, entropy default, tar
> reproducibility) are deferred — see [§11](#11-open-questions).

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
   Not rows; cannot be redacted in place without breaking the sha chain. Handled
   by *exclusion*, not scrubbing ([§9](#9-snapshots-a-separate-surface)).
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

The first instinct is to scrub at *write time* (`appendMessage`, `appendFact`, …)
so "the DB lives clean by construction." **That is wrong, for a correctness
reason, not a stylistic one.** Persisted state is read back into execution:

- **Shared-thread hydration.** A step that reads a `thread:` calls
  `ctx.messages.since(0)` (`handler-bridge.ts:337` → `context.ts:91` →
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
   workflow body copy, and the titling fact's text. Replacement is
   `[REDACTED:source]` with **no length preservation** (length is a side channel).
4. **Re-hashes artifacts** into the bundle's own CAS after scrubbing text-ish
   blobs; **skips binary** artifacts (a text scrubber over bytes corrupts the
   blob and can't find an embedded secret anyway) and marks them
   `binary, not inspected` in the inline-disclosure sense.
5. **Excludes snapshot trees by policy** ([§9](#9-snapshots-a-separate-surface)).

`deriveRunState` skips all non-fact events (`reducers.ts:294`), so dropping
observability from the bundle does not affect replay on import.

## 5. The `ci` profile vs the export profile

Same engine, two postures. The difference is the *destination's* trust floor.

| | `fragua runs export` (local) | `fragua ci` |
|---|---|---|
| Destination | chosen parties, deliberate share | CI artifact / PR comment, possibly public |
| Human in loop | yes (operator) | no (unattended) |
| Scrub error | warn-and-proceed (operator decides) | **fail-closed: no bundle** |
| Live-cred (`provider_creds`) hit | noisy stdout warning | **fails the job** |
| Entropy detector | off by default | off by default (preserves review value) |
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

`scrub(text, compiledRegistry)` — pure, no I/O, no store. Aho-Corasick over the
literal set (O(n) in text length, indifferent to registry size) + cached compiled
regexes for known formats. **Pass a compiled automaton, not the raw needle list**
(the egress pass scans many messages of one run against the same registry — build
once).

The registry is **assembled at the egress boundary from whatever is available**,
and the source is context-dependent:

- **`fragua ci`** — `process.env` (secret-named vars) captured at *seed time*
  (`env-creds.ts` already reads them at startup) + seeded `provider_credentials`.
  Single ephemeral process, env still live at export → env-value literal matching
  is feasible **and critical** (CI injects secrets as env vars). Capturing at
  seed time also sidesteps mid-run rotation.
- **`fragua runs export`** (persisted store) — `provider_credentials`
  (present-tense) + patterns only. The worktree is gone, so per-run env needles
  are unavailable.

**Patterns are the primary guarantee** in both cases (registry-independent, robust
to rotation). Literal cred-match is a best-effort bonus when the cred is still
present at export. Env-value needles only exist for `ci`.

**Default-deny on var *names*.** A CI runner's env is huge and mostly non-secret;
treating all of `process.env` as needles is catastrophic (`GITHUB_REPOSITORY`,
`GITHUB_SHA`, `NODE_ENV`, `PORT` would redact repo names, shas, and common words
everywhere). No `GITHUB_*` globs — `GITHUB_TOKEN` is secret, `GITHUB_REF` is not.
Use a precise name allowlist (`*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`,
`*_CREDENTIAL` + known provider var names) plus a length/entropy floor.

## 8. Disclosure: inline markers, no manifest in the bundle

Redactions do **not** travel in the tar. Disclosure rides the inline
`[REDACTED:source]` markers — self-locating (the reviewer sees the redaction
exactly where it happened) and grep-recomputable (a recipient can census the
markers themselves), so a separate `redactions` table in the bundle would be both
redundant *and* a side channel (handing the recipient a "this run touched N keys
of these types" map). It is dropped.

The manifest's real audience is the **exporter**, not the recipient: "what did I
just publish, and what did the scrubber catch?" — especially the
perimeter-failure signal of a `provider_creds` hit. So the redaction summary is
**output of the `export`/`ci` command** (stdout, e.g.
`redacted 5 hits — 4×pattern:github_token, 1×provider_creds ⚠`), and in `ci` a
`provider_creds` hit fails the job. No tar entry, no format change, no outbound
side channel.

`source` examples: `provider_creds | env:NAME | pattern:anthropic_key |
pattern:jwt | …`. Marker *granularity* is the real disclosure dial (see
[§11](#11-open-questions)).

## 9. Snapshots (a separate surface)

Snapshots are git trees, not rows — the scrubber does not apply; exclusion does.
**Untracked/gitignored files are already excluded today**: `snapshotter.ts:160`
seeds a sentinel index from the real index and runs `git add -A` *without*
`--force`, so a gitignored `.env` never enters the tree. The residual leak is
narrow:

- secrets that are **tracked/committed** (a versioned `.env` — rare), and
- secrets in files the project does **not** gitignore (no `.gitignore`, an
  uncovered `credentials.json`).

So the deny-list is a **backstop**, not the primary defense: builtin
(`.env*`, `*.pem`, `id_*`, `credentials.json`, `.aws/`, `.ssh/`, `.netrc`,
`*.kdbx`) layered *additively* over the already-`.gitignore`-honoring base, plus
an optional `.fraguasnapshotignore`.

Note the snapshot is also the only control for everything git-tree-derived: the
**diff view** (`gitDiff`) renders snapshot tree contents, and `applyAccept`
materializes the tree back into the operator's cwd. A *tracked* secret shows in
the diff and lands on accept — the scrubber can't touch either; only snapshot-time
exclusion can.

## 10. Patterns

Base set (registry-independent): `sk-ant-`, `ghp_/gho_/ghs_`, `sk-proj-/sk-`,
`AKIA[0-9A-Z]{16}`, `xox[bp]-`, JWT `eyJ…\.eyJ…\..*`, PEM
`-----BEGIN .* PRIVATE KEY-----`.

Two high-value, registry-independent additions are **candidates** (low FP risk,
catch the secret no registry has — deferred decision):

- connection strings with embedded creds: `://user:pass@host` (postgres, redis,
  mongo, amqp) — endemic in `errorMessage` / stack traces;
- URL query tokens: `[?&](token|api_key|access_token|sig|signature|key)=…`.

## 11. Manifest metadata: `cwd` and `title`

Neither is stripped — stripping forces `deriveRunState` and the UI to tolerate
absent fields (a new correctness surface) and gains little:

- **`title`** is a text field (the titling fact) → it rides the existing egress
  text scrub. A credential in the title is caught; the field stays present (a
  string), so derive is unaffected. The residual *semantic* paraphrase risk is the
  same irreducible thinking-block problem, on a short, prompt-controlled surface.
- **`cwd`** is kept (optionally basename-normalized at egress). The risk
  *anti-correlates with exposure*: in the high-exposure case (`ci` / public) the
  `cwd` is the boring GHA runner path; in the high-sensitivity case (a local dev
  path with username/codename) the bundle is a deliberate, low-exposure share.

Both `cwd` and `title` live in the **event log** (genesis `routing.cwd`; the
titling fact), not only `manifest.json`, and import re-derives state from the log
— so scrubbing the manifest copy alone would not be enough. Scrub-in-place of the
titling fact covers the title in both places; `cwd` is left intact (or
basename-normalized) in both.

## 12. Assurance: an end-to-end PBT

"Secret-free by construction" is only falsifiable with a property test: **seed
secrets** (synthetic provider keys + values matching each pattern) → flow them
into messages/facts/artifacts/manifest → **export** → assert the tar contains
**none** of the seeded values, **verbatim or in common encodings** (base64,
url-encode), across all surfaces. Because the scrubber lives at egress (outside
store-append), this test runs in isolation without touching store invariants.

## 13. Open questions

- **Marker granularity.** `[REDACTED:pattern:aws_key]` aids the reviewer but lets
  any recipient census secret *types* by grep; `[REDACTED]` blocks the census but
  costs review context. Lean: keep `source`; consider a
  `--redaction-labels=source|generic` flag.
- **Entropy default.** Egress makes a false positive *recoverable* (re-export from
  the still-raw local store), which lowers the stakes of aggressive detection —
  but entropy degrades the bundle's review value, so it stays off by default.
  Revisit whether any context wants it on.
- **`cwd` normalization.** Keep full path, or basename-normalize at egress?
- **Tar reproducibility.** Should two exports of the same run (same registry)
  produce byte-identical bundles (→ content-address / dedup bundles)? Requires
  pinned registry + detectors and timestamps outside the canonical content.

## 14. MVP order

1. **Egress filter in `exportRunBundle`** — drop content-bearing observability,
   keep `cost.recorded`. Closes the active leak (deltas export verbatim today) and
   dissolves the streaming problem. Trivial.
2. **Snapshot deny-list** — additive over the already-gitignore-honoring base
   (backstop for the no-`.gitignore` / tracked-secret case).
3. **Registry + literal scrub** over messages / artifacts / fact-text / routing
   (Aho-Corasick, compiled), per-context registry.
4. **Known patterns** (§10 base set).
5. **`ci` profile** — fail-closed, env-seed registry, job-fails on
   `provider_creds`, perimeter env-strip on the bash subprocess.
6. **PBT** end-to-end (§12) — the gate for the "secret-free" claim.
7. Allowlist + name-list config (`~/.fragua/scrubber.yaml`), shared by the
   perimeter env-strip and the scrub registry.

V2: connection-string / URL-token patterns (§10 candidates), high-entropy behind
a flag, `ctx.artifacts.putRaw()` opt-out.
