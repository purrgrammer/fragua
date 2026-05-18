# Migration: current workflows → typed Graph model

Per-workflow mapping. Every existing workflow expresses in the typed model. Most express better; one (`merge.dot`) expresses dramatically better; one (`research.dot`) reveals that the shared-thread + fidelity-full idiom is a *symptom* of stringly-typed outputs, not a feature worth preserving.

The current workflow contract:

- Graph: `Graph<string, string>` (implicit `{ input: string }`, no typed output).
- Node: every codergen returns `string` (last assistant message).
- Edge: `condition=` is a stringly-typed DSL over `outcome` and `context.<key>`.
- Data flow: `$<node>.output` substitution (verbatim text dump) or shared thread (compact-fidelity by default).

The new contract: typed I/O at every node, typed edge transforms, structured `Outcome`s.

## Per-workflow translation

### Smoke tests

`agent-multi`, `agent-named`, `agent-smoke`, `abort-test` × 2, `parallel-hitl-smoke` — single `LLM` nodes or small parallel sub-graphs; assertions move from "substring grep on transcript" to "match against typed `FactOf<E>`". Net DX win.

### `ci-gate.dot`

Three `Task` nodes in a chain. The exemplar of "workflow, not agent" — no LLM, no decisions, no judgment. Stays exactly as-shaped, just typed.

### `health.dot`, `analyze.dot`, `structural-drift.dot`, `rollup.dot`

Linear chains: `Task(collect) → LLM(reason) [→ LLM(verify, retarget)]`. Each node typed against the previous; the `verify` retarget is a typed retarget edge.

### `change.dot` / `feature.dot`

The daily drivers. Six-or-seven nodes each:

- `LLM(plan)` → `Plan`
- `LLM(implement)` → `ImplementOutput` (the PLAN_REALISED block becomes a typed field)
- `LLM(review)` → `Verdict` (retarget edge on reject)
- `Task(ci)` → `CiResult`
- `LLM(fix)` → `FixOutput` (retarget edge on ci-fail)
- `LLM(commit)` → `CommitSha`

The near-duplicate `change` / `feature` pair collapses into one graph with a `mode: 'small' | 'feature'` input field; routing edges pick the implementation path.

### `fix-bug.dot`

`LLM(reproduce, self-retarget) → LLM(fix) → Task(detect-runner, idempotent by manifest hash) → LLM(verify)`. `detect-runner` formalizes as a `Task` because it's a side-effecting probe that's idempotent — same shape as today's `tool` node plus the explicit `idempotencyKey`.

### `review.dot`

`LLM(scope) → Map(4 lenses) → Reduce(llm)`. The lens list is data; adding a fifth lens is one line. Today: edge-graph surgery.

### `doc-sync.dot` / `narrative-drift.dot`

The orchestrator-workers tail: `audit` fans out via the `agent` tool today; in the typed model it becomes `LLM(planFanout) → Map → Reduce(llm)`. The fan-out becomes observable (decomposition is data), and the budget bound moves to per-element instead of per-audit.

The other heavy refactor — `doc-sync`'s residual skips on `apply` and `verify` (tagged `TODO(typed-model)` in the current `.dot`) — closes naturally: `apply` becomes a `Task` taking a typed `Patch` input; `verify` reads `apply`'s typed `ApplyResult`. No external-script changes needed at that point.

### `orchestrate.dot`

Single LLM with `agent` tool — unchanged shape. Optionally migrates to the observable form (`LLM → Map → Reduce`) when budgeting per-subtask matters.

### `research.dot`

The diagnostic case. Today: `research` returns markdown manifest text; `synthesize` reads raw `web_fetch` tool results via shared thread + `fidelity=full`. The shared-thread-as-data-channel trick exists because text outputs are bulky and re-stringifying them is expensive.

In the typed model: `research` returns `{ fetched: { url: string; markdown: string }[] }`. The data flows along the edge, typed. The shared-thread idiom retires. The single biggest legibility win of any workflow in the catalog.

### `merge.dot`

The autonomous-agent outlier. Today: one fat codergen with ~80 lines of prose encoding rebase + CAS-loop logic in the prompt.

In the typed model:

- `Task(preflight)` — pure git probe
- `LLM(rebaseAttempt)` — try the rebase
- `LLM(resolveConflicts, self-retarget bounded 5)` — only runs on conflict
- `Task(casSwap)` — idempotent by `old_main_sha`
- retarget edge `casSwap → rebaseAttempt` with `retryBudget: 7` (CAS race retry, bounded)
- `Task(refreshMain)` — idempotent, sibling-worktree-aware
- `Task(deleteBranch)`

