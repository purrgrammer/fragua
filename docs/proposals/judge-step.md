---
title: Judge steps — deterministic typed judgments (classify / score / verify / route) without an agent turn
summary: "A `type: judge` step asks a System One model (TypeSafe's Jev) a map of narrow, typed questions — `choice`, `score`, `noul` — over a `state:` assembled from `${{ inputs.* }}`, `${{ outputs.* }}`, literal text, and bounded read-only worktree files. One HTTP call, no tools, no thread, no agent loop; answers arrive as calibrated probabilities in well under a second at ~$0.00002 per call. The step produces typed `outputs:` derived from its `questions:` (never authored), so `${{ outputs.<judge>.<q>.choice }}` and friends ride the shipped structured-outputs spine unchanged. One optional `decide:` block turns a judgment into control flow deterministically: `decide.route` keys edge selection on a `choice` answer (with a confidence floor and a declared fallback route), and `decide.outcome` thresholds a `noul` into `success` / `fail` so `goal_gate` and `retry:` compose unchanged. No new fact type, no reducer change, no `EVENT_CONTRACT_VERSION` bump; a new `NodeType`, a pre-wired `ctx.judge` client, one credential row, and validator codes E047–E048 / W020–W021."
status: proposal
maturity: draft
last-reviewed: 2026-09-17
---

# Judge steps

> **Status: in-progress — MVP built, unreviewed.** Parser (`type: judge`, derived
> outputs, `decide:`), validator (E047/E048, W020/W021, fan-out admission),
> handler + `ctx.judge` client, `typesafe` credential row, `judge_node` message
> row + web rendering, `TYPESAFE_API_KEY` seeding for `fragua ci`, and
> `fragua providers test typesafe` are in. Verified end to end: a judge-only
> workflow under `fragua ci` routed on a live Jev `choice` and a downstream
> `tool` step read `${{ outputs.<judge>.* }}`. Not yet run against a shipped
> workflow (§8.1 experiments). Design claims below are still candidates. The one experiment behind it: the routing + gate decision a fragua
> `llm` step spends a full agent turn on today came back from Jev in 0.74 s for
> 498 input tokens with a correct answer and a calibrated distribution.

## 1. The problem

Four judgment shapes recur in nearly every workflow under `.fragua/workflows/`:

| Shape | Where it shows up today | How it is built today |
|---|---|---|
| **Classify → route** | `review.yaml` `classify` (skip / quick / full), `work.yaml` triage | An `llm` step with `routes:`; the backend synthesises a `route` tool; the model reads context, writes prose, then calls `route({name})`. A whole agent turn, a model that can call tools, and two structural halt reasons (`route_not_picked`, `route_call_not_isolated`) exist only to police the exit. |
| **Yes / no verify** | `review.yaml` `verify` ("reply EXACTLY `APPROVE` else abort with REJECT") | An `llm` step whose success/fail contract is a magic string in prose plus a self-`abort`. `goal_gate` composes with it only because `abort` maps to `outcome=fail`. |
| **Score / rank** | severity calibration, "how risky is this change", picking the best of N fan-out branches | Either folded into prose the next step re-parses, or emitted through `emit_output` after a reasoning turn. |
| **Confidence-gated escalation** | "if unsure, ask the operator" | Authored as a prose instruction to a model that has no calibrated notion of its own uncertainty; the fallback is another `abort`. |

Each of these is a *decision*, not a *generation*. Running them through a
text-generation agent costs a turn (seconds to minutes, cents to dollars),
hands control flow to prose ("state the deciding factor in one line first"),
and gives fragua nothing it can threshold — a `route` call carries no
probability, an `APPROVE` string carries no margin.

