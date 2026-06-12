# Changelog

All notable changes to fragua are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are
[SemVer](https://semver.org/). Pre-1.0: minor versions may carry breaking
changes, and anything marked **experimental** can change shape without a compat
guarantee.

## [Unreleased]

### Fixed

- A handler that honors a late-delivered abort is no longer falsely declared
  leaked. The leak grace is now measured from when the abort actually reached
  the handler, not as an absolute deadline from dispatch — previously, system
  sleep froze the abort timer and the leak sentinel together and flushed both
  in one wake tick, halting healthy runs with `handler_leaked` (and shutting
  the daemon down at the leak limit). Handlers that ignore their abort signal
  still leak on the same schedule.

## [0.7.0] — 2026-06-11

### Added

- **Parallel fan-out (`type: parallel`) — experimental.** A control node that
  runs a take-all set of branches concurrently within one run and joins them at a
  single barrier. Declare `branches: [a, b, …]` (≥2 distinct branch ENTRY steps)
  and a `next:` sink; each branch is a sub-pipeline — one step, or several
  distinct `type: llm` read-class steps routing among themselves to the join —
  and they run at once, the sink reading each branch terminal's typed output via
  `${{ outputs.<step>.f }}` (fail-closed). An optional `concurrency:` caps
  in-flight sub-nodes (a semaphore), and `timeout-minutes:` on the parallel node
  bounds each branch (a backstop so a runaway lens can't dam the join). Branches
  share the worktree read-only: they may not reach a write-class tool
  (`bash`/`write`/`edit`), nest another `parallel`, or declare their own
  `thread:`; the validator enforces this with `E036`–`E043`. Execution is an
  on-log reactive frontier — each branch commits the instant it settles and
  dispatches its successor without waiting on siblings (a slow branch never
  blocks a finished one), and every sub-node completion is a durable fact, so a
  crash or pause mid-fan-out resumes by re-dispatching only the unfinished
  sub-nodes and replay reproduces the run. Budget is re-checked at each sub-node
  completion; a branch that repeatedly fails or overruns the per-branch timeout
  pauses the run, naming it. See `docs/proposals/fan-out-nodes.md`.
- Custom model entries and per-model overrides in `provider_config` accept
  `thinkingLevelMap`, mapping pi thinking levels (`off`–`xhigh`) to
  provider-specific values (`null` marks a level unsupported). Anthropic-style
  compat options (`forceAdaptiveThinking`, cache-control flags) are accepted on
  `compat:` alongside the OpenAI-compatible ones.
- New built-in providers via pi-ai 0.79.1: Together AI, NVIDIA NIM, Ant Ling,
  zai-coding-cn, and the Xiaomi MiMo token-plan regions. Claude Opus 4.8 and
  Claude Fable 5 (adaptive thinking, `xhigh` effort) are available on the
  Anthropic and Amazon Bedrock providers.
- **Auto-paused schedules show their cause.** A schedule the dispatcher pauses
  over an unresolvable or invalid workflow now carries the recorded error on
  its row — `fragua schedule ls` prints it under the paused entry and the
  Schedules page shows it beneath the status pill — instead of an
  indistinguishable bare "paused".

### Changed

- The pi runtime dependencies are now `@earendil-works/pi-agent-core` and
  `@earendil-works/pi-ai` at 0.79.1. Per-provider default models follow
  upstream (the Anthropic default is now `claude-opus-4-8`), which changes
  what daemon autodetect picks when a workflow names a provider without a
  model.
- Node.js 22.19.0 is the minimum supported runtime (pi's `engines` floor).
- **Saving a workflow now validates it.** Uploading, `fragua run`, `fragua ci`,
  and scheduled dispatch all reject a workflow carrying error-severity validator
  diagnostics (E-codes) with the diagnostic list; warnings still pass. Workflows
  that relied on implicit completion (a step with no declared successor, E032)
  must declare `next: exit` (or `on:`/`routes:`) — including steps whose only
  declared edge is `on: {fail: …}`; the success side now needs an explicit
  route too. Only sha-addressed enqueues of
  an already-stored workflow bypass the gate — `fragua run` / `fragua ci` /
  scheduled dispatch re-mint from disk on every invocation, so an on-disk
  workflow with an E-code stops enqueuing until fixed (a schedule auto-pauses
  with a `fact.schedule_invalid_workflow` daemon event).
- **Goal-gate re-entries are distinct executions.** Lifecycle facts carry an
  optional `pass` (the cumulative retarget count) so two passes of the same step
  no longer collapse onto one entry in the run-detail node states; the graph and
  iteration history show each pass separately. Transcripts are pass-scoped too
  (schema v4 adds `messages.pass`): an unthreaded step re-entered by a gate now
  starts with a clean conversation instead of silently rehydrating its prior
  pass's transcript — unthreaded steps rehydrate only when resumed.

### Fixed

- **An operator pause can no longer be silently dropped.** When the pause fact
  lost a concurrent-write race, the executor exited while leaving the run
  `running` with the pause intent still queued (a stranded run until daemon
  restart); the pause now retries against fresh state like cancel does.
- **Aborted steps record per-bucket cost splits.** A pause/steer/timeout abort
  folded its partial spend into the run total but not the input/output/cache
  cost splits, so the analytics spend breakdown stopped summing to the total
  on runs with aborts.

### Removed

- `compat.reasoningEffortMap` on custom model definitions: pi-ai no longer
  reads it. Stored rows that still carry it keep validating; the field is
  inert. Use `thinkingLevelMap` on the model entry instead.

## [0.6.0] — 2026-06-08

### Added

- **Structured step outputs (`outputs:`) — experimental.** An `llm` step can
  declare typed `outputs:` over a small type grammar shared with `inputs:`
  (scalars, `choice`, records via `fields`, arrays via `items`; no recursion or
  `$ref`). The step emits them through a force-included `emit_output` tool, and
  any downstream step reads them with `${{ outputs.<producer>.<field> }}` in
  `prompt:` (llm), `run:` (tool), or `text:` (human). Reads **fail closed** — an
  unpopulated reference fails the node rather than substituting `""`. Outputs are
  llm-only to produce (tool/human consume only) and mutually exclusive with
  `routes:`. Where the provider supports it (Anthropic, OpenAI) the emit schema
  carries native strict-mode enforcement automatically. Oversized structs spill
  to the blob store. Record and array reads render as canonical (key-sorted)
  JSON, so a consumer sees identical bytes across runs regardless of the order
  the producer emitted fields. A step that ends its turn without calling
  `emit_output` gets one corrective re-prompt before the node fails, so a single
  skipped call no longer hard-fails the step. New validator codes `E033`/`E034`
  (type grammar), `E035` (broken reference), `W015` (producer may not run on
  every path), `W016` (a read reaches through an `optional:` field the producer
  may omit — fails closed; model it as a required field with a sentinel, or read
  the enclosing record/array whole). Bumps the workflow `ir_version` to 2
  (additive; older workflows up-convert on load).

### Fixed

- **`fragua explain` reports accurate snapshot and token totals.** The explain
  view no longer miscounts per-step token usage or attaches the wrong snapshot
  to a step — totals now reconcile with the underlying event log.
- **`fragua run`/`runs tail` unfreezes when a HITL prompt is answered out of
  band.** The follow stream races the interactive picker against store
  resolution, so an answer submitted elsewhere (the Web UI, another client)
  resolves the pending input and the tail resumes instead of hanging on the
  local prompt.

## [0.5.0] — 2026-06-04

### Added

- **Reversible schema migrations** — each schema-migration step now carries an
  optional `down` inverse, and `fragua db migrate` takes `--to <version>` to
  walk the schema *down* as well as up. A downgrade backs up the store first
  (`<store dir>/backups/pre-migrate-*.db`; opt out with `--no-backup`), refuses
  to cross a step that declares no `down` or that would lose data (override with
  `--allow-data-loss`), and refuses to run while a daemon is live against the
  store. `--dry-run` prints the ordered plan with each step's reversibility
  class. The automatic open path is unchanged — a store newer than the binary
  still refuses to open, and nothing downgrades by surprise.

### Changed

- **Imported runs show an `imported` badge** in the run list and run detail header, consistent with the status and step badges. The previous "imported (inert)" parenthetical copy is removed. All pause/halt banners for imported runs render in strictly-informational mode: reason text is shown but every action affordance (Resume, Cancel, Raise budget, Retry, etc.) is suppressed.
- **Cancel-run confirmation is now a modal dialog.** Cancelling a run from the
  run detail view opens a confirmation dialog (reason optional, entered inline)
  that stays open until the operator acts, replacing the previous two-step
  button that auto-reverted after a 3-second window. The same dialog backs the
  Cancel action in the paused-run notice.

### Fixed

- **Imported runs no longer appear in the Inbox.** Both the NEEDS INPUT (paused/HITL/quarantined) and READY TO LAND (inbox_status=pending) sections exclude imported runs at the query source via `excludeImported: true` on `GET /runs`, so inspect-only runs are never surfaced as operator worklist items.
- **Anthropic 429 rate-limit resilience** — provider 429s are now absorbed by
  the Anthropic SDK's header-aware retry (`retry-after` / `retry-after-ms` /
  `anthropic-ratelimit-*`), with `maxRetries` raised to 8, instead of exhausting
  fragua's blind engine-retry (which ignores rate-limit headers on pre-stream
  rejections) and pausing/failing `fragua ci` jobs in CI.
- **`fragua db <action>` now defaults to the home store** — `vacuum`,
  `gc-blobs`, `backup`, and `migrate` resolve `~/.fragua/fragua.db` (honoring
  `$FRAGUA_HOME`) when `--db` is omitted, the same store the harness binds and
  the `run`/`runs` verbs open. They previously resolved `<cwd>/.fragua/fragua.db`,
  so a bare `fragua db migrate` from a project checkout reported "no store".
  Pass `--db <store>` to point at an alternate store (e.g. an ephemeral test
  store); `--cwd` only sets the backup-destination root. The resolved store path
  is echoed in each action's output.
- **Imported-run fidelity — export filter**: the bundle export filter now uses a
  named denylist (streaming deltas and scaffolding events) instead of a coarse
  allowlist. `llm.start` (slimmed — `prompt` stripped), `llm.done`,
  `edge.selected`, `run.title_generated`, and Tier-3 structural events
  (`llm.error`, `budget.warn`, `budget.stop`, `steering.*`, `control.*`) are
  retained, so imported runs display per-step cost, LLM-step labels, the
  traversal-edge overlay, and the run title correctly.
- **Imported-run fidelity — UI operate controls**: `RunControls` now accepts an
  `imported` prop; when true (derived from `RunDetail.imported`, set from the
  `imported_runs` inert marker) the pause/resume/cancel buttons are suppressed in
  favor of strictly-informational status, preventing dead-end operate actions on
  runs the daemon will never dispatch.

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

[0.5.0]: https://github.com/purrgrammer/fragua/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/purrgrammer/fragua/compare/v0.3.1...v0.4.0
[0.2.0]: https://github.com/purrgrammer/fragua/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/purrgrammer/fragua/releases/tag/v0.1.0
