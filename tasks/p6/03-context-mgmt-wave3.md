# P6.03 — Context-management hardening: Wave 3 (close test-coverage gaps)

## Goal

Wave 1–2b landed the features; Wave 3 closes the coverage gaps the
pre-wave audit flagged. No production code changes — purely new
integration + property-based tests that lock in the contracts so future
refactors can't silently regress them. Test count: 689 → 715 (+26).

## Scope

Files created:

- `packages/agent/test/thread-id-session-reuse.test.ts` *(3 cases)* —
  full fidelity + same thread_id restores the prior transcript via
  `MessageStore`; distinct thread_ids stay isolated (both land in the
  store under their own keys); non-`full` modes neither hydrate nor
  persist even when thread_id is shared.
- `packages/agent/test/context-files-end-to-end.test.ts` *(4 cases)* —
  file contents land byte-for-byte in `llm.start.system_prompt`;
  multiple files concat in author order; missing files surface as
  `status: "missing"` + `agent.warning` without aborting the run;
  oversized contents trip the 32-KiB truncation and flag every loaded
  file (pre-truncation byte count preserved).
- `packages/core/test/executor/retry-context.test.ts` *(3 cases)* —
  `internal.retry_count.<nodeId>` is resolvable via `${context.…}` on
  every retry (initial attempt, retry 1, retry 2); `context_updates`
  from a failed attempt are discarded so the retry sees the
  pre-failure context; `substitute()` regression guard on the
  canonical key name.
- `packages/core/test/executor/goal-gate-abort.test.ts` *(2 cases)* —
  `non_retryable: true` on a goal-gate node's failure bypasses
  `retry_target` entirely (original reason preserved, no
  `node.retrying` emitted); contrast with a retryable failure that
  does drive retries through the same gate.
- `packages/core/test/executor/parallel-isolation.test.ts` *(3 cases)* —
  one branch's `context_updates` are invisible to its sibling while
  both are running; `parallel.count` / `parallel.successes` /
  `parallel.branch_results` populate post-join; a branch mutation that
  nobody merges back doesn't shadow the pre-fork context value on the
  pipeline side.
- `packages/agent/test/steering-targeting.test.ts` *(2 cases)* —
  malformed-JSON and missing-`message` lines in `steering.jsonl` are
  silently skipped; three pre-seeded lines each fire their own
  `steering.injected` event in order. (An in-run append-during-turn
  test was attempted but dropped — the faux provider resolves each
  turn instantly, so the race can't be forced deterministically; the
  pre-seed shape already proves the poller reads the file in slices.)
- `packages/core/test/engine/substitution.property.test.ts` *(5 cases,
  ~1 450 fast-check runs)* — `substitute()` never throws on arbitrary
  input, even with adversarial context key/value alphabets; unresolved
  `${context.…}` and `$node.output` always collapse to empty string
  (never leave the raw token behind); shell-escape mode always wraps
  values in single quotes.
- `packages/core/test/engine/fidelity-resume.test.ts` *(4 cases)* —
  `degradeOnResume` is exported from the package root; every non-`full`
  mode is a fixed point; `full → summary:high` exactly; applying twice
  is idempotent. An end-to-end "resume a checkpointed run" test is
  *deferred* — the resume path isn't wired end-to-end yet (no
  checkpoint loader calls `degradeOnResume`), so the integration test
  lands with Wave 4+ when that plumbing exists. This suite locks down
  the building block.

## Not in scope

- Any production-code change. Wave 3 is strictly test-only.
- Resume-path integration test (see `fidelity-resume.test.ts` note).
- Streaming summariser tests — Wave 2b landed without streaming; when
  we add it we'll need parsing-in-flight tests, but they have nothing
  to attach to yet.

## Verification

- `bun run ci` → 715 pass, 0 fail. Pre-Wave-3 baseline was 689.
- `bun run packages/cli/bin/swarm.ts validate workflows/*.dot examples/*.dot`
  — unchanged, no regressions.
