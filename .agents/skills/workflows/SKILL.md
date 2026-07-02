---
name: workflows
description: Author or edit a fragua workflow (YAML). Load this when the user says "write a workflow that …", "turn this task into a workflow", "add a step to <wf>.yaml", "why does my workflow fail to validate", "how do I wire a loop / HITL / routing here", or otherwise asks about shaping a workflow under `~/.fragua/workflows/` or `<project>/.fragua/workflows/`. Teaches deliverable-scoped design first, then the GHA-style YAML shape (steps / next / on / routes / inputs / defaults), the four terminal mechanisms, goal-gate vs edge-cycle loops, shared-thread vs environment data flow, idiomatic prompts, validator codes, and a smoke recipe. Assumes Claude Code with Read / Edit / Write and a local fragua repo.
---

# workflows — authoring fragua workflows

A workflow is a YAML file: a small state machine that wires LLM steps, tools, and human gates into a deterministic, replayable pipeline. The author declares **steps** and how they connect; the engine drives them.

Reach for a workflow when:

- the job has 2+ distinct steps with different concerns, tools, or models;
- you want a quality gate that loops back on rejection (review → re-implement);
- you need an explicit human pause point;
- you want the *shape* pinned and inspectable (not re-decided each run).

Reach for a **single `llm` step** (no extra structure) when subtasks aren't known upfront, the task is one bounded tool-use loop, or the shape isn't worth pinning. When in doubt start with one step; promote to a multi-step workflow once you find yourself encoding the flow in prose.

Authoritative: `docs/SPEC.md` §3 (primitives) + §4 (validation), `docs/ARCHITECTURE.md` §3 (events), `docs/execution-model.md` (filesystem layout — where files land, worktree lifecycle, snapshot delta-suppression, accept/discard). Validator codes: `references/validator-codes.md`. Retry presets + advanced attrs: `references/advanced-attrs.md`.

---

## 1. Decide the boundary before you draw

The unit of a workflow is its **deliverable** — what the run produces: a **commit** (code change → `work`), a **report** (analysis / review / drift → `analyze`, `review`, `drift`), **applied edits** (`doc-sync`), or an **action** (`merge`). One deliverable, one workflow.

Within a deliverable, sub-kinds differ only in their **preamble** — the step that frames the work before a shared spine. In `work`: `feature` plans, `bugfix` reproduces a failing test, `small` does neither — then all converge on implement → review → ship. That stays *one* flat workflow.

Three smells that mean you've drawn the boundary wrong:

- **Divergent tail** (one branch skips CI, another commits nothing) → that's a different *deliverable*. Make a separate workflow; don't conditionalise the tail.
- **Divergent parameter** (urgency, target, scope) → that's an *input*, not a branch. `--input urgent=true`, read where it matters.
- **Re-classified-from-a-thread** → classification belongs in the **topology** (the path the run takes), never as a label re-read from a shared thread downstream. A run's position in the graph *is* its classification.

### Classifiers are pure functions

A node that decides *which* branch to take (a `routes:` step, or any triage) is a pure function: **evidence in → one route out**. Give it its own isolated context (no shared thread to pollute its decision) and the cheapest model that gets the call right — scale model strength to the *cost of misclassifying*, not a blanket "cheap". Classify from fresh evidence at the point of decision (e.g. an approval gate reads the diff, not "what triage said").

### Patterns (names from Anthropic's "Building Effective Agents")

- **Augmented LLM** — one `llm` step, broad tool pool, the agent loop lives in its tool-use cycle. `merge`.
- **Prompt chaining** — linear `A → B → C`. `analyze`, `drift`.
- **Routing** — a step declares `routes:` and exits via the `route` tool; edges fan out per route. `work::triage`.
- **Evaluator-optimizer** — a step generates, the next judges, rejection retargets the generator (`retry:`). The daily-driver pattern. `work::review`, `review::verify`.

A real workflow usually **mixes** these — the patterns name the *shape of an edge or step*, not the whole graph. `work` is routing (`triage`) → prompt chaining (`plan → implement → review`) → evaluator-optimizer (`review` retargets `implement`) → tool steps (`format`, `ci`). `review` is routing (`scope`) → a deep review pass (`review_full`) → evaluator-optimizer (`verify` retargets `review_full`). Reach for whichever pattern fits each seam; don't force one over the whole run.

