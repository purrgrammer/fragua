# Laws

Algebraic and operational invariants the typed Graph model satisfies. Each law is either type-system enforced, statically checkable on the IR, or a runtime invariant verifiable via property-based testing.

Stating them explicitly serves three purposes:

1. **Spec.** The runtime contract authors can rely on.
2. **Lint surface.** Static checkers that catch violations at IR-compile time.
3. **Property tests.** Each law is `fast-check` property-shaped. The runtime reducer, intent fold, status transitions, and budget policy are exactly the kind of code where bugs are combinatorial — property testing surfaces them at scale.

## Type-system enforced (compile-time)

1. **Schema compatibility at edges.** For every edge `(a → b)`: `Output(a) ⊆ select(Input(b))`. Compile error on violation. The single biggest authoring win.

2. **Outcome totality.** Every node returns exactly one `Outcome<O>` case (`ok` | `err` | `aborted` — three variants). Discriminated union; exhaustiveness checked on consumers. `paused` is a `RunStatus`, not an Outcome variant — edges only fire on terminated nodes.

3. **Sub-graph closure.** `Graph<I, O>` implements `Node<I, O>`. The category is closed under composition.

## Statically checkable on the IR (lint, pre-run)

4. **Reachability.** Every node reachable from `start`; every node reaches an `exit`. Dead code rejected.

5. **Predicate completeness.** For each node, the union of outgoing forward edges' `when` predicates covers all of `O`, or an explicit `else` edge exists. Statically decidable when predicates are in the DSL form.

6. **Predicate disjointness.** At most one forward edge from a given node fires per outcome (retarget edges excluded).

7. **DAG property.** Forward edges form a DAG; only retarget edges close cycles; every retarget edge has `retryBudget`.

## Algebraic identities

8. **Composition associativity.** For any composable graphs / nodes: `(a ∘ b) ∘ c ≡ a ∘ (b ∘ c)`.

9. **Identity.** `id<I> : Node<I, I>` exists with `id ∘ f ≡ f ∘ id ≡ f`.

10. **Map fusion** (deterministic `Task` bodies only — NOT `LLM`; the determinism premise is author-asserted, not structurally guaranteed): `Map(f) ∘ Map(g) ≡ Map(f ∘ g)`. Holds semantically when `f` and `g` are deterministic given their inputs; whether the runtime exploits it as an optimization is separate.

11. **Reduce associativity** (builtin function reducers whose `⊕` is associative — `concat`, `json_merge` are; `majority_vote` is not): order of reduction is irrelevant.

12. **Empty Map.** `Map(extract: _ => [], body, 'wait_all')` returns `[]` deterministically.

## Runtime invariants

13. **Replay determinism.** `replay(graph, env_det, log) ≡ state`. Pure function over the event log when Environment dependencies (`clock`, `rng`, providers) are deterministic.

14. **Fact monotonicity.** Fact stream is append-only: `facts(t₁) ⊆ facts(t₂)` for `t₁ < t₂`.

15. **Resume idempotence.** `resume(R) ≡ resume(resume(R))` when no intervening events.

16. **Budget monotonicity.** Cumulative cost is non-decreasing in run time.

17. **Budget bound.** `final_cost ≤ budget + max_turn_cost` (atomic at turn boundary; a budget policy fires when crossing the threshold, but the in-flight turn completes).

18. **Retry budget exhaustion.** A retarget edge with `retryBudget = N` fires at most `N` times per run.

19. **Termination.** Every run reaches an `exit` or a halt fact in bounded steps. Consequence of: forward edges DAG + bounded retry budgets + bounded `Wait` timeouts.

## Property-based testing templates

Every law above is `fast-check` property-shaped. A representative selection:

```ts
test.prop('Map fusion on pure bodies', [g.array(g.int())], (xs) => {
  const a = run(Map(double).then(Map(square)), xs);
  const b = run(Map(x => square(double(x))),   xs);
  expect(a).toEqual(b);
});

test.prop('replay is deterministic', [g.graph(), g.input()], (graph, input) => {
  const r1 = runGraph(graph, deterministicEnv(seed), input);
  const r2 = runGraph(graph, deterministicEnv(seed), input);
  expect(r1.state()).toEqual(r2.state());
});

test.prop('retarget budget enforced', [g.graphWithRetarget(), g.input()], (g, i) => {
  const r = runGraph(g, env, i);
  const fires = r.history().filter(isRetargetFired);
  expect(fires.length).toBeLessThanOrEqual(g.retryBudget);
});

test.prop('predicate disjointness', [g.graphIR()], (ir) => {
  for (const node of ir.nodes) {
    const overlap = predicateOverlap(node.outgoingForwardEdges);
    expect(overlap).toBeEmpty();
  }
});

test.prop('budget bound', [g.graph(), g.input()], (g, i) => {
  const r = runGraph(g.withBudget(1.00), env, i);
  expect(r.state().cost).toBeLessThanOrEqual(1.00 + MAX_TURN_COST);
});

test.prop('event log replay = direct run', [g.graph(), g.input()], (g, i) => {
  const direct = runGraph(g, env, i);
  await direct.result;
  const replayed = Run.replay(boundGraph, direct.id);
  expect(replayed.state()).toEqual(direct.state());
});

test.prop('composition associativity', [g.node(), g.node(), g.node(), g.input()], (a, b, c, i) => {
  expect(run(compose(compose(a, b), c), i)).toEqual(run(compose(a, compose(b, c)), i));
});
```

## Generators

The hard part isn't the assertions — it's generating valid graphs. The generator suite:

```ts
namespace g {
  function nodeKind():                  Arbitrary<NodeKind>;
  function edge(from: Node, candidates: Node[]): Arbitrary<Edge>;
  function dagGraph(maxNodes: number):  Arbitrary<Graph>;
  function graphWithRetarget():         Arbitrary<Graph>;
  function input():                     Arbitrary<JsonValue>;
  function predicateExpr<O>():          Arbitrary<PredicateExpr<O>>;
}
```

Generators produce DAG-by-construction (forward edges only, retargets explicit, predicates from the DSL grammar). The properties verify that runtime invariants hold across the generated population.

This is the rigour upgrade over today's snapshot tests — for the runtime reducer, intent fold, status transitions, and budget policy, where bugs are combinatorial.