TypeSafe's System One model returns exactly the missing thing: a typed answer
plus a probability distribution, in one stateless HTTP call, with **code owning
the control flow** ("Keep control flow, deterministic rules, and side effects in
code" — TypeSafe *how-to-build*). That is fragua's own stance: the graph is the
control flow; a step supplies a fact. A judge step lets the graph branch on a
calibrated judgment without an agent in the loop.

## 2. The primitive, grounded

### 2.1 The API contract this leans on

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`.
Request: `{ model, state, questions }`. Response: `{ model, answers, usage }`.

| Question `type` | Author writes | Answer carries |
|---|---|---|
| `choice` | `instructions` + `criteria`: a **map** `option_id → description` (keys are the option ids returned; ≤ 255 options; docs recommend an explicit `other` when the list may not cover every input) | `choice: string`, `probabilities: {option_id: p}` (sums to 1), `confidence: 0..1` |
| `score` | `instructions` + `criteria`: an **ordered list** of level descriptions (a map is a 422 — hit live) | `score: number` (probability-weighted index), `legend: {"0": label, …}`, `probabilities: {"0": p, …}`, `confidence` |
| `noul` | `instructions` (+ optional `criteria: {true: …, false: …}`) | `noul: 0..1` — the probability of *yes*. **No confidence field**: a noul near 0.5 means "yes and no are similarly likely", not "medium intensity". |

`state` is text only: a string, a JSON object, or an array of text values.
Facts go in `state`; the judgment goes in `instructions`; the possible answers
go in `criteria`. Instructions may reference nested state with backticked
paths (`` `diff.stat` ``). Questions in one request are evaluated independently
and in parallel — one primitive's answer is never hidden context for another —
and "adding questions barely changes the response time", so the idiom is *one
request, many narrow questions*.

`model: jev-latest` resolves to a versioned id (`jev-1.13.0` today) echoed in
the response. Pricing: $0.042 per million input tokens, output free. Limits
(dynamic, per the docs): 1,200 req/min, 250k tokens/s. Errors: 401 bad key,
422 request shape, 429 / 529 back off.

### 2.2 The experiment

State: a run's goal ("fix the flaky OCC test so CI stops failing
intermittently"), a diff summary ("added a 50 ms sleep before the second write
in the test; no store changes"), and `ci_result: passed 3/3`. Three questions.

```json
"route":    {"type":"choice","choice":"revise","confidence":0.98,
             "probabilities":{"accept":0.01,"revise":0.99,"escalate":0.0}},
"goal_met": {"type":"noul","noul":0.18},
"risk":     {"type":"score","score":0.0,"confidence":1.0,
             "legend":{"0":"trivial, test-only…","1":"moderate…","2":"high…"},
             "probabilities":{"0":1.0,"1":0.0,"2":0.0}}
```

0.74 s, 498 input tokens, ≈ $0.00002. It called the sleep a symptom patch
(`revise`, `goal_met` 0.18) and rated the risk trivial because only a test
changed. That is the `review.yaml` `verify` + `classify` decision, made without a
turn, with margins fragua can threshold.

## 3. Shape (DSL)

```yaml
steps:
  verify:
    type: judge
    state:
      review: {file: review.md}                 # bounded read-only worktree file (§3.2)
      focus:  ${{ outputs.resolve.focus }}      # typed upstream output, fail-closed
      pr:     ${{ outputs.resolve.pr }}
    questions:
      schema_ok:
        type: noul
        instructions: Does `review` follow the required schema — a Scope section naming lens coverage, Defects and/or Improvements (or "All clear"), and a Next steps section?
      calibrated:
        type: noul
        instructions: Are severities in `review` calibrated — no `low` on a data-loss claim, no `critical` on a nitpick, quality items under Improvements rather than Defects?
      depth:
        type: score
        instructions: How thoroughly does `review` cover the change described by `focus`?
        criteria:
          - superficial — restates the diff, no reasoning about behaviour
          - adequate — covers the main paths with at least one concrete finding or an explicit all-clear
          - thorough — covers main and edge paths, findings cite path:line
    decide:
      outcome: {question: schema_ok, min: 0.7}   # noul → success / fail (§3.4)
    retry: synthesize                            # `retry:` = goal-gate + retarget, as today
    max-retries: 2
    next: signoff
```

```yaml
  classify:
    type: judge
    state:
      diff_stat: ${{ outputs.resolve.diff_stat }}   # produced upstream (§3.2 on provenance)
      paths:     ${{ outputs.resolve.paths }}
      focus:     ${{ outputs.resolve.focus }}
    questions:
      size:
        type: choice
        instructions: Size the change for review depth from `diff_stat` and `paths`.
        criteria:
          skip:  doc-only, typo, whitespace, comments, generated files, version bump — no semantic code change
          quick: one concern, ≤ ~150 changed lines, no schema / auth / concurrency surface
          full:  anything else, or any change touching schema / auth / concurrency
    decide:
      route: {question: size, min-confidence: 0.6, below: unsure}   # §3.3
    routes:
      skip:   {to: signoff,       label: "Trivial"}
      quick:  {to: review_quick,  label: "Quick review"}
      full:   {to: prep_diff,     label: "Full review"}
      unsure: {to: ask_operator,  label: "Ask"}         # the below-threshold landing (may also be a criteria key, e.g. `below: full`)
```

A judge step is a **deterministic, read-class, turn-less** node:

- No `prompt:`, no `thread:`, no `allowed-tools:` / `skills:` / `mcp-servers:` —
  it cannot call tools and does not join a conversation. E047 rejects agent-only
  attrs on a judge.
- `state:` + `questions:` are required. `model:` defaults to `jev-latest`;
  `provider:` defaults to `typesafe` (the only implementation in this cut).
- Ordinary graph attrs apply unchanged: `next:` / `on:` / `routes:`,
  `goal-gate`, `retry:` / `max-retries`, `retry-policy`, `timeout-minutes`
  (default `maxMs` 30 s), budget attrs.
- The control-flow bindings live under one reserved `decide:` key
  (`decide.route` / `decide.outcome`, §3.3 / §3.4) rather than as bare step
  keys: `outcome` is already an enum attr in the parser's `ENUM_KEYS`
  (`success | fail`, the edge discriminator) and would be coerced as a scalar,
  and a bare `route:` one letter from `routes:` on the same node is an
  authoring trap. One key, no collision.
- It **produces** typed `outputs:` (§3.5) and **consumes** `${{ inputs.* }}` /
  `${{ outputs.* }}` in `state:` string leaves, fail-closed like every other
  consumer: an unpopulated `${{ outputs.X.f }}` is `outcome=fail` with the
  resolver's message as `failureReason`, never a silent `""`.

### 3.1 `questions:`

A map of question id → question. Ids are identifiers
(`^[a-zA-Z][a-zA-Z0-9_]*$`, the same rule as `outputs:` keys, because they
become output keys). Each question has `type: choice | score | noul`,
`instructions` (string, or a mapping — TypeSafe accepts structured
`{question, focus, note, inspect, compare}` instructions and structured
`{what, not_for, examples}` option rubrics; the parser passes YAML mappings
through as JSON), and `criteria` per the API table in §2.1. The parser
enforces the shape the API enforces (choice: map; score: list of ≥ 2; noul:
optional `{true, false}` map) so the 422 the author would otherwise get at
run time lands as a parse error (E048) with a line number.

Question ids are for the graph and are **not** sent to the model (the API
sends only `type` / `instructions` / `criteria`), so `instructions` must
carry the whole meaning — the validator cannot check that, but the docs are
explicit about it and the workflows skill should say so.

### 3.2 `state:` — provenance is the whole constraint

A judge has no tools and no thread. Everything it judges must already be
*addressable* from the graph. `state:` is a string or a mapping whose leaves
are one of:

| Leaf | Resolves to | Notes |
|---|---|---|
| literal text | itself | `${{ … }}` tokens substitute; a bare `$x` is literal |
| `${{ inputs.<name>[.<f>] }}` | the run input | lenient dotted reads, as everywhere |
| `${{ outputs.<step>.<f> }}` | a typed upstream output | **fail-closed**; a record/array leaf interpolates as JSON text (the API takes text values) |
| `{file: <cwd-relative path>}` | the file's UTF-8 content from the run's worktree via `ctx.env` | read-only, resolved at dispatch, bounded by `state-max-bytes` (default **64 KiB**, hard cap 1 MiB; the cap covers the whole serialised `state`, not just files). A missing or oversized file is `outcome=fail` with a named reason. The default is small on purpose: Jev bills input tokens (64 KiB ≈ 16k tokens ≈ $0.0007, so cost is not the reason) but the docs are explicit that extra context degrades judgment ("include only the context relevant to the current questions"). W021 warns when a literal `state:` exceeds 16 KiB; authors opt up with `state-max-bytes`. Path must be relative and may not escape the worktree (`..`, absolute, symlink out) — a parse error for the static cases, the same `fail` at dispatch for the dynamic ones. |

That third row is the honest answer to "how does `classify` get the diff":
today `classify` runs `git diff` inside an llm turn, and **nothing in the graph
produces the diff as an output**. So a judge cannot replace that step by
itself; the graph has to *make the material addressable* first. Three ways,
in order of preference:

1. **An upstream llm step emits it as `outputs:`** (`resolve` already emits
   `diff_spec` / `paths` / `focus`; adding `diff_stat` is a one-line change to
   its `outputs:` block). Right for small, typed material.
2. **A file in the worktree** — `{file: review.md}` — for anything an upstream
   step already writes to disk (`synthesize` writes `review.md`; the `verify`
   example above judges it). Right for prose bodies.
3. **A `tool` step that writes a file the judge reads** — `tool → judge` with
   no model turn, expressible today:

   ```yaml
     diff_stat:
       type: tool
       run: git diff --stat --end-of-options ${{ outputs.resolve.diff_spec }} > .fragua/judge/diff_stat.txt
       next: classify
     classify:
       type: judge
       state: {diff_stat: {file: .fragua/judge/diff_stat.txt}}
   ```

   The file is the channel. **This is the proof-of-concept bridge, not the
   intended end state**: the file name is untyped plumbing the author has to
   keep in sync at both ends, and it lives in the worktree (under `.fragua/`,
   so `accept` never stages it — the tool step must write inside the run's
   worktree, never a shared path, or parallel runs collide). The typed form is
   [`tool-outputs.md`](tool-outputs.md) — `state: {diff_stat: ${{ outputs.diff_stat.stat }}}`
   — which is **unreviewed with a blocking finding (B2)**. Sequencing decision:
   ship the judge on the file bridge, use it as tool-outputs' first real
   consumer, and swap the bridge for typed outputs when that proposal lands.
   Reservation on record: the file bridge was accepted for the PoC, not loved.

Deliberately **out** of this cut: a `command:` state source (a shell in the
judge re-creates the `tool` step with worse isolation), and thread-as-state
(`${{ thread.<id>.last }}` — no such token exists today; §9 door).

Substituted output values are **not** nonce-wrapped in `state:`. The
hash-boundary wrapping in structured-outputs §6 defends a *prompt* against an
output that impersonates instructions; here the model receives instructions
only through `questions:` and the API keeps `state` and `instructions` as
separate fields, so the injection surface the wrapping closes does not exist.

### 3.3 `decide.route` — a `choice` answer drives edge selection

```yaml
decide:
  route: {question: <id>, min-confidence?: <0..1>, below?: <route-name>}
routes: { … }
```

- `question` must name a `choice` question (E047). Its `criteria` keys must be
  a subset of the declared `routes:` names, every `routes:` name must be
  either a criteria key or the `below:` route, and `below` must be in
  `routes:` — it **may** coincide with a criteria key (`below: full` = "when
  torn, go deeper") (E047; E021 already demands every route be discharged by
  an edge).
- On completion the handler returns `transition{ route: answer.choice }` and
  the existing **route-case** edge selector (`edge-selection.ts`) picks the
  edge. Nothing new in the engine.
- `min-confidence` applies to `answer.confidence` (a distribution-concentration
  statistic, 0..1). Below it, the handler returns `route: <below>` instead.
  `below` must be declared in `routes:` and is typically a `human` step (the
  TypeSafe *confidence-routing* pattern: "the answer tells you what; confidence
  tells you whether to act" — escalate uncertain cases to a person). Setting
  `min-confidence` without `below` is a parse error. Omitting both means "always take
  the choice", which is right for harmless preferences where a spread
  distribution is fine.
- `min-confidence` is **only** defined for `choice` (and `score`, unused here)
  because noul has no confidence. A noul-driven branch is `decide.outcome` (§3.4),
  a two-way `routes:` is not offered for it — an author who wants three-way on
  a yes/no should ask a three-option `choice` with an explicit `other`.
- The chosen route is persisted on `fact.node_completed.payload.route` exactly
  as the llm `route` tool's is today, so the UI's route rendering and the
  `E021` discharge check work unchanged. The two llm-only halts
  (`route_not_picked`, `route_call_not_isolated`) cannot occur: a judge either
  has an answer or fails as a provider/validation error.

Why `below:` is a **route** and not a pause: an earlier sketch had the judge
itself yield `paused_human` with the candidates as options. That makes a
deterministic node pausable (complicates the read-class story for fan-out, §9)
and adds a pause-reason arm for what the graph can already say. Declaring the
landing in `routes:` keeps the control flow *in the graph*, reuses the human
step and its `intent.human_input` protocol, and costs nothing new.

### 3.4 `decide.outcome` — one or more `noul` answers become success / fail

```yaml
decide:
  outcome: {question: <id>, min: <0..1>}            # one noul
  outcome: {questions: [<id>, <id>, …], min: <0..1>} # several — every one must clear min
```

- Each named question must be a `noul` (E048, per entry). `min` is the
  probability floor for `success`: every listed `noul ≥ min →
  outcomeStatus: "success"`, else `"fail"` with `failureReason` naming the
  ones that fell short (`"bar_held=0.41 < min 0.6"`).
- **Prefer several narrow nouls over one composite.** In the first full-tier
  experiment a single "does the review pass ALL of (1) (2) (3)" noul sat at
  0.48 on a review whose three narrow checks scored 0.74 / 0.62 / 0.78. A noul
  near 0.5 means "yes and no are similarly likely", so a conjunction phrased as
  one question degrades toward undecided as it grows. The all-of list keeps
  each judgment atomic (the docs' central design rule) and gates on the
  weakest one.
- Everything downstream is the shipped **outcome-case** machinery: `on:
  {success, fail}` edges, `goal-gate: true`, `retry: <step>` / `max-retries`,
  the `paused{reason:"goal_gate"}` cap. The `review.yaml` `verify` step loses its
  "reply EXACTLY `APPROVE`" contract and its `abort` and gains a number the
  operator can tune.
- `decide.route` and `decide.outcome` are **mutually exclusive** (a parse error): a routing node's
  edges are route-keyed, an outcome node's are outcome-keyed; one node cannot
  be both (this is the existing `routes:` ⊕ `on:` rule, restated for the two
  bindings). A judge with no `decide:` is a pure producer that always succeeds
  and hands its outputs forward through `next:`.

`min` is the author's policy knob and the docs are explicit that thresholds
"depend on your domain and the model's performance for your use case" — start
conservative, tune on real runs. Raising or lowering `min` is a workflow edit,
never a re-inference; the raw `noul` is on the outputs (§3.5) and in the log.

### 3.5 Derived `outputs:` — never authored

A judge's typed `outputs:` decl is **derived from `questions:`** by the parser
and stored on `attrs.outputs` like any other producer's. Authoring `outputs:`
on a judge is E047 (the existing "outputs are llm-only" error keeps firing for
authored blocks on non-llm steps; the derived decl is attached after that
check). One record per question, over the shipped profile grammar (scalars,
`choice`, records via `fields`, arrays via `items`):

| Question | Derived record |
|---|---|
| `choice` | `{choice: choice(<criteria keys>), confidence: number, probabilities: {fields: {<key>: number …}}}` — keys must be identifiers (parse error otherwise) so `${{ outputs.j.q.probabilities.accept }}` is a valid dotted read |
| `score` | `{score: number, level: number, confidence: number, probabilities: array<number>}` — `level` is the argmax index, `probabilities[i]` is the probability of level *i*. The API's `legend` / `probabilities` keys are the string digits `"0"`, `"1"`… which are **not** valid field identifiers, so the handler re-indexes them into a positional array; the labels are already in the workflow |
| `noul` | `{noul: number}` |

The handler returns `transition{ outputs }` and the executor writes them to
`fact.node_completed.payload.outputs` + the `outputs` index in the same
transaction — the spine that `${{ outputs.X.f }}`, blob spill, E035 / W015
reachability, and the run-level `outputs:` projection already ride. **No
reducer change.**

**This reverses the `outputs:` ⊕ `routes:` exclusivity — for `judge` only.**
The parser rule at `yaml.ts:662` exists because `route` and `emit_output` are
both *turn-terminating tool calls*: an llm cannot make two terminal calls in
one turn. A judge has no turn; its route and its outputs come from the same
response. `fact.node_completed` already declares `route?` **and** `outputs?`
as independent optional fields (ARCHITECTURE §3), so a fact carrying both is
already in-contract; the reducer and read plane fold each independently. The
exclusivity stays for `llm` steps, where the reason still holds.

### 3.6 Cost, observability, the message row

- **Cost.** `costUsd = usage.input_tokens × 0.042 / 1e6`; output tokens are
  billed at 0. `tokens = input + output`, `inputTokens` / `outputTokens` set,
  cache buckets unset (the API has none). `modelName` is the **resolved** id
  from the response (`jev-1.13.0`), not the alias the author wrote, so a replay
  or a post-mortem knows which model produced a distribution. One
  `cost.recorded` per call, folded into `run_state.metrics` like any llm cost;
  budget attrs and `budgetSnapshot` apply unchanged. Pricing is a per-provider
  constant in the client, not a per-model table, until a second System One
  model exists.
- **Observability.** Two new types, `judge.requested {nodeId, model, questionIds,
  stateBytes}` and `judge.answered {nodeId, model, durationMs, answers}` — the
  answers are small and typed, so they ride the event inline (a 255-option
  choice is the one shape that could approach the 4 KiB cap; the emitter
  truncates `probabilities` to the top 32 and flags it). Both go in
  `EventType` **and** `ALL_EVENT_TYPES` (a CI test pins the pair). The
  read-plane's `fact.node_completed.outputs` is the canonical record; these are
  for the live SSE view.
- **Message row.** The conversation view needs something to render for a judge
  (today a `tool` node appends a `tool_node`-role row with command / exit code /
  tails). Add a `judge_node` role to the `AgentMessage` declaration merge in
  `@fragua/types` carrying `{ model, state_preview, questions, answers,
  durationMs }`. Named here; its rendering is a `@fragua/web` follow-up (§8).

## 4. Execution

### 4.1 Handler

`packages/core/src/handler/handlers/judge.ts`, `makeJudgeHandler(cfg)`,
registered by `specForNode` for `kind === "judge"` (`auto-dispatcher.ts`).
`sideEffect: "idempotent"` — an external read with no provider-side state; no
`externalCall` envelope (llm calls don't use one either), no idempotency key.
`maxMs` from `timeout-minutes` else 30 s (the call is sub-second; the margin is
for 429/529 backoff). Steps:

1. Resolve `state:` — substitute string leaves (`substitute()` with
   `escapeForShell: false`), read `{file}` leaves through `ctx.env` (fail
   closed on missing / oversized / escaping paths), serialise to the API's
   `state` (a string stays a string; a mapping becomes a JSON object). A
   `{file}` leaf with `ctx.env === undefined` halts `reason:"error"` exactly
   as the tool handler does — never a `process.cwd()` fallback.
2. `await ctx.judge.ask({ model, state, questions }, ctx.signal)`.
3. Map answers → derived outputs (§3.5); apply `decide:` — `route` (§3.3) or
   `outcomeStatus` (§3.4).
4. Append the `judge_node` message; emit `judge.answered` + `cost.recorded`.
5. Return `transition{ route? | outcomeStatus?, failureReason?, outputs, tokens,
   costUsd, inputTokens, outputTokens, modelName }`.

Handler discipline holds: no bare `fetch`, no `node:fs` — the client is on
`ctx`, files come through `ctx.env`. `discipline.test.ts` already scans
`handlers/`.

### 4.2 `ctx.judge` and the provider

A pre-wired, **optional** `ctx.judge?: JudgeClient` on `HandlerContext`
(`ask(req, signal)`; optional like `ctx.env?` so existing context builders and
tests keep compiling — the handler halts `reason:"error"` when it is absent),
built in `executor-deps.ts` (the shared executor assembly behind `daemon` and `ci`) from
the credential row `provider_credentials('typesafe', kind='api_key')`. Absent
credential → the handler halts `reason:"error"`, detail "provider typesafe
not credentialed — `fragua providers set typesafe`" (a run that reaches a judge
with no key is an operator error, not a retry).

| API status | Handler result |
|---|---|
| 200 | `transition` |
| 401 / 403 | `transition{outcomeStatus:"fail", non-retryable}` — same class as an llm auth failure |
| 422 | `halt{reason:"error", detail: <API detail>}` — a request shape E048 should have caught; surfacing the API's own message makes the validator gap visible |
| 429 / 529 | in-client full-jitter backoff (3 attempts, `Retry-After` honoured when present); on exhaustion `pause_provider{httpStatus, provider:"typesafe", errorMessage, retryAfterMs?}` — the existing recoverable pause |
| network / abort | `pause_provider{httpStatus:null}` / propagate the abort |

**Dependency: none.** The contract is one endpoint with three question shapes;
a ~120-line client over the injected `fetch` is smaller than the SDK's error
hierarchy. `@typesafe-ai/sdk` 0.6.0 (Node ≥ 20, retries built in) is the
alternative if the contract grows — one exact pin plus a rationale line, per the
no-silent-deps rule.

**Credentials.** `fragua providers` today means pi-ai providers, and `typesafe`
is not one — Jev is not a chat model and never enters `ModelRegistry`. The
`set` / `ls` / `test` verbs gain a `typesafe` id that reads and writes the same
`provider_credentials` table (`test` makes one `noul` call and prints the
resolved model id + latency). `env-creds.ts` seeds it from `TYPESAFE_API_KEY`
for `fragua ci`, and that var joins the always-strip set so a CI env leak cannot
reach a tool step's shell.

### 4.3 Replay and determinism

Determinism is a property of the folded log, not of re-execution (structured-
outputs §1). The answers land on `fact.node_completed`; a replay folds them, it
does not re-ask. Re-execution happens only on abort mid-flight / crash-replay,
and a second Jev call may return a slightly different distribution — the same
posture as re-running an llm step, and benign: the *recorded* decision is what
the run took. `sideEffect: "idempotent"` states it.

## 5. Parser, IR, validator

**`NodeType` gains `"judge"`** — an enum-literal union (ground rule 1), so
every consumer is swept, not just the sites TypeScript narrows:

| Site | Change |
|---|---|
| `types/graph.ts` `NodeType` | add `"judge"` |
| `parser/yaml.ts` `KNOWN_TYPES`, per-kind attr gates (`outputs` llm-only at :654, `mcp_servers` llm-only at :679), `STEP_RESERVED` (+ `state`, `questions`, `decide`, `state-max-bytes`) | parse `judge`; derive `attrs.outputs` from `questions:`; `decide` is parsed as a mapping *before* the generic attr pass so `ENUM_KEYS["outcome"]` never sees it |
| `parser/yaml.ts` `ENUM_KEYS["kind"]` | **leave.** Nothing under `packages/` reads `attrs.kind` (only comments mention `kind=human`); the enum coerces a legacy attr no shipped workflow sets |
| `engine/validator.ts` "no success successor" check (:493, `llm`/`tool` only) | admit `judge` — a judge with no `next:` / `on:` / `routes:` dead-ends the same way |
| `engine/validator.ts` E041 (branch nodes must be `llm`) | admit `judge` beside `llm` — a judge is read-class by construction (no tools; `{file}` is a read through `ctx.env`), so E042/E043 have nothing to check on it. The fan-out kernel dispatches it like any branch node; the join reads `${{ outputs.<judge>.<q>.score }}` per branch. Fan-out property suite gains a judge-branch case |
| `daemon/transition-planner.ts` :1017 (operator note cleared after an `llm` success) | unchanged, intentional — a judge never consumes an operator note, so it must not clear one. Consequence, accepted: in `human → judge → llm` the note reaches the llm two steps late, which is still the next llm |
| `docs/ARCHITECTURE.md` §3 `fact.node_completed` row (:185) | reword: `route?` "present iff … the llm agent exited via the synthesised `route` tool" and `outputs?` "emitted via `emit_output`" gain "… or a `judge` step's `decide.route` chose it" / "… or derived from a `judge` step's answers". Payload shape unchanged; the prose is what goes stale |
| `docs/SPEC.md` §3.1 kind table, §3.6, §3.8 | add the `judge` row; the route-case gains a second producer; derived outputs |
| `daemon/auto-dispatcher.ts` `specForNode` | `case "judge"` |
| `daemon/auto-dispatcher.ts` `defaultMaxMs` per kind | `judge` default 30 s; config `timeouts.judge` |
| `web` `GraphView.tsx`, `NodeInspector.tsx`, `RunConversation.tsx`, `CostInspector.tsx`, `lib/node-icons.ts`, `lib/file-tree.tsx` | a node-kind icon / label / inspector panel; `RunConversation` renders `judge_node` rows |
| `.agents/skills/workflows/SKILL.md` | the authoring guidance (§7) |

**`ir_version`.** The precedent is explicit in `ir.ts`: v2 (per-step
`outputs:`) and v3 (run-level `outputs:`) each bumped for an *additive* field
with an identity converter, and `workflow-ir.md` §8 defers the sha freeze
precisely because "every new semantic node type / attr" moves the IR. A new
`NodeType` plus new node attrs is that case. **Bump to v4 with an identity
converter** (a v3 IR contains no judge nodes and is executor-equivalent at v4).
No `EVENT_CONTRACT_VERSION` bump: no new fact type, no changed payload shape,
no reducer change — `route?` and `outputs?` on `fact.node_completed` are
already there. `MIN_COMPATIBLE_CONTRACT_VERSION` does not move.

**Validator codes** (continuing from E046 / W018). Shape errors — an
agent-only attr on a judge, a malformed question, a bad `state:` leaf, a
malformed `decide:` — are **parse errors** with a line number (the same tier
as an authored `outputs:` on a tool step), not coded diagnostics; the codes
below are the cross-attribute rules a well-shaped graph can still break:

| Code | Rule |
|---|---|
| E047 | `decide.route`: names an undeclared question or a non-`choice`; `decide.route` without `routes:` (or `routes:` on a judge without `decide.route`); an option with no route; a route that is neither an option nor `below`; `below` not in `routes:` |
| E048 | `decide.outcome`: names an undeclared question or a non-`noul`; `decide.outcome` together with `routes:` |
| W020 | a routed `choice` with ≥ 3 options and no `min-confidence` — the confidence axis is free and the author is discarding it (advice, per the docs' "thresholds scale with risk") |
| W021 | literal `state:` text exceeds 16 KiB — extra context degrades judgment; trim it or raise `state-max-bytes` deliberately |

E035 / W015 (broken / not-on-every-path output refs) cover a judge's derived
outputs with no change, because the decl is on `attrs.outputs` like everyone
else's.

## 6. Worked example: `review.yaml` `verify`, before and after

Before — verbatim from `.fragua/workflows/review.yaml` (prompt items
abbreviated), an `llm` with a prose contract; `retry:` is the
goal-gate-and-retarget shorthand (SPEC §3.4):

```yaml
  verify:                              # full tier — automated evidence-quality gate over review.md
    type: llm
    effort: low
    retry: synthesize                  # REJECT ⇒ re-synthesise (capped)
    max-retries: 2
    allowed-tools: [read, grep]
    next: signoff
    prompt: |
      Read `review.md` (cwd-relative) — the review under gate. Judge on its own merits.
        1. Every finding's path:line is verifiable — spot-check 3 by reading the cited path.
        2. Severity calibration sane (…)
        3. Schema followed — (…)
        4. A TIGHT, blocker-focused review is CORRECT. (…)
      All pass → reply EXACTLY `APPROVE`. Else `abort` with `REJECT: <one-line worst violation>`.
```

After — the §3 `verify` judge. Same `retry: synthesize` / `max-retries: 2` /
`next: signoff`, no tools, no turn, and the pass bar is `min: 0.7` on
`schema_ok` with `calibrated` and `depth` recorded alongside for the operator
(and for `signoff`'s `text:` — `${{ outputs.verify.depth.level }}` is a legal
read). One check does **not** survive the move: item 1, spot-checking cited
`path:line`s against the repo, needs evidence the graph does not hold — exactly
what a judge cannot gather (§7). It stays in an llm step, or `synthesize`
emits the cited spans as an output the judge verifies against. A real cost of
the primitive, stated up front. What else the operator loses: the one-line `REJECT:` reason a reasoning model
would write. What the run gains: a threshold instead of a magic string, a
distribution instead of a bit, and a gate that costs ~$0.00002 and 1 s
instead of a haiku turn. Whether the noul's *accuracy* on this rubric is good
enough is exactly the thing to measure on the next twenty `review` runs before
flipping the workflow — the docs say the same ("validate their performance in
the target domain").

The `classify` step is the same shape (§3) **once `resolve` emits
`diff_stat`** — that is a one-line `outputs:` addition to `resolve`, and the
worked example in §3 assumes it.

## 7. Authoring guidance (for the `workflows` skill)

- **Ask narrow questions; ask many.** One request, independent questions;
  decompose "is this review good" into schema / calibration / depth. Each
  answer is addressable; code (the graph) composes them.
- **Facts in `state:`, judgment in `instructions`, answers in `criteria`.**
  Never put the rubric in `state`.
- **Reference state by path.** `` `review` ``, `` `diff.stat` `` in
  `instructions`, so a multi-field state is unambiguous.
- **Give `choice` an `other`** when the input may not fit; give a routed
  `choice` a `below:` landing and a `min-confidence`.
- **Noul ≈ 0.5 is "undecided", not "medium".** Threshold it with `decide.outcome.min`;
  if you need a three-way, ask a `choice`.
- **Keep the reasoning model for reasoning.** A judge cannot read the repo, run
  a command, or explain itself. It replaces the *decision* steps, not the
  *work* steps; when the decision needs evidence the graph doesn't yet hold,
  make an upstream step produce it (`outputs:` or a file) rather than growing
  the judge.

## 8. Scope

**In (MVP):** `type: judge` with `state:` (text / `${{…}}` / `{file}`) +
`questions:` (`choice` / `score` / `noul`, string or structured
instructions/criteria); derived `outputs:`; `decide.route` with `min-confidence` /
`below`; `decide.outcome` with `min`; `ctx.judge` + the `typesafe` credential row +
`fragua providers` verbs + `TYPESAFE_API_KEY` seeding; cost / `judge.*`
observability / `judge_node` message role; judges admitted in `parallel` branches (E041); parser + E047–E048 / W020–W021; `ir_version`
v4 identity converter; `auto-dispatcher` case; web: icon + inspector + message
row rendering; a `--json` `fragua providers test typesafe`.

**Out (doors, §9):** thread-as-state; a
`command:` state source; a second System One provider; `score`-driven routing;
structured (non-stringified) state leaves from record outputs; the SDK dep.

**Tests before done:** parser round-trip incl. derived outputs and IR v3→v4;
validator fixtures per code; handler unit tests with a stubbed `JudgeClient`
(route / below / outcome / fail-closed state / oversized file / 422 / 429
exhaustion → `pause_provider`); `enum-consumers`-style source scan for
`"judge"` across `NodeType` sites; an executor property that a judge fact
carrying both `route` and `outputs` folds identically to today's reducer;
one opt-in live smoke behind `TYPESAFE_API_KEY`.

## 8.1 Experiments — where Jev gets measured first

A survey of the ten shipped workflows (`.fragua/workflows/*`, `~/.fragua/workflows/tech-digest.yaml`)
for pure *decision* steps. Run order is call volume × cleanliness of fit;
each experiment records latency, cost, and agreement with the llm step it
shadows, per §10.

| Order | Step | Today | Fit | Why |
|---|---|---|---|---|
| 1 | `pr_review.verdict` | haiku, `[read]`, `routes: comment \| changes` | **drop-in** | Reads `pr-review.md`, written on every path. Two-key `choice`, no threshold, zero new steps. Highest volume: runs unattended on every CI PR. If this doesn't work, nothing will. |
| 2 | `pr_review.verify` | sonnet / low, `[read, grep]`, `retry: synthesize` | **drop-in** | The §3 / §6 example verbatim. Its one repo read (spot-check cited `path:line`) is redundant on the full tier — five upstream `*_verify` lenses already re-opened every citation. Exercises `decide.outcome` + `retry:`. |
| 3 | `pr_review.scope` → then `review.classify` | sonnet / low, `routes: skip \| quick \| full` | **one-line ×2** | The §2.2 target and the biggest latency win, but needs (i) a `tool` step producing `gh pr diff --stat` (or `diff_stat` on `resolve.outputs` for `review`) and (ii) the `skip` branch's LGTM file write moved to a `tool` step — a judge cannot write. Exercises `decide.route` + `min-confidence` + `below: full`. |
| 4 | `review.verify` | sonnet / low, `retry: synthesize` | drop-in | Same as 2 over `review.md`; second-wave because `review` runs less often than `pr_review`. |
| 5 | `work.triage` | sonnet, `routes: small \| feature \| bugfix` | one-line + a decision | Criteria ("≤3 packages", "shared contracts") need a package map dumped to a file. Its "not a workable task" `abort` has no judge equivalent — **decided:** add a fourth `blocked` option to the `choice` (routed to a terminal `human` or `exit`), so "not workable" is a judged outcome like the other three. Header comment records haiku misrouting 3/3 here, so `min-confidence` is not optional. |

Together 1–3 cover the whole `decide:` surface inside one workflow, so a
single `fragua ci pr_review` run validates the DSL end to end.

Side findings from building the MVP: the executor had `done` / `end` as silent
terminal aliases (a `tool` step named `done` never ran — fixed, only `exit`
terminates); the per-step cost window keyed on `llm.start` only (fixed:
`judge.requested` / `judge.answered` open and close a step).

**Not candidates, though they look like it** (the survey's negative results,
kept so nobody re-derives them): the eleven `*_verify` lens steps in `review` /
`pr_review` / `appraise` (their whole job is opening cited `path:line`s in the
repo and rewriting a variable-length list — tool use plus a per-item fan-out,
neither exists); `work.review` (needs the diff **and** `PLAN_REALISED`, which
lives only in the shared thread — thread-as-state, §9); `drift.verify` and
`tech-digest.shortlist` (the input lives in a thread and the output is a
rewritten document / an N-of-M selection over a list); `propose`'s five panel
`verdict` fields (mechanically derived from a repo-grounded `blocking` array);
every `type: human` gate (the decision is the operator's by design).

**Independent of Jev, surfaced by the same survey:** `drift.collect` and
`tech-digest.collect` are haiku steps that run `bash` and reply exactly
`collected` — `tool` steps in llm clothing; `dependencies.update`'s
`routes: updated | none` reports work it just did and is a
`git diff --quiet` `tool` step with `on: {success, fail}`. Three llm turns per
run that need no model at all.

## 9. Doors — deferred, sound

- **Thread-as-state.** `${{ thread.<id>.last }}` / `.all` tokens exposing a
  shared thread's tail as text, so a judge can gate a conversation. Needs a
  substitution token and a read-plane projection; the summariser makes it
  bounded.
- **`score` routing.** `decide.route: {question: <score>, levels: {0: a, 1: b, 2: c}}` —
  cheap once `choice` routing exists; not needed for the first workflows.
- **Yield-form escalation.** A judge that itself yields `paused_human` with the
  distribution as the operator's options, for graphs that don't want a
  separate `human` step. Only if the route form proves too verbose.
- **Structured state leaves.** Binding a record output into `state` as a JSON
  object instead of JSON text, so `instructions` can path into it. The API
  accepts objects; the substitution resolver would need a non-string mode.
- **SDK.** `@typesafe-ai/sdk` if retries / typing / a second model make the
  hand-rolled client grow past its rationale.

## 10. Risks

- **Accuracy on fragua's rubrics is unmeasured.** One call, one correct answer.
  Shadow mode needs nothing new: a judge with **no `decide:`** is a pure
  producer that always succeeds, so inserting it in front of the existing llm
  `verify` (`synthesize → verify_judge → verify`) records `schema_ok` /
  `calibrated` / `depth` on every run while the llm still decides. After ~20
  `review` runs, compare `outputs.verify_judge.schema_ok` against the llm
  verdict in the log, pick `min`, then swap. Cheap: ~$0.00002 a call.
- **State provenance limits reach.** Until `tool-outputs.md` lands, a judge
  sees only what upstream llm steps emit or write to disk. The two shipped
  workflows' gates already satisfy that; the classify steps need the one-line
  `outputs:` addition.
- **Exclusivity reversal — checked.** `result-to-facts.ts` writes
  `payload.route` and `payload.outputs` independently; the read plane
  (`projections.ts`) reads `route` only to build the HITL decision banner; the
  web reads `payload.route` only for the `→ route` suffix (`humanize.ts`) and the
  `RouteToolResult` card, which keys on the llm `route` *tool call*, not the
  fact. No reader assumes `route ⇒ no outputs`. The §8 property test still pins
  it. One UI consequence: a judge's route has no tool call, so `RouteToolResult`
  never renders for it — the `judge_node` row carries the choice instead.
- **Provider concentration.** One vendor, one model, dynamic rate limits. The
  `provider:` attr and `ctx.judge` seam exist so a second System One backend
  (or a local classifier) is a client, not a redesign.
