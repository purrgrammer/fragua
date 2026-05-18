# Pattern catalog

The eight patterns from Anthropic's "Building Effective Agents," expressed in the typed Graph model. Each section: what the pattern is, the typed expression, the current DOT analogue.

## Augmented LLM

**What.** An LLM enhanced with tools, memory, retrieval. Foundation for all agent systems.

**Typed.** A single `LLM` node with `tools`, optional `thread`, optional `bounds`.

```ts
const summarise = llm<DocInput, Summary>({
  model:       'claude-sonnet-4-6',
  tools:       [readTool, grepTool],
  buildPrompt: (i) => ({ user: `Summarise: ${i.path}` }),
  parseOutput: 'tool-call',
});
```

**Today.** A `box` codergen node with `allowed_tools`. Same shape; no migration needed.

## Prompt chaining

**What.** Sequential decomposition: `A → B → C`. Each step's output feeds the next.

**Typed.** Linear `.edge()` calls. Compiler enforces `Output(a) ⊆ Input(b)`.

```ts
const pipeline = graph<RawInput, FinalOutput>('pipe', '1.0.0')
  .node('extract',   llm<RawInput, Facts>(/* … */))
  .node('summarise', llm<Facts, Summary>(/* … */))
  .node('translate', llm<Summary, TranslatedSummary>(/* … */))
  .edge('extract',   'summarise')
  .edge('summarise', 'translate')
  .compile();
```

**Today.** Linear DOT edges. `ci-gate.dot`, `analyze.dot`, `structural-drift.dot`.

## Routing

**What.** Classify input, dispatch to specialist downstream.

**Typed.** A classifier node feeds multiple edges with disjoint `when` predicates.

```ts
.node('classify',  llm<Request, Classification>(/* … */))
.edge('classify',  'billing',   { when: (c) => c.kind === 'billing'   })
.edge('classify',  'technical', { when: (c) => c.kind === 'technical' })
.edge('classify',  'fallback')   // else branch
```

Predicate completeness is statically checkable — a routing graph with uncovered cases fails lint.

**Today.** Conditional edges over `context.<key>`. Not currently in our workflows — `change.dot` + `feature.dot` would collapse cleanly into one routed graph.

## Parallel — sectioning

**What.** N concurrent branches examining different concerns, joined by a reducer.

**Typed.** Either explicit fan-out (N edges → N specialist nodes → `Reduce`) or `Map` with heterogeneous bodies.

```ts
.node('scope', llm<ChangeRef, Scope>(/* … */))
.node('lenses', map({
  extract: (s) => [
    { lens: 'correctness', scope: s },
    { lens: 'security',    scope: s },
    { lens: 'performance', scope: s },
    { lens: 'architecture',scope: s },
  ],
  body:        lensNode,                       // LLM<{ lens, scope }, Finding[]>
  concurrency: 4,
  policy:      'wait_all',
}))
.node('synthesise', reduce({
  kind: 'llm',
  llm:  synthesiseLLM,                          // LLM<Finding[][], Report>
}))
.edge('scope',  'lenses')
.edge('lenses', 'synthesise')
```

**Today.** `component → branches → tripleoctagon` with the reducer as a downstream codergen. `review.dot`.

## Parallel — voting

**What.** Same task N times; aggregate with a vote / median / majority.

**Typed.** `Map` with `extract: i => Array(N).fill(i)` + function `Reduce`.

```ts
.node('vote', map({
  extract:     (i) => Array.from({ length: 5 }, () => i),
  body:        judgeNode,                            // LLM<Input, Verdict>
  concurrency: 5,
  policy:      'wait_all',
}))
.node('aggregate', reduce({
  kind:    'function',
  builtin: 'majority_vote',          // runtime-provided builtin
}))
.edge('vote', 'aggregate')
```

**Today.** Not currently in the catalog. Supported by the same primitives as sectioning.

## Orchestrator-workers

**What.** A central LLM dynamically decomposes tasks, delegates to workers, synthesises results.

**Typed.** Two forms:

- **Opaque** — single `LLM` node with `agent` in tools; the model decides at runtime. Same as today.
- **Observable** — `LLM(decompose) → Map → Reduce`. The decomposition is data, not internal tool calls.

```ts
// Observable form
.node('plan',    llm<Task, Subtasks>(/* model emits typed list */))
.node('workers', map({
  extract:     (p) => p.subtasks,
  body:        workerNode,
  concurrency: 2,
}))
.node('synthesise', reduce({ kind: 'llm', llm: synthLLM }))
.edge('plan', 'workers')
.edge('workers', 'synthesise')
```

The observable form lets you replay, intervene, budget-bound *per subtask*. Today's `orchestrate.dot` is opaque; the typed model lets you pick.

**Today.** `orchestrate.dot` (opaque), `doc-sync.dot::audit`, `narrative-drift.dot::audit`.

## Evaluator-optimizer

**What.** Generate, evaluate, loop on rejection.

**Typed.** A retarget edge from the judge back to the generator with `retryBudget`.

```ts
.node('implement', llm<Plan, ImplementOutput>(/* … */))
.node('review',    llm<ImplementOutput, Verdict>(/* … */))
.edge('implement', 'review')
.edge('review',    'commit',    { when: (v) => v.tag === 'approve' })
.edge('review',    'implement', {
  kind:        'retarget',
  when:        (v) => v.tag === 'reject',
  select:      (v) => /* feed rejection back as input augment */,
  retryBudget: 2,
})
```

The retarget surface is graph topology, not a node attribute. Renderers, validators, and static analyses see it directly.

**Today.** `goal_gate=true` + `retry_target=` on the judge. The dominant pattern in our daily drivers (`change.dot::review`, `feature.dot::review`, every drift workflow).

## Autonomous agent

**What.** Open-ended loop with environment feedback. The "agent" of agent-vs-workflow.

**Typed.** A single `LLM` node with broad tools, high bounds, prose-encoded judgment. Identical to today.

```ts
const merge = llm<BranchName, MergeResult>({
  model:       'claude-opus-4-7',
  tools:       [readTool, writeTool, editTool, bashTool],
  bounds:      { maxCostUsd: 0.50, maxTokens: 1_200_000 },
  buildPrompt: (b) => ({ user: `Rebase ${b} onto main and CAS-fast-forward.` }),
  parseOutput: 'tool-call',
});
```

When this gets long (today's `merge.dot` is ~80 lines of prose), that's the signal to decompose into smaller nodes. "Start simple, add complexity as warranted" applies in both directions.

**Today.** `merge.dot`. `orchestrate.dot`'s orchestrator (when used opaquely).

## Choosing a pattern

A decision tree:

1. **One step or many?** One → augmented LLM. Many → continue.
2. **Subtasks known upfront?** No → orchestrator-workers. Yes → continue.
3. **Concurrent or sequential?** Concurrent + different concerns → sectioning. Concurrent + same task → voting. Sequential → chaining.
4. **Need backtracking?** Yes → evaluator-optimizer (retarget edge). No → straight chain.
5. **Need branching by input?** Yes → routing (predicate edges). No → done.

Pick before drawing. Code follows topology, not vice versa.
