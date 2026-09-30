# Critical path — next briefs

| NN | Title | Estimate |
|----|-------|----------|
| 01 | Convert discipline lints to import-graph/AST and close their coverage sets | 1.5 days (1 engineer) |
| 02 | Relocate sweep.ts crash-recovery DML into *-queries.ts and share the orphan-detection query | 1 day (1 engineer) |
| 03 | Remove fact-writing mutations from GET /health | 0.5 day (1 engineer) |
| 04 | Reorder POST /runs (by-name) to commit the workflow row only after enqueue validation | 0.5 day (1 engineer) |
| 05 | Route the read tool through a bytes-returning ExecutionEnvironment read | 1 day (1 engineer) |

## Dispatch

```sh
bun run fragua run converge --input brief=@.fragua/briefs/next/01-discipline-lints-import-graph.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/02-sweep-dml-queries.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/03-health-no-mutations.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/04-post-runs-workflow-commit-order.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/05-read-tool-env-seam.txt
```