Pick the pattern before drawing; topology follows.

---

## 2. Anatomy of a workflow

```yaml
name: my-thing                 # bare-name identity; `fragua run my-thing`
goal: One-sentence purpose.    # summarisers read this — keep it short
description: |                 # optional prose
  Longer explanation for humans.

inputs:                        # typed run inputs (§3)
  ticket: { type: string, required: true, description: Bug ticket id }

defaults:                      # applied to every llm step that omits the key
  provider: anthropic
  model: claude-sonnet-4-6

budget: 5.00                   # USD ceiling (run-level)
budget-policy: pause           # warn | stop | pause

steps:
  plan:                        # FIRST step = entry point (a `start` node is synthesized)
    type: llm                  # llm (default if omitted) | tool | human | exit
    prompt: |
      Plan ${{ inputs.ticket }}.
    next: implement            # every step names its success successor — no magic

  implement:
    prompt: |
      Implement the plan.
    next: done

  done:                        # terminate by routing to the reserved `exit` sink
    prompt: |
      Summarise what changed.
    next: exit
```

**Step types:** `llm` (default), `tool`, `human`, `exit`. `start` is synthesized from the first declared step — never declare it (E029). `exit` is the reserved graceful-completion sink — target it, don't declare a regular step named `exit` (E028).

**Flow is explicit:** every step declares its success successor via `next:` / `on:` / `routes:`. There is no linear fall-through — a step left without a success successor is a validation error (E032). Terminate a branch by routing to the reserved `exit` sink (`next: exit`).

---

## 3. Inputs — structured, typed, validated

Workflows take **typed inputs**, declared in `inputs:` and referenced as `${{ inputs.name }}` in any `prompt:`, `text:`, or tool `run:` string. There is no free-form `$ARGUMENTS`; everything a run needs is a declared input. (`${{ inputs.name }}` and `${{ outputs.X.f }}` — §6 — are the only two substitution tokens; a bare `$name` is literal.)

```yaml
inputs:
  ticket:
    type: string
    required: true
    description: Bug ticket id
  dry-run:
    type: boolean
    default: false
  env:
    type: choice
    options: [dev, staging, prod]
    default: dev
  config:                                  # object/array reuse the outputs: grammar
    type: object
    fields:
      region: { type: choice, options: [us, eu] }
      flags:  { type: array, items: { type: string } }
```

- Types: `string` | `boolean` | `number` | `choice` (choice requires `options`) | `object` (+`fields`) | `array` (+`items`) — the same restricted grammar `outputs:` uses (§6.5), nesting to any fixed depth.
- `required: true` with no value → enqueue rejected (`400 invalid_inputs`).
- Provide scalars at run time: `fragua run my-thing --input ticket=BUG-1 --input env=prod` (repeatable, gh-style).
- **Object/array inputs:** `--input <name>=<value>` is JSON-parsed when the named input is declared `object`/`array` (`--input flags='["a","b"]'`, or `--input config=@cfg.json` to source from a file); scalar inputs stay verbatim. Pass the whole inputs object at once with `--input-json '{"config":{"region":"eu"}}'` (the programmatic-caller path). Malformed JSON for a declared object/array input is a clean enqueue-time error, never a silent coercion.
- Read an object/array input as JSON with `${{ inputs.config }}`, or dot-read into it with `${{ inputs.config.region }}` (lenient — an unresolvable path collapses to `""`, unlike fail-closed `outputs`; field segments may contain hyphens).
- **E030** flags `${{ inputs.x }}` referencing an input not declared in `inputs:`, and also a dotted sub-reference into a *scalar* input (`${{ inputs.ticket.field }}` where `ticket` is a `string`) — it can never resolve.

Reference inputs in prompts as if the value is present: `Plan ticket ${{ inputs.ticket }}.` Don't narrate the substitution mechanism.

---

## 4. Wiring steps — and the four terminal mechanisms

Every step's success successor is declared by exactly one of `next:`, `on:`, or `routes:` (mutually exclusive per step). There is no implicit spine — a step with none is a validation error (E032).

