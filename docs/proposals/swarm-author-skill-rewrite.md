---
title: swarm-author SKILL.md final sweep
status: in-progress
maturity: design
last-reviewed: 2026-05-17
---

# swarm-author SKILL.md final sweep

> Status: in-progress · Maturity: design
>
> Captures the deferred skill-update obligation that accumulated across the
> G1–G9 + AJV + JSON IR addendum work in May 2026. The rewrite is deliberately
> held back: three in-flight directions (typed DOT, `@swarm/sdk`, JSON IR
> canonical) will reshape what the skill teaches and how it presents node
> contracts. Doing the edit now means doing it twice. This doc lists what's
> outdated, what's pending, and the open questions that gate the final pass.

---

## Why deferred

The swarm-author skill was written for the DOT-as-canonical world. Three
parallel design tracks now in motion change the model the skill should teach:

1. **JSON IR canonical** (`docs/proposals/json-ir-canonical.md`, designed) —
   DOT becomes authoring sugar; the canonical form is JSON IR. The skill needs
   to (a) explicitly position DOT as the *authoring layer*, (b) reference the
   published Typebox schema in `@swarm/types`, (c) handle the round-trip
   asymmetry on string-attrs-that-are-actually-JSON (e.g. `output_schema`).
2. **`@swarm/sdk` programmatic builder** (brainstorm: `/tmp/swarm-orchestration/sdk-brainstorm.md`,
   not yet a proposal) — TS-first authoring with typed context flow,
   importable subworkflows. The skill becomes one of *two* authoring stories;
   needs a clear "when to reach for SDK vs. DOT" frame.
3. **Typed inputs/outputs/context** (direction signal, no proposal yet) — the
   eventual destination is per-node typed input contracts and typed context
   keys. The current skill's substitution and condition sections are written
   for the untyped world; both sections collapse if (3) lands as designed.

Patching the skill now means a second pass once (1)–(3) settle. The cost of
one comprehensive rewrite is lower than three half-rewrites.

---

## What's outdated today (the must-fix list)

Anchored to the current skill at `.agents/skills/swarm-author/SKILL.md`
(symlinked from `.claude/skills/swarm-author`).

### §2 Node attributes — missing surface

- **`output_schema`** (G1 / `codergen-context-output-tools.md`, shipped) —
  not mentioned. Authors have no way to know it exists or how to declare it.
- **Edge-level `thread_id` / `fidelity` overrides** (verified during the
  attractor parity audit; wired at `packages/core/src/engine/fidelity.ts:17,28`).
  Skill teaches node-level only; edge attrs go unmentioned.
- **`max_ms = 0` sentinel** for unbounded codergen (`codergen-unbounded-time`
  proposal, shipped) — partially in §14 but worth more visibility given the
  4h `DEFAULT_MAX_MS` runaway-backstop semantics that bit us during the FG1
  hang.

### §4 Substitution tokens — over-claims and missing tokens

- The token list still mentions tokens the substitution module never exposed
  (`$RUN_ID`, `$WORKTREE_PATH`, `$ARTIFACTS_DIR`, `$1..$9` — confirmed not
  implemented at `packages/core/src/engine/substitution.ts:37`). The skill is
  honest about this but the table presentation invites confusion.
- **`$<nodeId>.stderr`** (G7, shipped) — new token, not in the table.
- **`run_id`** appears in the system-prompt `<environment>` block (G7) but
  the skill's §11 "Fidelity and context_files" doesn't mention the env block
  exists or what it carries.

### §5 Thread-id — incomplete picture

- Doesn't surface edge-level `thread_id` overrides (top of the precedence
  chain per attractor §5.4).
- The canonical `thread_id="research"` pattern in `research.dot` (shared
  thread between research + synthesize to read tool-result messages without
  re-paying for raw markdown) deserves an explicit callout.

### §6 Edges and conditions — old grammar

- **Extended operators** (G8, shipped) — `||`, `!`, `<`/`>`/`<=`/`>=`,
  `contains`, `matches` — not in the grammar table. The skill still says
  "`&&` conjunction only; no `||`" which is now false.
