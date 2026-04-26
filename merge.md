# merge — outstanding hardening work

Context: post-mortem of run `01kq56ec3k305h0grr` (4 sibling worktrees racing
on main; this branch lost 3 CAS rounds in a row and aborted with
`merge_race`). Two cheap fixes have already landed in
`workflows/quick-change.dot` and `workflows/build-feature.dot`:

- bumped outer attempts from 3 → 7
- skip CI on attempts where step 3 (conflict resolution) didn't run AND
  main's new commits don't touch any file the branch touches

The items below are the deferred work — bigger surface, longer to land,
not blocked by the cheap fixes above.

---

## 1. Structured telemetry for merge contention

**Problem.** Today, the only way to know a run lost the CAS race (and to
whom) is to read the merge node's full LLM tool transcript. That's 38
messages for the run we just analysed. There is no machine-readable signal
that says "this run lost N rounds; main moved from X→Y→Z during my
attempts."

**Proposal.** Emit one fact event per CAS rejection from inside the merge
handler:

```
fact.merge_cas_failed {
  attempt: number,           // 1-based
  expected_main: sha,        // what we tried to CAS from
  actual_main: sha,          // what main was when CAS failed
  ci_skipped: boolean,       // did we skip step 4 on this attempt?
  duration_ms: number        // wall time for this attempt
}
```

And on success:

```
fact.merge_landed {
  attempts: number,          // total rounds it took
  conflicts_resolved: number,
  ci_runs: number,           // ≤ attempts
  final_main: sha
}
```

**Why this matters.**

- Dashboards can show "this run lost 3 rounds to runs A, B, C" without
  any LLM-mediated post-mortem.
- We can measure the actual win-rate of the cheap fixes (#1 + #2 above)
  in production rather than reasoning about it.
- If `merge_cas_failed` events start clustering (e.g. average attempts >3
  on a given workflow), that's a signal to escalate to #2 below.

**Where to wire it.** The merge handler is currently a plain LLM agent
that runs shell commands. The events are emitted by whatever the agent
does. Two options:

- (a) Have the agent emit structured markers like
  `MERGE_CAS_FAILED: attempt=2 expected=abc actual=def` that the executor
  parses into events. Cheap; works with the existing prompt-based merge.
- (b) Promote merge to a first-class node type (`merge.git-cas`) with a
  proper handler that emits these events directly. Cleaner but ties into
  #2 below.

**Estimate.** (a) is ~1 day; (b) is part of #2.

---

## 2. Daemon-serialized merge primitive

**Problem.** The current architecture has 4 LLM agents independently
running optimistic CAS against `refs/heads/main`. Even with the cheap
fixes, the race is still a race — under heavy parallelism (8+ runs
landing at once) we'll exhaust 7 attempts and abort.

The optimistic-CAS pattern is the right shape when contention is rare.
Once you have N>3 runs all reaching merge in the same window, **the
problem isn't the protocol — it's that there's no serialization point.**

**Proposal.** Make `merge` a daemon-side primitive:

- The agent's job ends at "I have a branch tip ready to land" — it emits
  a structured `intent.merge_requested { runId, branchRef, branchTip }`
  rather than running git itself.
- The daemon owns a single in-process mutex. It dequeues merge requests
  serially:
  1. `git rebase $branchTip onto refs/heads/main` (in a scratch worktree
     or via `git worktree add` + `git rebase`, which is fast and atomic).
  2. If conflicts: hand the conflict back to the agent for resolution
     (existing prompt — unchanged), then re-queue.
  3. If clean: optionally run CI (use the file-overlap heuristic from
     fix #1), then `git update-ref refs/heads/main HEAD <expected_old>`.
     Since this is serialized, CAS never fails — it's just a sanity check.
  4. Emit `fact.merge_landed`.

**Properties.**

- Race goes away entirely. N runs queue and land sequentially in O(N) CI
  runs total, not O(N²) attempts wasted on lost races.
- The agent's prompt simplifies dramatically — no more "loop with CAS"
  protocol, no more "max attempts" logic, no more main-checkout refresh
  dance (since the daemon can refresh the main worktree itself).
- Pure CPU/IO win when there's no contention: the daemon can fast-path
  single-request merges without any extra latency vs. today.

**Costs.**

- New node kind in the executor. Touches the handler-bridge (see
  `docs/handler-contract.md`). Non-trivial — probably 3–5 days.
- Need to think about HITL inside merge (e.g. ambiguous conflict
  resolution that an LLM can't auto-decide). Currently the merge agent
  can ask for help via `<abort>`; we'd need an equivalent yield path on
  the daemon side. Doable, but design work.
- Crash-safety: if the daemon dies mid-merge (between step 3's
  `update-ref` and `fact.merge_landed`), the run looks "stuck" but main
  has actually advanced. The orphan-side-effect quarantine pattern from
  ARCHITECTURE §1.1 covers this: register the merge as a side-effect with
  an idempotency key.

**When to do this.** When telemetry from #1 shows the cheap fixes aren't
enough — i.e. when median `attempts` on `fact.merge_landed` events
trends above 3, or when `merge_race` aborts start showing up regularly
on prod runs. Don't pre-build it.

---

## 3. Tangent: `build.dot`'s merge node is missing the CAS protocol entirely

While auditing the merge nodes, noticed that `workflows/build.dot:50` has
a much simpler merge prompt than the other two:

```
prompt = "Rebase this worktree's branch onto main and fast-forward main.
  Fresh thread.\n\nSkip … if: not inside a worktree, on main or
  detached, no commits ahead of main.\n\nOtherwise: `git rebase main`,
  resolve conflicts preferring main, run `bun run ci`, then
  `git update-ref refs/heads/main HEAD`. Emit `MERGED: <short-sha>`.
  Don't push."
```

Two problems with this:

- The `git update-ref refs/heads/main HEAD` is **not** CAS — there's no
  `<expected_old>` argument. If main advances during the rebase or CI,
  this silently overwrites those commits. Strict regression vs. the
  protocol in `quick-change.dot` / `build-feature.dot`.
- No explicit conflict-classification rules, no main-checkout refresh,
  no attempt loop. Behaviour under contention is undefined.

**Recommendation.** Replace `build.dot`'s merge prompt with the same one
used by `quick-change.dot` and `build-feature.dot`. They've been hardened
in tandem; `build.dot` has drifted. Better still: factor the shared
prompt into one place rather than maintaining 3 copies (none of the .dot
parser's current features support prompt include — would need
`graph.attrs` shared-prompts table or external file include).

**Estimate.** Copy-paste the hardened prompt: 5 minutes. Factor out as a
shared definition: ~half a day plus parser/spec changes.

---

## Sequencing

1. Land #1 (telemetry) first — it's small and gives us data to validate
   whether the cheap fixes are sufficient.
2. Land #3 (build.dot prompt sync) — purely a copy-paste, no risk.
3. Watch telemetry for ~2 weeks of typical workload.
4. Decide #2 (daemon-serialized merge) based on whether the cheap fixes
   plus 7-attempt budget are actually holding.