- **`next: X`** ≡ `on: {success: X}` — the success successor.
- **`on: {success: X, fail: Y}`** — outcome-based branching. `fail:` is the failure successor.
- **`routes:`** — for `human` steps and `llm` steps that exit via the `route` tool. Compact `{a: X, b: Y}` or expanded `{a: {to: X, label: "Button text"}}`.

When you connect steps, every "where does this go?" answer is one of **four mechanisms** — pick by intent:

| Intent | Mechanism | Terminal? |
|---|---|---|
| Proceed | `next:` / `on.success` / a route → a real step | no |
| **Redo** ("send back / try again") | edge → an *upstream* step, bounded by `max-retries` | no |
| **Done, succeeded** (incl. graceful no-op) | → `exit` | `run_completed` |
| **Done, failed** | bare failure (no fail route) → halt; or llm `abort`; or operator `cancel` | `run_halted` |

**Failure handling is opt-in.** There is no implicit `fail → exit`. A step that fails with **no declared fail route halts the run** (`aborted_exit`). To recover, route failure explicitly: `on: {fail: <upstream-or-recovery>}`. The one graceful exception: an explicit edge to the `exit` sink on failure (`on: {fail: exit}`) is a sanctioned landing — the run *completes*. Use it only when "failed here is a fine end state".

- An `llm` step that decides it can't proceed calls the built-in **`abort`** tool with a one-sentence reason → halts with that reason as the detail. `abort` is force-included on every llm step.
- A **human** rejection that should end the run as failed is the operator's **`cancel`** (carries an optional note) — human steps don't get a `fail` sink; "reject" is usually a *redo* loop, and "discard" is `cancel`.

> **Every step declares its own successor (E032).** There is no linear fall-through to the next declared step — flow is fully explicit. A step that finishes a branch routes to the reserved `exit` sink (`next: exit`); a step that hands off names the next step. This is what stops a `quick` branch's terminal step from silently flowing into the `full` branch — the connection has to be written, never inferred from declaration order.

---

## 5. Loops and goal gates

Two retry idioms — they model different things, so they look different in the graph:

### Edge-cycle (check → fix → re-check)

A plain back-edge bounded by the target's `max-retries`. Idiomatic for a deterministic check with a dedicated fixer:

```yaml
ci:
  type: tool
  run: bun run ci
  max-retries: 5
  on: {success: commit, fail: fix}
fix:
  type: llm
  prompt: |
    CI failed. Re-run it, read the failure, make the minimal fix, stop.
  next: ci            # back-edge: fix → ci, capped by ci's max-retries
```

### Goal gate (judge → re-run the author)

`retry: <step>` marks the step a **goal gate** (it must succeed before the run completes) and retargets to `<step>` on failure. **`max-retries:` is required on every `retry:` gate** (E031) — it is the per-gate retarget cap. Idiomatic for an LLM quality gate that re-runs the work:

```yaml
review:
  type: llm
  retry: implement    # ⇒ goal_gate + retry_target=implement
  max-retries: 2     # cap: after 2 retargets the run pauses goal_gate
  prompt: |
    Judge `git diff HEAD`. Reply `APPROVE: <one line>`, or `abort` with `REJECT: <one line>`.
```

On REJECT, the engine retargets to `implement`; after `max-retries` retargets the run pauses `goal_gate`. Operators raise the live cap via `intent.goal_gate_adjusted`. The retarget destination is the failing gate's own `retry_target` (SPEC §3.4) — single-step, no graph-level or fallback retarget.

---

## 6. Moving data between steps

Three channels — pick by what the data *is* and what the consumer *does* with it:

| Channel | For |
|---|---|
| **Shared `thread:`** | steps that genuinely converse (plan ↔ implement ↔ review) |
| **Environment re-derivation** | anything already on disk / in git |
| **Typed `outputs:`** | a consumer that needs a value *typed* — to run it, pass it verbatim, or aggregate several producers |

Default to the thread for conversational context and the environment for on-disk state. Reach for `outputs:` only when the value being typed and addressable earns its keep (below).

### Shared thread (continuity)

Steps with the same `thread: <name>` share one LLM conversation; a downstream step sees upstream replies as ordinary assistant messages — the data is naturally present, no copy-paste. Set `summary: low | medium | high` on a receiving step to see a summariser-compressed view instead of the raw transcript (E027 if set without a `thread`).

