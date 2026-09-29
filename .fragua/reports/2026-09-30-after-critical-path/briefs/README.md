# Next critical-path briefs

| NN | Title | Estimate |
|----|-------|----------|
| 01 | Add read-discipline lint covering read-plane routing and sync-FS in projections; extend I1 lint to sweep.ts | 2-3 days |
| 02 | Route all server reads through the read plane; hoist FS I/O out of the projection; bound unbounded read/control paths | 3-4 days |
| 03 | Fix the outer crash-catch that can strand a run in 'running' | 2-3 days |
| 04 | Extract fan-out fact-selection into a pure planner and dedupe the OCC-conflict boilerplate | 4-5 days |
| 05 | Harden bash containment: deny-by-default env and honest documentation | 3-4 days |

## Dispatch

```sh
bun run fragua run converge --input brief=@.fragua/briefs/next/01-read-discipline-lint.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/02-route-reads-through-plane.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/03-fix-crash-catch-occ.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/04-fanout-planner-occ-dedup.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/05-bash-env-deny-by-default.txt
```
