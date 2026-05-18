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

`LLM(reproduce, self-retarget) → LLM(fix) → Task(detect-runner) → LLM(verify)`. `detect-runner` formalizes as a `Task` — same shape as today's `tool` node.

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

## OutcomeStatus migration matrix

Today's swarm engine uses a wider `OutcomeStatus` taxonomy than the typed model's three-variant `Outcome`. Each maps explicitly:

| Today's OutcomeStatus | Typed-model equivalent |
|---|---|
| `success` | `Outcome.ok` with typed `value` |
| `fail` | `Outcome.err` with typed `error` body |
| `error` | Run-level `fact.run_halted { reason: 'error' }`; not a node `Outcome` |
| `partial_success` (some Map branches failed) | `Map.policy = 'collect_settled'` produces `Settled<O>[]` with per-element `{ ok } \| { err }` |
| `skipped` (Map element skipped due to `first_success`) | Not a node Outcome — the sub-Run was either never started or aborted; visible in the sub-Run's `RunStatus` |
| `retry` (runtime-internal retriable failure) | Below the handler surface as `pause_provider` mechanism; not exposed as a node Outcome |
| `paused_hitl` | `RunStatus.paused_hitl`; not a node Outcome (Wait nodes have no terminal Outcome until resumed) |
| `paused` | `RunStatus.paused` with reason discriminator |
| `aborted` / `aborted_exit` | `Outcome.aborted` with `reason: string` |
| `quarantined` | `RunStatus.quarantined`; recovery via `intent.unquarantine` |
| Today's HITL "preferred label" routing | UI affordance only; Wait routes via predicate over the resume payload schema |
| Today's "suggested next ids" from handler | Edge predicate matching over `Outcome` (no separate suggested-routing channel) |

The typed model deliberately collapses node-vs-run statuses into orthogonal axes: `Outcome` per node, `RunStatus` per Run. Today's flat enum mixed both; the split clarifies which is which.

## What stays the same

- Event-sourced reducer.
- Replay determinism.
- Intent / fact separation.
- Budget enforcement.
- HITL pause/resume mechanics (now under unified `Wait` kind).
- Cost / token observability.

The runtime semantics carry forward; the authoring surface and the data-flow contract gain types.

## What retires from DOT

Comprehensive list. Every DOT facility that the typed model deliberately doesn't inherit:

| Today | Replacement |
|---|---|
| `$ARGUMENTS` | Typed graph input `I` |
| `$<id>.output` substitution | Edge transforms |
| `$<id>.output.<path>` | Edge transforms with PathExpr |
| `$<id>.stderr` | `Outcome.err.error.stderr` |
| `$goal` | TemplateExpr context var `${graph.contractVersion}` and similar |
| `${context.<key>}` substitution | Typed edges (no side-channel KV) |
| `condition="outcome=..."` | Predicate DSL `o.tag === 'ok'` |
| `condition="context.<key>=..."` | Predicate DSL over `o.value.<path>` |
| `outcome=success \| fail \| error` | `Outcome.tag = 'ok' \| 'err' \| 'aborted'` |
| `max_retries=` on node | Retarget self-edge |
| `goal_gate=true` | Retarget edge with `retryBudget` |
| `retry_target=` | Retarget edge target |
| `fallback_retry_target=` | Multiple retarget edges with cascading predicates |
| `max_goal_gate_retries=` | Per-edge `retryBudget` |
| `class=` | SDK helpers (`.withModelGroup(...)`) |
| `model_stylesheet=` | SDK helpers |
| `cluster_<name>` class-derivation | Real sub-graphs use `subgraph(...)` builder |
| `default_fidelity` | Dropped with fidelity |
| `default_max_retries` | SDK default helpers |
| `default_retry_policy` | No node-level retry policy |
| `default_*` graph-level defaults | SDK defaults |
| Shape vocabulary (`Mdiamond`, `Msquare`, `box`, `diamond`, `hexagon`, `parallelogram`, `component`, `tripleoctagon`) | NodeKind discriminator (`llm` / `task` / `wait` / `map` / `reduce` / `subgraph`); `start` / `exits` on Graph for lifecycle |
| `type=` shape override | NodeKind only |
| `prompt=` raw string | `prompt: { system?, user }` template specs |
| `allowed_tools=` CSV string | `tools: ToolRef[]` typed array |
| `llm_model=`, `llm_provider=` | Typed fields |
| `tool_command=` | `Task.command` |
| `fidelity=` on codergen | Shared thread = full prior context (no truncation tier) |
| LLM `parseOutput.fromAssistantText` fallback parser | Drop; downstream Task parses if needed |
| `budget_policy=` keyword | `bounds.policy: 'stop' \| 'warn' \| 'pause'` |
| `Outcome.paused` | `RunStatus.paused` (orthogonal axis) |
| `Outcome.err.retriable` | Retarget edges (retry is graph topology) |
| Edge `subscribe` callback API | `events: AsyncIterable` only |

