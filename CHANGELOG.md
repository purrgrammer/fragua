# Changelog

All notable changes to fragua are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[SemVer](https://semver.org/). Pre-1.0: minor versions may carry breaking
changes, and anything marked **experimental** can change shape without a compat
guarantee.

## [Unreleased]

### Fixed

- **Imported-run fidelity — export filter**: the bundle export filter now uses a
  named denylist (streaming deltas and scaffolding events) instead of a coarse
  allowlist. `llm.start` (slimmed — `prompt` stripped), `llm.done`,
  `edge.selected`, `run.title_generated`, and Tier-3 structural events
  (`llm.error`, `budget.warn`, `budget.stop`, `steering.*`, `control.*`) are
  retained, so imported runs display per-step cost, LLM-step labels, the
  traversal-edge overlay, and the run title correctly.
- **Imported-run fidelity — UI operate controls**: `RunControls` now accepts an
  `imported` prop; when true (derived from `RunDetail.imported`, set when
  `cwd == null`) the pause/resume/cancel buttons are replaced with a read-only
  "imported (inert)" badge, preventing dead-end operate actions on runs the
  daemon will never dispatch.

## [0.4.0] — 2026-06-02

### Added

- **`fragua ci --allow-env <name>`** — exempt a secret-named env var from the CI
  perimeter env-strip so a workflow's deterministic `tool` steps can use it (e.g.
  `GH_TOKEN` for `gh pr diff/comment`). Exempts the STRIP only: the value is still
  captured as a scrub needle, so it stays redacted from the exported bundle
  (allow ≠ declassify). Provider credentials (`ANTHROPIC_API_KEY`, `*_API_KEY`, …)
  are refused — they must never reach a tool subprocess. Repeat or comma-separate
  to allow several. Lets the `pr-review` / `crowdin-review` GitHub Actions
  authenticate `gh` without the disk-login workaround.
- **`fragua runs explain <id>`** — new read-plane verb that synthesises a run's
  event log into a narrative: path taken (nodes + edges), per-step outcome and
  cost, snapshots captured, diff-vs-base summary (files / insertions /
  deletions), terminal status + halt/pause reason, and active soft budget
  warnings. `--json` emits the structured `RunExplanation` projection.
- **`--json` on `fragua runs ls`, `status`, and `inbox`** — human output
  stays the default; `--json` prints the structured read-plane projection.
  `status --json` also includes a `budgetWarns` field.