Scope a thread to the steps that genuinely converse (e.g. `plan ↔ implement ↔ review` share `build`); don't run one global thread through the whole pipeline. Classifiers and mechanical steps stay off it.

**Split heavy collectors into their own step.** When step one runs a data-gathering script (`bun .fragua/scripts/foo/collect.ts` dumping JSON), make `collect` a dedicated `llm` with `allowed-tools: [bash]` sharing the analyser's thread. The bash result lives in the thread for the analyser to read; and when a downstream goal-gate retargets the *analyser*, the collector doesn't re-run. Keep its prompt minimal (run the script, `abort` on non-zero, else reply `collected`).

### Environment re-derivation

Many steps need no upstream artifact — they re-derive from git / fs / a script. Say so in the prompt ("Fresh thread — read state via git"). Cheaper than threading and harder to get wrong: `commit`, `merge::preflight`, `ci`, gates that read `git diff`.

### Typed outputs (`outputs:`)

An `llm` step declares typed `outputs:`; downstream steps read them with `${{ outputs.<producer>.<field>[.<sub>] }}` in `prompt:` (llm), `run:` (tool), or `text:` (human). A scalar leaf interpolates as its value, a record/array as JSON, a dotted leaf as the inner scalar. **Reads fail closed** — referencing a field the producer never populated on the taken path *fails the consuming node*, never a silent `""`.

```yaml
  review_security:
    type: llm
    prompt: Review the diff for security issues.
    outputs:
      findings:
        type: array
        items:
          type: object
          fields:
            severity: { type: choice, options: [low, high] }
            note:     { type: string }
            fix:      { type: string, optional: true }
    next: synthesize
  synthesize:
    type: llm
    prompt: |
      Reconcile into one verdict:
      ${{ outputs.review_security.findings }}
    next: exit
  merge:                                  # the other shape — a scalar into a tool
    type: tool
    run: gh pr merge ${{ outputs.scope.pr_number }} --auto --squash
```

The type grammar is the same one `inputs:` uses — `type:` of `string` / `number` / `boolean` / `choice` (+`options`) / `object` (+`fields`) / `array` (+`items`), nesting to any fixed depth; no recursion, no `$ref`, no constraint keywords (those are step predicates). Record fields are required unless marked `optional: true`.

**`optional:` vs sentinels — pick by how the field is read.** A read fails closed when it lands on an absent/`null` value, so where a field *might be empty* matters:
- **Always read, sometimes empty → required field with a sentinel.** A PR number that's sometimes "no PR" is `pr: { type: string }` carrying `"none"`, and the consumer branches on `"none"`. Marking it `optional:` would turn the no-value case into a node failure (a direct `${{ outputs.X.pr }}` read of an absent leaf fails closed) instead of a value you can handle. This is the right model whenever the consumer reads the field on every path.
- **Conditionally present, read inside a whole record/array → `optional:`.** A per-element `fix` that only some findings carry is `optional:` *because* the consumer reads the enclosing `findings` array **whole** — absence is just omitted JSON, never a fail-closed read.
- **Don't direct-read an optional leaf.** `${{ outputs.X.rec.optfield }}` fails closed whenever the producer omits the field; the validator flags it **W016**. There's no fallback syntax yet, so model it as one of the two shapes above.

