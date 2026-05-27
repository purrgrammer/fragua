# Changelog

All notable changes to fragua are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[SemVer](https://semver.org/). Pre-1.0: minor versions may carry breaking
changes, and anything marked **experimental** can change shape without a compat
guarantee.

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