- **`fragua runs worktree <id>`** — prints the absolute worktree path for a
  run (`.fragua/worktrees/<runId>/` under the run's cwd). Exits non-zero with
  a clear message when the worktree has been cleaned up.
- **Soft budget warning surfacing in `status` and `tail`** — the existing
  `budget.warn` event (80% of a budget ceiling) is now shown in
  `fragua runs status <id>` under a yellow `warn:` line, and prefixed with
  `⚠` in `fragua runs tail`. Warnings suppressed by a later `budget.stop`
  for the same (scope, metric) do not appear.
- **Tool-step timeout default surfaced in `fragua validate`** — any `tool`
  step without an explicit `timeout-minutes:` now gets an info-level diagnostic
  naming the step and the 5-minute default. Documented in `docs/cli.md` and
  the workflows skill.

## [0.3.1] — 2026-05-28

### Added

- **`CLAUDE.md` fallback for the project primer.** `loadContextFiles` falls
  back to `CLAUDE.md` when the auto-prepended `AGENTS.md` is missing and
  `CLAUDE.md` isn't already in the path list. Project-level only; no global
  `~/.claude/CLAUDE.md` probe.

### Fixed

- **Goal-gate retarget no longer steals non-gate fail terminals.** When a
  `goal_gate` node had failed and its outcome was in routing state, a
  downstream non-gate node terminating via `outcome=fail` (abort,
  retry-exhausted, any unrecovered failure) was being retargeted to the
  gate's `retry_target` instead of halting. Also silently overrode an
  explicit `on: {fail: exit}` route. The §3.4 terminal-arrival check now
  skips when the completed node is non-gate and its outcome is `fail`.

### Removed

- **`fallback_retry_target` (node attr) and graph-level `retry_target` /
  `fallback_retry_target` attrs.** Accepted by the validator but ignored at
  runtime. Goal-gate retarget is single-step — the failing gate's own
  `retry_target`. A workflow that previously declared one of these attrs
  now warns W013 (unrecognised attribute).

## [0.3.0] — 2026-05-28

This release makes the `.fragua` bundle **secret-free by scrubbing**, not just by
omitting the credential tables — so a bundle (and a `fragua ci` artifact) can be
shared. It also removes the legacy free-form `routing.input` and lets typed run
inputs exceed the event-payload cap by spilling to the blob store.

### Added

- **Egress-time secret scrubbing for bundles (experimental).** `exportRunBundle`
  now redacts at the egress boundary — the local store stays raw; only the bundle
  is transformed. A pure, deterministic Aho-Corasick registry (provider-credential
  values + the run `cwd` + base credential patterns, literals encoding-expanded to
  base64/base64url/percent) scrubs the message transcript, event-payload free-text,
  the genesis routing, and text artifact blobs (re-CAS'd). Proven by a 9000-assertion
  end-to-end property test. The bundle stamps a `scrubberVersion`.
- **`fragua ci` adversarial scrub profile.** For the least-trusted destination:
  registry seeded with secret-named env vars captured at start, **generic
  `[REDACTED]` markers** (no type-census), and **fail-closed** with a dedicated
  exit code **80** when a live secret value sits verbatim in an un-scrubbed
  **binary** artifact (the one residual the scrubber can't redact). Plus a
  **perimeter env-strip** on the bash/git subprocesses so a tool can't dump CI
  secrets into the run record in the first place.
- **Oversized run inputs spill to the blob CAS.** Typed `routing.inputs` values
  that would blow the 4 KiB genesis-event cap spill to the content-addressed blob
  store with a `{ $fragua_blob: sha }` reference, resolved on read — input size is
  now unbounded, and spilled-input secrets are scrubbed by the same path.

### Changed

- **Schema v1 → v2** (walk-forward migration): `schedules.input` → `schedules.title`.
  Existing stores migrate in place on next harness start.
- **Bundle format `bundleVersion` 1 → 2** (still experimental): adds `scrubberVersion`;
  bundles now carry scrubbed content rather than only omitting credential tables.
- `fragua ci --db <path>` is documented as a **raw local-inspection** artifact
  (credential *table* dropped, but transcript NOT scrubbed) — use `--export` for
  the scrubbed, publishable bundle.

### Removed

- **The free-form positional `routing.input`.** Run inputs are now exclusively the
  typed `routing.inputs` map (`${{ inputs.x }}`). The auto-title seeds from the
  workflow name + typed inputs; schedules' description becomes the fired run's
  title. Removed across types / server / web / read-plane.

## [0.2.0] — 2026-05-27

This release marks the start of running fragua **on CI** and pulling the run
back down as a portable `.fragua` bundle for local inspection and aggregation.

### Added

- **Portable `.fragua` bundles (experimental).** A bundle is a first-class
  container: one or more runs (as their raw event logs), the workflows they
  reference, and the content-addressed blobs they produced. A run's truth is its
  event log — `run_state` is a projection and is **not** bundled; it is
  re-derived by replaying events on import. Three verbs:
  - `fragua ci --export <file.fragua>` — write a bundle for the run just executed.
  - `fragua show <file.fragua>` — validate + summarize a bundle, no store needed.
  - `fragua import <file.fragua>` — merge a bundle into a store, deriving
    `run_state`. Imported runs are inert by construction (won't be dispatched).

  Bundles are secret-free by construction (they never carry
  `provider_credentials` / `provider_config`). The format is **experimental** and
  release-gated: `bundleVersion` bumps freely with no migration path while
  unstable — treat a bundle as a throwaway inspection artifact, not durable
  storage.
- **Genesis identity in the event log.** `intent.run_enqueued` now carries the
  whole run identity (project, workflow link, routing seed, contract version), so
  a complete `run_state` is derivable by replaying a run's events — the keystone
  that makes derive-on-import possible.
- **Unattended PR review on GitHub.** The `pr_review` workflow + `pr-review.yml`
  run a multi-step review (`scope → review → verify → verdict → post`) over a
  PR's diff with `fragua ci`, posting the result back as a `comment` or
  `request-changes` review. The verdict is a routing LLM node that classifies
  `comment` / `changes`. Read-only over the untrusted diff; fork PRs are skipped;
  no auto-merge (a `GITHUB_TOKEN` bot cannot post an APPROVED state, and CI
  remains the hard required gate). The job self-tests `fragua ci --export` and
  uploads the resulting bundle, failing closed if a provider key appears in the
  bytes.

### Changed

- `fragua ci` prunes its `--db` artifact to the portable tables only (no
  credentials), so the embedded-executor store is shareable.
- `non_retryable` is now a retry-policy hint rather than a goal-gate gate
  ([core, agent]).

### Fixed

- Nightly property-test suite: raised the per-test timeout to fit PBT scaling and
  deflaked timer-fragile tests (#4).

[0.4.0]: https://github.com/purrgrammer/fragua/compare/v0.3.1...v0.4.0
[0.2.0]: https://github.com/purrgrammer/fragua/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/purrgrammer/fragua/releases/tag/v0.1.0