**Rules:** `outputs:` is **`llm`-only to produce** (`tool`/`human` consume but never produce) and **mutually exclusive with `routes:`** (a routing step's terminal call is `route`). The producer emits via a forced `emit_output` tool, validated post-emit.

**Reach for `outputs:` only when:**
- a **mechanical consumer takes the value verbatim** — a `tool` runs it (`gh pr merge ${{ outputs.scope.pr_number }}`), or a step passes it through unchanged; getting it wrong is a bug, not a re-read; **or**
- a **synthesizer aggregates several producers** — multiple `llm` steps each emit structured results and a downstream step combines them (review lenses → `synthesize`). This `llm → llm` hand-off is legitimate: typed outputs give the consumer clean per-source access where a shared thread would interleave the sources as prose.

**Don't** reach for `outputs:` when another channel already serves: steps that *converse* → the thread (the data is already there); state *already in git / on disk* → re-derive; a *large prose body a tool consumes* (a review for `gh --body-file`) → a file; a *single producer with no consumer* → nothing to hand off. The smell is typing data the thread already carries between two steps that share it.

### Run-level outputs (the run's typed result)

A **top-level** `outputs:` block projects step outputs into the run's typed result — what an embedding caller binds, or a `fragua runs` verb prints. Each entry is `<name>: { from: <node>.<path> }`:

```yaml
outputs:
  verdict:  { from: review.verdict }      # a declared field of review's outputs
  findings: { from: review.findings }
  whole:    { from: review }              # bare node → the producer's whole struct
  total:    { from: review.scores.total } # dotted → a leaf/sub-record
```

`from:` uses the **same addressing** as the `${{ outputs.<node>.<field> }}` token, minus the wrapper. The output's type is the referenced field's type (no new type surface).

**It reads with different semantics than the in-graph token — on purpose.** The run boundary is **typed-partial, not fail-closed**: it carries exactly the declared outputs whose producer ran on the taken path; a declared output whose producer didn't run is **absent** (its key omitted from the result), never `""` and never a halt. Absent (producer didn't run) is distinct from present-`null` (an `optional:` field emitted as `null`). Only a `completed` run carries a result; a halted/cancelled run carries none. A producer that ran more than once (a goal-gate / `fail:`-edge loop, a retry) resolves to its **latest** emission; a static `parallel` branch terminal is an ordinary node — reference it directly (`from: scan_a.findings`).

This is **not** the place to put `default:` — run-output defaults are deferred; an absent output stays absent.

---

## 7. Step attributes

