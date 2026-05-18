# Example workflows

Reference workflows demonstrating swarm's patterns. Each example is annotated and exercises a specific feature surface; combine and adapt them in your own `~/.swarm/workflows/` or `<project>/.swarm/workflows/` directories.

## Catalogue

| Workflow | Pattern | Demonstrates |
|---|---|---|
| [`review.dot`](review.dot) | Parallel sectioning + LLM synthesis | 4 read-only lenses (correctness / security / performance / architecture) running concurrently against the same diff; `component` fan-out; `tripleoctagon` fan-in with synthesis via the reducer prompt reading `$<lens>.output`; PR/branch checkout pre-flight; severity-merging across lenses. |
| [`fix-bug.dot`](fix-bug.dot) | Evaluator-optimizer (self-retarget) | `reproduce → fix → detect_test_runner → verify` with a self-retarget on `reproduce` (goal-gated; max_goal_gate_retries=2). Demonstrates: `goal_gate`, `retry_target` pointing at the same node, shared thread for dev nodes, runtime-agnostic test-runner detection via a tool node. |
| [`doc-sync.dot`](doc-sync.dot) | Orchestrator-workers + HITL + apply tail | The "kitchen sink." Multi-area parallel auditor subagents via `agent` toolcalls; goal-gated review; HITL hexagon with `[K] Label` accelerator routing; parallelogram apply step; verify tail. The full multi-pattern composition end-to-end. |
| [`merge.dot`](merge.dot) | Autonomous-agent (single fat codergen) | Counter-example: when prose-in-codergen beats encoding the graph. Single fat `rebase` codergen with broad tool pool, prose-encoded CAS-retry logic, high bounds, fresh-thread-per-node. Read this to see the limit of "compose it" — past a certain complexity, one well-written prompt beats a many-node graph. |
| [`voting.dot`](voting.dot) | Parallel voting | N identical voters judge the same input; downstream tally counts votes deterministically. Useful for high-stakes go/no-go calls where single-sample LLM judgment is noisy. |

## Patterns covered

| Pattern | Example |
|---|---|
| Augmented LLM (single fat node) | `merge.dot` |
| Prompt chaining | any multi-step example |
| Routing (predicate edges) | (none — write your own; see `.agents/skills/swarm-author/SKILL.md` §1 *Routing*) |
| Parallel sectioning | `review.dot` |
| Parallel voting | `voting.dot` |
| Orchestrator-workers | `doc-sync.dot::audit` |
| Evaluator-optimizer | `fix-bug.dot::reproduce`, `doc-sync.dot::review` |
| HITL (hexagon) | `doc-sync.dot::signoff` |
| Autonomous agent | `merge.dot` |

## Supporting scripts

Two examples reference user-installed scripts at `~/.swarm/scripts/`. Reference implementations are in this directory:

- [`fix-bug/detect-runner.sh`](fix-bug/detect-runner.sh) — manifest-based test-command detection (Bun / pnpm / yarn / npm / pytest / cargo / go / composer / bundle / mix). Copy to `~/.swarm/scripts/fix-bug/detect-runner.sh` to enable `fix-bug.dot`.
- [`doc-sync/apply.ts`](doc-sync/apply.ts) — applies a list of `{old_string, new_string}` edit blocks to a single doc. Copy to `~/.swarm/scripts/doc-sync/apply.ts` to enable `doc-sync.dot`'s apply tail.

The other three examples (`review.dot`, `merge.dot`, `voting.dot`) have no external script dependencies — they run as-is.

## Running

```sh
# Copy a workflow to your local workflow directory
mkdir -p ~/.swarm/workflows
cp examples/workflows/review.dot ~/.swarm/workflows/

# (If the workflow needs a supporting script:)
mkdir -p ~/.swarm/scripts/fix-bug
cp examples/workflows/fix-bug/detect-runner.sh ~/.swarm/scripts/fix-bug/
chmod +x ~/.swarm/scripts/fix-bug/detect-runner.sh

# Run
bun run swarm run review --input="HEAD~3..HEAD"
```

Workflows in `~/.swarm/workflows/` are global (reachable from any project cwd); workflows in `<project>/.swarm/workflows/` are project-local. `swarm run <name>` resolves bare names against project-local first, then global.

## Authoring your own

See `.agents/skills/swarm-author/SKILL.md` (or `.claude/skills/swarm-author/SKILL.md`) for the full authoring guide. Start with a single-node augmented-LLM workflow; reach for composition only when the work has discrete steps with different concerns.

## Known notes

- **Fan-in synthesis** today runs as a heuristic concatenator regardless of `prompt=` on `tripleoctagon` (validator emits W015). Workflows that need real LLM synthesis (`review.dot`, `voting.dot`) put the reducer prompt on the tripleoctagon as the canonical form; the fix to honor it is tracked under `docs/proposals/fan-in-to-reduce.md`.
- **HITL inside a parallel branch** is not supported in v1 — see the parallel sub-runs proposal (`docs/proposals/parallel.md`) for the path forward. None of these examples nest HITL inside a fan-out.