What stays (rationale: independent design merit, not attractor inheritance):

- Provider + model abstraction
- Tool registry (via extensions)
- `skills` / `agents` catalogs (system-prompt discovery surfaces)
- Worktree provisioner
- HITL pause/resume model
- Budget enforcement
- Event-sourced reducer
- Replay determinism

## `change.dot` retry translation (worked example)

The two retry patterns in `change.dot` translate to the typed model's retarget edges:

```ts
const change = defineGraph<ChangeInput, ChangeOutput>('change', '1.0.0')
  .input(ChangeInputSchema)
  .output(ChangeOutputSchema)
  .bounds({ maxCostUsd: 10.0, policy: 'stop' })

  .node('plan',      llm({ model: 'claude-opus-4-7',  prompt: { user: '...' } }))
  .node('implement', llm({ model: 'claude-sonnet-4-6', thread: 'dev', prompt: { user: '...' } }))
  .node('review',    llm({ model: 'claude-sonnet-4-6', thread: 'dev', prompt: { user: '...' } }))
  .node('ci',        task({ command: 'bun run ci' }))
  .node('fix',       llm({ bounds: { maxCostUsd: 0.10, maxTokens: 300_000 }, prompt: { user: '...' } }))
  .node('commit',    llm({ prompt: { user: '...' } }))

  // Pattern 1: review goal-gate cycle (today: goal_gate + retry_target + max_goal_gate_retries=2)
  .edge('plan',      'implement')
  .edge('plan',      'done', { when: (o) => o.tag === 'err' })

  .edge('implement', 'review')
  .edge('implement', 'done', { when: (o) => o.tag === 'err' })

  .edge('review',    'implement', retarget({ when: (o) => o.tag === 'err', retryBudget: 2 }))
  .edge('review',    'ci',   { when: (o) => o.tag === 'ok' })
  .edge('review',    'done', { when: (o) => o.tag === 'err' })   // fires when retarget exhausted

  // Pattern 2: ci-fix loop (today: ci.max_retries=5 with fix→ci backward edge)
  .edge('ci',        'commit', { when: (o) => o.tag === 'ok' })
  .edge('ci',        'fix',    { when: (o) => o.tag === 'err' })
  .edge('fix',       'ci',   retarget({ when: (o) => o.tag === 'ok', retryBudget: 5 }))
  .edge('fix',       'done', { when: (o) => o.tag === 'err' })   // fix itself aborts → halt

  .edge('commit',    'done')
  .compile();
```

Both retries express. Cost: ~3 extra `done` fallback edges that today's DOT model leaves implicit ("no matching outgoing edge → halt"). The typed model makes every termination path explicit; SDK ergonomic helpers (`.haltOnError(...)`, `.edge(...).onError('done')`) can collapse the boilerplate without changing the IR.

## Order of operations

The migration lands in layers, each independently useful:

1. **Canonical JSON IR** (proposal: `../proposals/json-ir-canonical.md`). DOT stays primary; storage flips to canonical JSON. No new types, no new kinds — just the wire format.
2. **Typed schemas on nodes.** Each node carries `inputSchema` and `outputSchema`. Optional fields on the IR; default to `unknown` (back-compat with non-typed nodes).
3. **TS builder.** `@swarm/sdk` (or similar) emits the typed IR from TS code. Authoring becomes IDE-native; the IR stays the wire contract.
4. **Edge DSL.** Predicate + transform DSL with named-function escape hatch. Replaces today's stringly-typed `condition=`.
5. **Five-kind model.** `Task`, `Map`, `Reduce` join `LLM` and `Wait`. `Conditional` / diamond disappears (routing is an edge property); no `Function` kind (user JS lives in extensions, deterministic compute in `Task`).
6. **Run / Environment split.** `bind(graph, env)` → `BoundGraph`. `Run.fresh / replay / resume` peer constructors. `IO<E>` first-class.

DOT keeps working throughout. Workflows authored in DOT today survive the migration as-is; new features are TS-only.