Common keys (kebab-case; the parser lowers them to the engine's snake_case):

| Key | Type | Why |
|---|---|---|
| `type` | enum | `llm` (default) / `tool` / `human` / `exit`. |
| `prompt` | string | The user-message content (`llm`). |
| `model` | string | Provider-native model id (must be registered). |
| `provider` | string | Provider key (defaults to daemon default / `defaults:`). |
| `thread` | string | Share an LLM conversation across steps (§6). |
| `outputs` | map | Typed step outputs (`llm` only; mutually exclusive with `routes:`). Read downstream as `${{ outputs.X.f }}` (§6). |
| `allowed-tools` | string[] | Tool whitelist. Name them — unconstrained is usually wrong. |
| `denied-tools` | string[] | Subtractive filter. |
| `mcp-servers` | string[] | MCP servers (from `.mcp.json`) to connect for this `llm` step; their tools materialise as `mcp__<server>__<tool>` (§7 · The toolset). |
| `effort` | `low\|medium\|high` | Reasoning effort for extended-thinking providers. |
| `max-cost` | number | Per-step USD ceiling. |
| `max-tokens` | int | Per-step token ceiling. |
| `max-retries` | int | Back-edge / handler retry cap (§5). |
| `summary` | `low\|medium\|high` | Compress the shared thread for this step (§6). |
| `skills` | string[] | Scope the skills catalogue for this step. |
| `run` | string | Shell command (`tool` steps only). |
| `timeout-minutes` | number | Wall-clock backstop (→ `max_ms`). **`tool` steps default to 5 minutes when this is unset** — long shell scripts WILL be killed silently. Set it explicitly for any command that may run longer than 5 min. `fragua validate` flags every `tool` step relying on the default so the silent kill is visible before the run. |

Advanced (kebab, see `references/advanced-attrs.md`): `context-files`, `system-prompt`, `skills-disabled`. Full attribute list: `packages/core/src/types/graph.ts` (`NodeAttrs`). W013 flags an unrecognised key (typo).

### The toolset

`allowed-tools` / `denied-tools` name tools from this set (lowercase, exact). An `allowed-tools` listing names that match *nothing* in the registry is a runtime error — typos don't silently no-op.

| Tool | Does | Notes |
|---|---|---|
| `read` | read a file | |
| `write` | create / overwrite a file | |
| `edit` | string-replace in a file | |
| `bash` | run a shell command | the workhorse; also how a step runs a script and reasons about its output (§7) |
| `grep` | content search | |
| `find` | filename search | |
| `ls` | list a directory | |
| `web_fetch` | fetch a URL | opt-in |

Three tools are **force-included** and need not be listed — they're available even if `allowed-tools` omits them (and survive `denied-tools`): `skill` (load a skill), `abort` (fail the step with a reason, §4), and `route` (synthesised per-call on a node that declares `routes:`).

### MCP tools (experimental)

An `llm` step can pull in [Model Context Protocol](https://modelcontextprotocol.io) servers with `mcp-servers:`. Every tool a listed server exposes is materialised as an ordinary tool named `mcp__<server>__<tool>` — the model calls it exactly like `read` or `bash`.

```yaml
steps:
  triage:
    type: llm
    mcp-servers: [github]          # connect this server for this step
    prompt: Summarise the open issues and file a report.
```

- **Declaring a server adds all its tools; `allowed-tools` narrows only if it names MCP tools.** `mcp-servers: [github]` exposes every github tool. Listing specific `mcp__*` tools in `allowed-tools` narrows the MCP set to those (pin a step to, e.g., read-only tools; names come from `fragua mcp check`); listing only *core* tools in `allowed-tools` leaves the MCP set untouched. `denied-tools` drops individual tools by full name (`mcp__github__delete_repo`).
- **Servers are declared** in `<project>/.mcp.json` at the repo root — the same file and shape Claude Code reads, so an MCP-configured repo just works. Both stdio and Streamable-HTTP servers are supported (legacy SSE is skipped):

  ```json
  { "mcpServers": {
      "fs":     { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
      "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/",
                  "headers": { "Authorization": "Bearer ${GITHUB_PAT}" } } } }
  ```

  `${VAR}` is resolved from the daemon's environment. A server whose credential is unset — or that fails to connect — is **skipped with a warning**, and the step runs with whatever tools did materialise; it never hangs or fails the step for a missing server.
- **`llm` only.** `mcp-servers` on a `tool`/`human` step is a parse error. Connections open lazily when the step runs and close when it finishes.
- **Inspect before you author:** `fragua mcp ls` lists the project's servers and their credential state; `fragua mcp check [server]` connects and prints the exact tool names to reference in `denied-tools`.

Not yet supported: OAuth servers (skipped like any missing-credential server for now), HTTP transport, and progressive disclosure — see `docs/proposals/mcp-tools.md`.

### Tool steps

```yaml
ci:
  type: tool
  run: bun run ci
  max-retries: 5
```

Side-effect-only: exit 0 → `success`, non-zero → `fail`. The exit code is the entire result — **tool steps don't feed data forward**. stdout/stderr are kept as artifacts for debugging. If you need to run a script *and reason about its output*, call it from inside an `llm` step's `bash` tool instead (E008 rejects an empty `run`).

---

## 8. Human steps (operator gates)

A `human` step pauses the run and asks the operator to pick one of a closed set of routes:

```yaml
signoff:
  type: human
  text: "Promote this change to CI?"
  routes:
    approve:  {to: ci,        label: "Approve"}
    feedback: {to: implement, label: "Request changes"}    # a redo loop
```

`fact.run_paused{reason:"human"}` carries `text` + the route names; the UI renders one button per route (label = the edge `label`, else the humanized route name). The operator resumes with `POST /runs/:id/human { route, note? }`; the server validates `route` against the declared set.

- `human` steps require `routes:` (E022) and can't be a `thread` member (humans don't see LLM threads).
- "Reject / send back" is a **redo** route (→ an upstream step), not a fail terminal. To *fail/discard* the run, the operator uses `cancel` (with a note).
- Route names must each have an edge (E021); a route and `goal_gate` are mutually exclusive (E023); two routes from one step can't collide (E024).

---

## 9. Models, budget, defaults

```yaml
defaults:
  provider: anthropic
  model: claude-sonnet-4-6     # applied to every llm step that omits `model`
```

- `claude-sonnet-4-6` — the workhorse (implement, review, fix, commit).
- `claude-opus-4-7` — deep planning / heavy synthesis.
- `claude-haiku-4-5` — cheap classification / collectors / diff gates.
- A classifier's model should match the *cost of getting the call wrong*, not a blanket cheap tier.

`POST /workflows` validates models at registration (`model_unresolved` lists offenders before enqueue). `bun run fragua providers ls` to see what's registered.

**Budget:** `budget` (run-level USD) + `budget-policy` (`warn` emits events; `stop` halts; `pause` → operator-resumable `fact.run_paused{reason:"budget"}`). Same semantics for per-step `max-cost` / `max-tokens`.

---

## 10. Prompts that behave

1. **Cut fluff.** Intent + hard rules + terminator. Drop tool walkthroughs, motivational framing, repeated warnings. Halve, then restore only what proves necessary.
2. **Don't leak runtime plumbing.** The model doesn't model threads, turns, or substitution. Reference the *artifact* by name, not how it arrived:

   ```
   ✅ Judge the diff against the implementer's PLAN_REALISED block and `git diff HEAD`.
   ❌ The previous turn in this shared `build` thread ended in a PLAN_REALISED block — your context has it…
   ```
3. **Make routing decisions auditable cheaply.** When *why* a route was chosen matters, ask for it in the prompt ("state the deciding factor in one line, then call `route`"). The `route` call must be isolated from other tool calls, but text in the same turn is fine — the rationale lands in the transcript. The `route` tool takes only `name`; don't ask for a `reason` field (it doesn't exist) unless a workflow needs to *query* rationale programmatically.
4. **Give a clean failure exit.** Tell the step when to `abort` (empty / ambiguous / blocked input) rather than flailing or silently retargeting.

