# Changelog

All notable changes to fragua are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[SemVer](https://semver.org/). Pre-1.0: minor versions may carry breaking
changes, and anything marked **experimental** can change shape without a compat
guarantee.

## [0.3.1] — 2026-05-28

Bugfix release. One executor fix + the pinning tests that should have caught it
+ the drift on the same surface, subtracted + a small UX additive (CLAUDE.md
fallback) + the pre-existing web-test infra fix that was hiding under a wrapper
exit-code.

### Added

- **`CLAUDE.md` falls back when `AGENTS.md` is missing.** `loadContextFiles`
  auto-prepends `AGENTS.md` as the project primer on every llm step; many
  projects only have `CLAUDE.md` (no AGENTS.md, no symlink). The loader now
  tries `CLAUDE.md` when `AGENTS.md` ENOENTs and `CLAUDE.md` isn't already
  declared in the path list — first-found wins, no double-load, the original
  error is preserved in the warning when both are missing. Project-level only:
  no global `~/.claude/CLAUDE.md` probe (always-on context is the wrong shape
  for autonomous workflows; named opt-in surfaces like skills are what's safe
  to globalize). (e497fa9e)

### Fixed

- **Goal-gate retarget stole non-gate fails at terminal, causing silent retry
  loops.** Once a `goal_gate` node had failed and its outcome lived in routing
  state, any *downstream non-gate* node terminating via `outcome=fail` — an
  `abort` tool call, retry-exhausted, any unrecovered failure — was being
  intercepted by the §3.4 terminal-arrival check and retargeted to the gate's
  `retry_target` (often the failing node itself), looping until the
  operator-raised cap exhausted. Observed on run `01kspxc14ktygz3grtevey53kp`
  (audit description optimize): a propose-step called `abort` three times after
  a paused-gate cap raise; each abort dispatched another propose iteration
  under the still-unsatisfied gate. **~$1.15 burned before the operator paused
  the run manually.** Also silently overrode the documented `on: {fail: exit}`
  sanctioned-landing escape hatch under any unsatisfied gate. Fix in
  `transition-planner.ts`: skip the §3.4 check when the completed node is
  non-gate and its outcome is `fail` — the node's own terminal decision.
  (eea93348)

### Tests

- Pinning tests in `executor.goal-gate.test.ts` whose names quote the SPEC §3
  and workflows-skill lines they enforce: *"a node that fails with no fail
  route halts the run with `aborted_exit`"* and *"an explicit edge to the `exit`
  sink on failure is a sanctioned landing — the run *completes*"*, both
  asserted under a prior-failed-gate state. A grep from SKILL.md or SPEC.md
  now lands on the test that pins each claim.

### Removed

- **`fallback_retry_target` (node attr) and graph-level `retry_target` /
  `fallback_retry_target` attrs.** SPEC §3.7 + SKILL §182 + two source
  comments described a 4-step goal-gate retarget chain
  (`gate.retry_target → gate.fallback_retry_target → graph.retry_target →
  graph.fallback_retry_target`), but the runtime only walked step 1; the other
  three fields were accepted by the validator (E011) and silently ignored.
  Surfaced during the drift sweep for the bug above. Pre-1.0 subtraction: the
  unwired fields are removed from the schema, the validator's E011 + W007
  wording, the SPEC, the SKILL, and the policy/planner header comments. The
  goal-gate retarget is now single-step — the failing gate's own `retry_target`
  — and the docs say so. A workflow that previously declared an unwired field
  will now get W013 (unrecognised attribute).

### Test infrastructure

- **vitest `Request` patch for jsdom AbortSignals.** 18 RunDetail.test.tsx
  tests had been silently failing under `bun run test` (jsdom installs its
  own AbortController; undici's Request brand-checks `signal` and rejects
  jsdom's; react-router 7's navigation crashed on every `<Navigate>`).
  Setup file now wraps `globalThis.Request` to strip an offending signal
  rather than crash. Surfaced during the 0.3.1 release sweep — the earlier
  CI "exit 0" notifications were the wrapper bash's exit, not the underlying
  CI's. (2d8a61b1)

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

[0.2.0]: https://github.com/purrgrammer/fragua/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/purrgrammer/fragua/releases/tag/v0.1.0