- **Bare-key truthiness** (`condition="context.foo"`) — supported, not
  documented.
- Worth a "no implicit `outcome=fail` fall-through" callout (the engine's
  deliberate halt on unrouted fail per
  `packages/core/src/engine/edge-selection.ts:88`).

### §7 Loops — stale claim corrected

- The skill claims "Counting resets when re-entered from a *different*
  source." G2 (shipped) made this true; before G2 it was false. The
  sentence now reads correctly but is worth a `<!-- post-G2 -->` annotation
  so future maintainers don't accidentally re-break it.

### §8 Goal gates — pause-rather-than-halt pathway

- **`paused{reason:"max_retries"}`** (G9, shipped) — operator can bump
  `max_retries` mid-run and resume. Skill teaches `max_retries_exceeded` as
  terminal; that's now post-resume only. Needs an "operator can raise the
  cap" sentence and a reference to `swarm-run` §4 budget/resume pattern.

### §9 Parallel + fan_in — three corrections

- **HITL inside a parallel branch IS supported** (P3 multi-node sub-runs
  shipped). Skill currently says "not supported in v1; coerces to fail."
  Refuted by `parallel-hitl-smoke.dot` running green.
- **Fan-in `prompt=`** (G3 — in flight as of this proposal) becomes
  first-class LLM evaluation, drops W015. Skill currently says it's
  "rejected (W015)." Will need to be flipped to "supported; reducer LLM
  picks the winner."
- **Voting pattern** — running N identical-prompt branches and aggregating
  by downstream codergen reading every `$<branchId>.output` — entirely
  absent from the skill. Worth a §9.x subsection once G3 lands.

### §10 Models, providers, validation — minor

- Add `bun run swarm providers add-model <provider> <id>` to the
  cheat-sheet alongside `providers ls` / `providers test`.

### §11 Fidelity and context_files — `<environment>` block

- The G7 env block now carries `run_id:` and `cwd:`. Skill doesn't mention
  the env block exists. Authors who want to know whether their `cwd:` is
  visible to the LLM (for path resolution prompts) have no reference.

### §12 Prompts that behave — context_set + emit_output

- **G1's three tools** (`abort`, `context_set`, `emit_output`) are
  force-included on every codergen call. Skill currently teaches `abort`
  only. The §12 "Authoritative task" / "Abort tool" / "Explicit tool
  whitelist" frame is the right place to fold in:
  - `context_set` — "share findings with downstream nodes via
    `${context.<key>}` substitution or `condition=`"
  - `emit_output` — "lock in your structured output; pairs with
    `output_schema=`"
  - The denied-tools W-code clarifying that force-included tools are part
    of the codergen contract.

### §13 Wait.human — correct, minor

- Worth cross-referencing G1's `context_set` for the "open-ended free-text
  gates" footnote — a HITL freeform answer can be parsed by the downstream
  codergen and published via `context_set` rather than a codergen-as-parser
  hop.

### §15 Validation — code table

- W015 dropped (post-G3).
- New E-code from G5 (in flight) for parallel branch cross-branch ownership.
- W017 adjusted semantics.
- The reference table at `references/validator-codes.md` is the
  authoritative list; the §15 prose should point to it rather than
  re-listing codes.

### §17 Anti-patterns — additions

- "Don't reach for fan-out when sequential is fine" (article-level)
- "Don't add an evaluator-optimizer if the next node already validates"
  (article-level)
- "Don't encode an agent loop in a single prompt" (pointed at the
  `merge.dot` `rebase` node)
- "Don't fight the `max_cost_usd` per-turn semantics" — clarify that
  `max_cost_usd` caps per-turn at the turn boundary; for cumulative caps
  use graph-level `budget_usd` + `budget_policy=stop`. This bit us during
  FG1 (4h hang, $5+ spend despite a `max_cost_usd=0.30`).

### Pattern-first orientation — new section