A 150-word prompt is a reasonable upper end; past ~300 words, split the step or move standing rules to `context_files`.

---

## 11. Scale the work to the change

Mirror `work` and `review`: a cheap, isolated classifier sizes the input and routes to a tier-appropriate path — minimum work for the trivial case, full rigor where it matters. `review` is the model:

- `scope` (classifier) → `skip` (LGTM, straight to signoff) / `quick` (one focused pass) / `full` (a deep multi-lens pass → gate).
- The tier is **topology**; within `full`, *which* lenses the review applies is its own call — correctness always, security/performance/architecture only when the diff implicates them.

Don't apply maximum machinery uniformly. A four-lens review of a typo is the same smell as planning a one-line fix.

---

## 12. Validation

`bun run fragua validate path/to/my-thing.yaml` is the fast loop. Fix every error; take warnings seriously. The codes you'll meet most:

- **E004** — edge targets a non-existent step id (typo). (An unknown `type:` is a *parse* error, not a validator code.)
- **E017–E024** — routing/edge discipline (routing node with `outcome=`; edge with both `route` and `outcome`; `route` not in `routes:`; unannotated routing edge; undischarged route; `goal_gate` + `routes:`; shadowed edge).
- **E022** — `human` step has no `routes:`.
- **E027** — `summary:` without a `thread`.
- **E028 / E029** — step id `exit` / `start` is reserved.
- **E030** — `${{ inputs.x }}` references an undeclared input.
- **E033 / E034** — malformed `outputs:` type grammar (unknown `type:`, bad `fields`/`items`/`options`, or a disallowed construct like `pattern`/`$ref`/recursion).
- **E035** — `${{ outputs.X.f }}` references a field the producer doesn't declare, or a producer that can never reach the consumer (dead reference).
- **W015** — a referenced `outputs:` producer may not run on every path to the consumer; the read fails closed at runtime if it didn't.
- **W016** — a `${{ outputs.X.f }}` read reaches through an `optional:` field the producer may omit; fails closed at runtime. Model it as a required field + sentinel, or read the enclosing record/array whole.
- **E046** — a top-level `outputs:` projection (`from: <node>.<path>`) names a node with no `outputs:`, or a path the producer's schema doesn't declare (the run-level analog of E035).
- **W018** — a top-level `outputs:` producer may not run on every completing path; the output is then absent from the run's result (typed-partial), not a failure (the run-level analog of W015).
- **E031** — a `retry:` gate has no `max-retries:` (the per-gate retarget cap is required).
- **E032** — a step declares no success successor — add `next:` / `on: {success: …}` / `routes:` (`next: exit` to finish). There is no linear fall-through.
- **W007** — `goal_gate` (`retry:`) with no `retry_target`.
- **W013** — unrecognised attribute (typo).
- **W014** — `retry-policy:` / `default-retry-policy:` names an unknown preset (typo). Falls back to `none` at runtime. Valid presets: `none` / `standard` / `aggressive` / `linear` / `patient`.

Full table, including removed codes: `references/validator-codes.md`.

---

## 13. Anti-patterns

