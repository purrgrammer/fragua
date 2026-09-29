# Next critical-path briefs

| NN | Title | Estimate |
|----|-------|----------|
| 01 | Close the API's front door: CSRF + content-type gate | 2-3 days |
| 02 | Stop the executor stranding runs on swallowed OCC fast-paths | 2 days |
| 03 | Restore store invariant + replay integrity | 2 days |
| 04 | Fix read/routing correctness: read-plane FS I/O, shared-thread scan, input injection wrap | 3 days |
| 05 | Harden discipline lints and reconcile docs | 3 days |

## Dispatch

```sh
bun run fragua run converge --input brief=@.fragua/briefs/next/01-csrf-content-type-gate.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/02-occ-fast-path-fix.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/03-store-invariant-replay-integrity.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/04-read-routing-correctness.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/05-harden-lints-reconcile-docs.txt
```