A new §1 or §0 that maps Anthropic's effective-agent patterns (prompt
chaining, routing, parallelization-sectioning, parallelization-voting,
orchestrator-workers, evaluator-optimizer) to swarm shape vocabulary
*before* teaching the shape vocabulary. The current skill teaches
mechanics; the rewrite should teach decomposition first, mechanics second.

---

## What's still in flight (will change the rewrite shape)

### Track 1: JSON IR canonical (`docs/proposals/json-ir-canonical.md`)

Status: proposed, maturity: designed. When this ships:
- DOT becomes *authoring sugar*, not the canonical form. The skill's
  framing pivots: "you write DOT, the runtime stores JSON IR."
- Comments don't round-trip — explicit teach.
- Edge order is semantically significant; canonicalization preserves it
  — explicit invariant.
- The published Typebox schema in `@swarm/types/graph-schema.ts` becomes
  the contract authors reference (vs. today's `packages/core/src/types/graph.ts`).
- The `output_schema=` string-vs-nested-object asymmetry (Addendum B)
  needs explanation.

**Open question:** does the skill teach DOT first and JSON IR as
"reference shape," or vice versa? Strawman: DOT first (it's still the
ergonomic authoring layer); JSON IR mentioned once with a link to the
schema. But the §1 pattern-first section could lean on JSON IR shapes
in the rosetta if that's clearer.

### Track 2: `@swarm/sdk` programmatic builder

Brainstorm at `/tmp/swarm-orchestration/sdk-brainstorm.md`. When this
crystalizes into a proposal:
- The skill becomes one of two authoring stories. Need a "when to use
  which" frame: SDK for type-safety + import-reuse + programmatic
  generation; DOT for quick iteration + visual graph + one-file
  workflows.
- Many concepts (substitution tokens, condition grammar, edge
  expressivity) become *both* a DOT syntax and an SDK API. The skill
  might either (a) teach DOT only and link to the SDK docs, or (b)
  show parallel SDK + DOT snippets for key recipes. (b) is more work
  but better for the cross-pollination.

**Open question:** is the swarm-author skill *just for DOT*, or does
it cover both authoring layers? Strawman: keep it DOT-focused; spin a
new `swarm-sdk-author` skill for the TS layer once that ships. Reduces
scope creep and lets each skill stay tight.

### Track 3: Typed inputs/outputs/context

Direction signal, no proposal yet. The user's stated destination is
per-node typed input contracts + typed context keys. When this lands:
- Substitution tokens (`$<nodeId>.output.<path>`) become typed — the
  skill's §4 substitution table either disappears or becomes "here's
  the runtime form; TS authors get type inference."
- `emits_context` and analogous input-declaration attrs (mentioned as
  deferred in `codergen-context-output-tools.md` §6) come back as
  first-class. The skill teaches them.
- Condition grammar (§6) gains compile-time validation against
  declared context types — the "no `||` etc." pain points become less
  relevant (the typechecker catches misuse).

**Open question:** is there a "typed DOT" or only "typed via the SDK"?
DOT is string-y; typing it requires either a separate schema declaration
or a build-step that parses the DOT and validates against declared
schemas. The SDK gets typing for free. Strawman: typed DOT via
declared `emits_context = "key:type, key:type"` style + a JSON IR
schema entry per node; SDK gets full inference. But this is genuinely
open.

---

## Open questions gating the final rewrite

These need answers before the rewrite ships:

1. **Where does DOT sit in the world after JSON IR + SDK land?**
   Authoring-only ergonomic format, runtime-irrelevant? Or first-class
   alongside JSON IR + SDK? The skill's framing depends on this.

2. **One skill or two?** swarm-author for DOT + swarm-sdk-author for
   TS, or one unified skill that covers both? Two is cleaner; one
   risks bloating into a tutorial.

3. **Typed context — declaration syntax in DOT?** If typed inputs/outputs
   are SDK-only, DOT stays untyped and the skill's substitution section
   stays roughly as-is (with the operator + token updates). If typed DOT
   ships, the substitution section gets rewritten around declared types.

4. **Pattern-first vs. shape-first?** Current skill is shape-first
   (start/exit/codergen/conditional/…). The original article-pattern
   analysis suggested pattern-first (chaining/routing/sectioning/voting/…).
   Strawman: pattern-first §1, shape-first §2, but the right ratio is
   judgement-call.

5. **Reference vs. tutorial?** The current skill is reference-shaped
   (every attribute documented). Some sections (anti-patterns,
   smoke-test recipe) lean tutorial. The rewrite could split — a tight
   reference SKILL.md + a `references/recipes.md` for the
   pattern-by-pattern tutorial. Mirrors how validator codes already live
   in `references/validator-codes.md`.

---

## Sketch of the eventual rewrite scope

A non-binding draft order, assuming the open questions above settle in
favour of (1) DOT as authoring-sugar, (2) two skills, (3) typed DOT
deferred to SDK-only, (4) pattern-first, (5) split into SKILL + recipes.

1. **§1 Pick the pattern first** — rosetta of Anthropic patterns →
   swarm shapes, ~1 page.
2. **§2 The shape vocabulary** — current §1, lightly revised.
3. **§3 Node attributes** — current §2 + `output_schema`, env block,
   edge-level overrides moved to §6.
4. **§4 Tool nodes** — current §3, unchanged.
5. **§5 Substitution tokens** — current §4 + `$<id>.stderr`, drop the
   not-implemented table.
6. **§6 Thread-id and edge attributes** — current §5 + edge-level
   `thread_id` / `fidelity`; cross-reference research.dot pattern.
7. **§7 Edges and conditions** — current §6 + extended operators,
   bare-key truthiness, no-implicit-fail callout.
8. **§8 Loops** — current §7 (G2 fixed; minor annotation).
9. **§9 Goal gates** — current §8 + `paused{reason:"max_retries"}`
   resume path.
10. **§10 Parallel + fan_in** — current §9, rewritten: HITL-in-branch
    supported, G3 LLM fan-in, voting subsection.
11. **§11 Models, providers, validation** — current §10 + add-model
    cheat.
12. **§12 Fidelity, context_files, environment block** — current §11
    + env block teach.
13. **§13 Prompts that behave** — current §12 + `context_set` and
    `emit_output` alongside `abort`.
14. **§14 Wait.human** — current §13, minor.
15. **§15 Graph-level attrs** — current §14, unchanged.
16. **§16 Validation** — current §15, point at references/validator-codes.md.
17. **§17 Smoke-test recipe** — current §16, unchanged.
18. **§18 Anti-patterns** — current §17 + 4 new article-level entries.
19. **§19 Cheat sheet** — current §-bottom, updated for new tools and operators.

Plus a new `references/recipes.md` with worked examples for each
Anthropic pattern (chain, route, section, vote, orchestrator-workers,
evaluator-optimizer), mirroring how validator codes already extract to
a sibling references file.

---

## Doc updates required (when the rewrite lands)

Per AGENTS.md ground rule #1, the skill is the same-PR doc obligation
target for several primitives. The rewrite *itself* is the doc update;
no other docs change in that PR.

---

## Out of scope (deferred)

- Editing `.agents/skills/swarm-author/SKILL.md` prose now. The references
  file is fair game for same-PR updates during G3/G5; the prose waits.
- Touching the `.claude/skills/swarm-run/SKILL.md` (already fixed in the
  current orchestration with the runStatus/status disambiguation).
- The eventual `swarm-sdk-author` skill — gated on the SDK proposal
  shipping.

## When to land

After all of:
1. JSON IR canonical proposal ships (currently at maturity: designed).
2. `@swarm/sdk` brainstorm crystalizes into a proposal.
3. The typed-context direction has a concrete shape (proposal or
   strawman doc).
4. The open questions above are settled.

Estimated: not before the JSON IR flip lands. The skill quotes
mechanics that change under JSON IR; rewriting now risks a third pass.
