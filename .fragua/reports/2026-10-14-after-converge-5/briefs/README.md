# Critical path: next briefs

| NN | Title | Estimate |
|----|-------|----------|
| 01 | Close the untrusted-input boundaries (shell tokens, MCP, enqueue routing, origin gate) | 4 days |
| 02 | Serialise store fences: sweep, eviction and import inside the write lock; sweep activeMs matches the reducer | 3 days |
| 03 | Detect daemon lock loss and contain fiber failures | 2 days |
| 04 | Fence recorder commits by dispatch identity; make OCC halt escalation land | 3 days |
| 05 | Make declared knobs act and reconcile doc drift | 6 days |

## Dispatch

1. `bun run fragua run converge --input brief=@.fragua/briefs/next/01-untrusted-input-boundaries.txt`
2. `bun run fragua run converge --input brief=@.fragua/briefs/next/02-store-fences.txt`
3. `bun run fragua run converge --input brief=@.fragua/briefs/next/03-lock-loss-fiber-containment.txt`
4. `bun run fragua run converge --input brief=@.fragua/briefs/next/04-dispatch-fence-occ-halt.txt`
5. `bun run fragua run converge --input brief=@.fragua/briefs/next/05-declared-knobs-doc-drift.txt`

## Ordering rationale

- 01: no prerequisites; its files don't overlap the store→daemon chain. Adds the validator code and SECURITY.md rows that step 5's doc pass reconciles.
- 02: steps 3–4 need the store's own fences serialised and the projection equal to the fold, so their tests can tell new bugs from existing drift.
- 03: the dispatch-identity fence in step 4 only holds if a daemon that lost its lock stops minting dispatches; this step provides the lock-loss signal.
- 04: finalises zombie and OCC semantics that step 5 builds on.
- 05: last, because the doc-drift pass must describe the final behaviour of steps 1–4, and its max_loops and fan-out abort changes edit the same code step 4 settles.