- **Synthesizing a fail path.** There's no implicit `fail → exit`. A step with no fail route halts — that's the point. Add `on: {fail: …}` only to recover or land gracefully.
- **A `loop` step.** Loops are back-edges (`on: {fail: <upstream>}` + `max-retries`) or goal-gate retargets (`retry:`).
- **Two jobs in one step.** One prompt, one thread, one model, one tool pool.
- **Fan-out for write-class work.** `type: parallel` runs ≥2 branch sub-pipelines concurrently to a `next:` join — but branches are deliberation-only `llm` steps sharing the worktree READ-ONLY (no `bash`/`write`/`edit` — E042), disjoint, un-threaded (E043), non-nested (E040). Use it for concurrent *reading* (review lenses, scans) that converges on a synthesizer consuming `${{ outputs.<branch-terminal>.f }}`; materialise shared inputs (e.g. the diff) in a `tool` step BEFORE the fan-out since branches can't run commands. Concurrent *writing* is still separate runs sharing artifacts. `concurrency:` caps in-flight branches; `timeout-minutes:` on the parallel node bounds each branch. See `review.yaml` for the canonical scan→verify lens fan-out.
- **A global thread.** Scope threads to the conversation that needs them; keep classifiers and mechanical steps stateless.
- **Re-reading a classification from a thread.** Encode it in the topology, or re-derive fresh evidence at the point of decision.
- **A `collect → analyze` tool→llm chain.** Tool steps don't feed data forward; run the collector inside the analyser's `bash` tool, or split it into a dedicated `llm` collector sharing the thread.
- **A heavy collector that's also a goal-gate retarget target.** Each retarget re-runs it. Split `collect` out so only the analyser re-runs.
- **Typing data the thread already carries.** `outputs:` between two steps that share a `thread:` is usually the smell — the data is already present. Reach for `outputs:` for a verbatim machine hand-off or a multi-producer synthesis (§6), not to make a conversation "structured".
- **Uniform max rigor.** Scale the work to the change (§11).
- **Leaking plumbing into prompts.** No "previous turn", "your context contains", "in a single message".
- **Editing a workflow mid-run.** `workflow_sha` is pinned at enqueue; edits apply to future runs.

---

## Cheat sheet

```yaml
name: my-thing
goal: One-sentence purpose.
inputs:
  task: { type: string, required: true, description: The task }
defaults:
  provider: anthropic
  model: claude-sonnet-4-6

steps:
  triage:                          # classifier — isolated, cheap, routes by topology
    model: claude-haiku-4-5
    allowed-tools: [read, grep, find]
    prompt: |
      Classify ${{ inputs.task }} with the `route` tool (once, on its own response):
        small — contained change   |   feature — multi-package / shared contracts
      Not a workable task → `abort` with the reason.
    routes:
      small:   {to: implement, label: "Small change"}
      feature: {to: plan,      label: "Feature scope"}

  plan:
    model: claude-opus-4-7
    thread: build
    allowed-tools: [read, grep, find]
    prompt: |
      Produce a numbered plan for ${{ inputs.task }}.
    next: implement

  implement:
    thread: build
    allowed-tools: [read, write, edit, grep, bash]
    prompt: |
      Implement ${{ inputs.task }} (a plan in this thread → realise it; none → scope it yourself).
      End with a PLAN_REALISED block.
    next: review

  review:
    thread: build
    retry: implement                # goal gate → re-run implement on REJECT
    max-retries: 2                  # required: per-gate retarget cap (E031)
    next: ci                        # success successor — explicit (no fall-through)
    allowed-tools: [read, grep, bash]
    prompt: |
      Judge `git diff HEAD` against PLAN_REALISED. `APPROVE: <one line>`, or `abort` with `REJECT: <one line>`.

  ci:
    type: tool
    run: bun run ci
    max-retries: 5
    on: {success: commit, fail: fix}

  fix:
    allowed-tools: [read, write, edit, bash]
    prompt: |
      CI failed. Re-run it, read the failure, make the minimal fix, stop.
    next: ci

  commit:
    allowed-tools: [read, write, edit, bash]
    prompt: |
      Commit per AGENTS.md conventions. Fresh thread — read state via git.
    next: exit
```

```sh
bun run fragua validate path/to/my-thing.yaml
bun run fragua run      my-thing --input task="…"
```

When a workflow misbehaves at runtime, switch to `operate` (steer / pause / resume a live run, or diagnose a failure via its forensics reference).