CAS retry becomes a typed retarget edge; conflict-resolution attempts are bounded by an edge attribute, not by the LLM remembering its own counter. The prose loop becomes graph topology. The single biggest "agent that should be a workflow" case in the catalog.

## Three input channels — current vs typed

Today, a node's input comes from one of three places:

1. **Shared thread (continuity)** — both nodes set `thread_id="…"`; downstream sees prior turn(s) in conversation history.
2. **Substitution (data hand-off)** — `$<nodeId>.output` substitutes the producer's text into the consumer's prompt verbatim.
3. **Environment re-derivation** — node re-reads git / fs / external API. "Fresh thread — read state via git."

In the typed model:

1. **Edge transforms** — typed data flows along edges. Replaces substitution-as-data-channel. The `$<node>.output` knob disappears from the authoring surface.
2. **Thread participation** — `thread` is purely a continuity hint; the runtime decides what prior messages to include. `fidelity` retires.
3. **Environment re-derivation** — unchanged. The Environment remains the source of truth for state outside the graph.

The three channels stay; the mechanism of (1) and (2) becomes cleaner.

## What gets statically caught after migration

- **Edge schema mismatches.** Today: silent, surfaces at runtime when the consumer parses garbage. Tomorrow: compile error.
- **Predicate completeness.** Today: W003 catches the missing `outcome=fail` catch-all heuristically. Tomorrow: typed exhaustiveness.
- **Reachability.** Today: W001 (orphan node). Tomorrow: typed unreachable code.
- **Goal-gate retarget chain.** Today: W007 if missing. Tomorrow: type-level requirement (a `goal_gate` node *must* have a typed retarget edge).
- **LLM output contract.** Today: no contract; downstream parses prose. Tomorrow: terminal output tool with schema; validation at the LLM boundary.

## What stays the same

- Event-sourced reducer.
- Replay determinism.
- Intent / fact separation.
- Budget enforcement.
- HITL pause/resume mechanics (now under unified `Wait` kind).
- Cost / token observability.

The runtime semantics carry forward; the authoring surface and the data-flow contract gain types.

## What retires from DOT

A handful of DOT facilities that exist today don't translate one-to-one — and don't need to. SDK-level replacements cover the same intent more legibly:

- **`cluster_<name>` subgraphs as class-derivation.** Today's `subgraph cluster_review { ... }` is *not* a sub-graph in the typed sense — it's a flat sibling namespace that derives a class for `model_stylesheet` rules. Retires alongside `class=` and `model_stylesheet=`. The typed equivalent for "these three nodes share a model" is the SDK helper `.withModelGroup(['plan', 'review'], 'claude-opus-4-7')` — explicit, no class system. *Real* sub-graphs (composable units with their own inputs/outputs) use the `subgraph(...)` builder per [sdk.md § Sub-graph composition](sdk.md#sub-graph-composition).
- **`model_stylesheet`** and **node `class=`**. Bulk styling moves to SDK helpers; per-node `llm_model` / `llm_provider` stays.
- **`fidelity=`**. Shared-thread continuity is implicitly full; the typed model carries data via edge transforms, not via "include N prior messages."
- **`max_goal_gate_retries`** as a graph-level chained-retarget cap. Replaced by explicit per-retarget-edge `retryBudget`. Each gate's retarget edge is its own decision; no graph-level fallback chain.
- **`default_retry_policy`**. No node-level retry policy in the typed model; retries are graph topology.
- **`${context.<key>}`** substitution. Run-state KV as a side-channel retires; typed edges carry data instead.

## Order of operations

The migration lands in layers, each independently useful:

1. **Canonical JSON IR** (proposal: `../proposals/json-ir-canonical.md`). DOT stays primary; storage flips to canonical JSON. No new types, no new kinds — just the wire format.
2. **Typed schemas on nodes.** Each node carries `inputSchema` and `outputSchema`. Optional fields on the IR; default to `unknown` (back-compat with non-typed nodes).
3. **TS builder.** `@swarm/sdk` (or similar) emits the typed IR from TS code. Authoring becomes IDE-native; the IR stays the wire contract.
4. **Edge DSL.** Predicate + transform DSL with named-function escape hatch. Replaces today's stringly-typed `condition=`.
5. **Five-kind model.** `Task`, `Map`, `Reduce` join `LLM` and `Wait`. `Conditional` / diamond disappears (routing is an edge property); no `Function` kind (user JS lives in extensions, deterministic compute in `Task`).
6. **Run / Environment split.** `bind(graph, env)` → `BoundGraph`. `Run.fresh / replay / resume` peer constructors. `IO<E>` first-class.

DOT keeps working throughout. Workflows authored in DOT today survive the migration as-is; new features are TS-only.
