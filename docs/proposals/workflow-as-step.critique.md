# Arbitration — `workflow-as-step.md`

Verdicts: adversarial=revise, clarity=revise, precedent=revise, feasibility=approve, scope=approve.

## Rulings

- **Adversarial #1 (max_loops inert for parking loops) overrides feasibility+scope approves.**
  Code-verified at `executor.ts:807-825`: `dispatches` is a JS-local counter reset to 0 on every
  `runOne` entry (the comment says so). A `converge.yaml` round parks (`fanout_pending`, then
  `paused_human`) and resumes across multiple `runOne` boundaries, so the counter never accumulates
  and `run_paused{max_loops}` never fires — the proposal's *only* named loop bound is inert for its
  sole motivating deliverable. Feasibility/scope approved without reaching the enforcement path; a
  verified correctness hole is not immunized by an approve that never checked it. BLOCKING.

- **Precedent #1 (SPEC §3.8 producer-kind) overrides feasibility's "every invariant conflict is
  disclosed."** The proposal makes `type: workflow` a new `${{ outputs.* }}` producer, contradicting
  §3.8 / ground-rule-13's "`outputs:` is llm-only … tool and human steps consume outputs but do not
  produce them." It cite-and-overrides §5 and §3.4 but silently skips §3.8. Its own established pattern
  demands the same treatment. BLOCKING.

- **Clarity #1 (S1 undefined) → Deferred.** The substantive question (where `fact.node_completed`
  fabrication lives) is resolved unambiguously by the "No edge selection in `wake-pending` (S1)"
  section ("the driver's single, existing edge-selection site … one edge-selection caller,
  unchanged"); feasibility and scope both read S1 correctly. Editorial, not a build-fork.

- **Clarity #4 ("before/as" atomicity) → Deferred as blocking.** The doc already establishes the
  two commits sit on separate OCC lanes and that `wakeOrphanedChildren` is the backstop for the crash
  window between them (Abort/halt cascade + "A child that outlives its cascade…"), so atomicity is
  explicitly not required. Tighten "before/as" to "before" as copy-edit.

## Blocking

1. **The loop bound does not fire — `converge.yaml` is engine-unbounded** (adversarial).
   `max_loops` reads a `runOne`-local `dispatches` counter (`executor.ts:811-825`) that resets to 0 on
   every entry; a loop that parks each round never accumulates it, and `DEFAULT_MAX_LOOPS=1000` is
   defeated identically. **Demand:** bound a parking-`type: workflow` loop from a fold-derived, durable
   run-scoped counter (e.g. `metrics.loopCounts`, `reducers.ts:119`) or a persistent dispatch counter
   in `routing` that the `max_loops` check consults — not the JS-local `dispatches`. Prove
   `converge.yaml` with `max_loops: 12` halts after 12 rounds and that a no-human auto-routed variant
   cannot loop forever.

2. **Parent cancel force-terminates a `quarantined` child, silently defeating I5** (adversarial).
   The abort cascade and `wakeOrphanedChildren` both count `quarantined` as a "live child" and
   force-abort it — burying an orphaned external side effect (INTENT, no matching DONE) that I5
   requires an operator to adjudicate, and contradicting `wakeFanoutJoin`'s own choice to leave a
   quarantined child parked for operator decision. **Demand:** exclude `quarantined` children from the
   force-abort set of both the in-line cascade and `wakeOrphanedChildren` (leave them quarantined and
   surface them), or specify exactly how the orphan side effect is resolved/recorded when a parent
   cancel collaterally terminates the child.

3. **Cite-and-override SPEC §3.8 for the new producer kind** (precedent).
   **Demand:** quote both §3.8 sentences (token-table "emitted by an upstream `llm` node that declared
   `outputs:`" and "`outputs:` is llm-only … tool and human steps consume outputs but do not produce
   them"); declare the override (a `type: workflow` step produces outputs by inheriting the child's
   run-level `outputs:` block, writing into `fact.node_completed.payload.outputs` / the `outputs` index
   identically to an `llm` step); list §3.8 as a ship-time doc edit naming `type: workflow` as the
   second producer kind and stating E035/W015/W016 govern llm-step producers while E051 governs
   `type: workflow`-step producers.

4. **Name the adoption and discard fact types the GC guard keys on** (clarity).
   Spine item 3 calls adoption "a durable marker on the parent's terminal fact"; Adoption-ordering
   calls it "the parent's durable adoption fact" — leaving open whether it is a payload field on
   `fact.run_terminated` or a separate fact. **Demand:** state whether adoption is a named payload
   field on `fact.run_terminated` (name it) or a new fact emitted after it, and whether discard reuses
   an existing discard fact or mints a new one. The GC-guard predicate, its query, and the release
   logic differ between these readings.

5. **Specify `fact.node_completed`'s payload for a `type: workflow` step** (clarity).
   The Event-log "Join" entry lists `payload.outputs` but not `childRunId`, while `base: tip`
   resolution reads "the most recent `fact.node_completed` … whose `childRunId` is populated."
   **Demand:** state explicitly that `fact.node_completed` for a `type: workflow` step carries
   `childRunId` (and `outcome`) as payload fields and add it to the Event-log join description — so the
   `base: tip` resolver works from the completed-node fold rather than an unspecified two-fact join.

## Deferred

- Clarity #1 (introduce `S1` at first use) — editorial; substance already fixed by "No edge selection
  in `wake-pending`". Do the one-sentence fix, not blocking.
- Clarity #4 (replace "before/as" with "before") — editorial; separate-OCC-lanes + `wakeOrphanedChildren`
  backstop already make atomicity unnecessary. Add the one clarifying sentence.
- `wakeFanoutJoin` candidate-selection query is uncosted (adversarial note): `run_state` has no
  `pause_reason` column, so "scans `paused_auto{fanout_pending}`" isn't the literal query — name the
  actual selection (parents via the `parent_run_id` child index, then each park fact's `childRunId`).
  Buildable, non-blocking.
- Sweep ordering of `wakeFanoutJoin` / `wakeOrphanedChildren` vs `wakeCancel` unspecified (adversarial
  note) — pin it; current ordering is load-bearing.
- `workflow:` / `base:` never pinned as non-substituted literals (adversarial note) — state they are
  literals so a hostile `${{ … }}` can't bypass E048's save-time catalog check.
- `base: tip` provisioning depends on the unbuilt `--base <ref>` seam (feasibility note) — fold the
  worktree-provisioner wiring into the spine list or name it a blocking prerequisite.
- Editorial (clarity/precedent notes): excise "earlier draft" correction narrative; state the
  supplied-id-vs-index choice unconditionally; one line that `buildEnqueueChild`/`commitEnqueueChild`
  follow the intent-plane build/commit split; reconcile "read-class" vs SPEC §3.1.1 "deliberation-only";
  fix the dangling "item 7" reference and the stale fan-out-runs.md quote; add SPEC §3.1 node-type
  table to the ship checklist.
