# Next critical-path briefs

| NN | Title | Estimate |
|----|-------|----------|
| 01 | Harden the executor and supervisor loop heads | 0.5 day |
| 02 | Restore fold/projection equality for sweep and title | 1 day |
| 03 | Centralize fan-out fact construction into the planners | 1–1.5 days |
| 04 | Close the injection and input-validation holes | 1 day |
| 05 | Widen discipline lints and clear doc drift | 1.5 days |

## Dispatch

```sh
bun run fragua run converge --input brief=@.fragua/briefs/next/01-harden-executor-supervisor-loop-heads.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/02-restore-fold-projection-equality-sweep-title.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/03-centralize-fanout-fact-construction-planners.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/04-close-injection-input-validation-holes.txt
bun run fragua run converge --input brief=@.fragua/briefs/next/05-widen-discipline-lints-clear-doc-drift.txt
```
