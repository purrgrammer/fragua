---
title: Ernesto interop — two engines, one contract
summary: "fragua will NOT be the engine powering Ernesto's workflows. The embedding path explored in embeddable-engine.md (making @fragua/{types,core,store} generic enough to host Ernesto's runtime) is dead: the requirement deltas (async multi-tenant store, worker/pod dispatch with durable re-walk resume, registry-based runtime dispatch, dynamic workflows) are architectural, not parametric, and warrant two implementations. What the two systems share instead is a CONTRACT: (1) the fact.* event taxonomy + envelope — Ernesto already borrowed fragua's names ad hoc and extended them; formalize it as a small versioned spec both implement; (2) one concrete integration point — an Ernesto step kind 'fragua' whose handler executes a whole fragua run as a black-box step, mirroring Ernesto's own dynamic-workflow precedent (a foreign runtime as ONE step). The v1 runner spec is a SUBPROCESS: `fragua ci --json` (ships on main today), spawned per dispatch. The child-process boundary is a feature — it dissolves the three hard problems an in-process embed would have to engineer around: runtime mismatch (fragua runs under its own Bun, zero Node-portability work), env confinement (a fresh parent-constructed child env, so a workflow bash step can't read the pod's secrets — the sharp security risk, gone), and crash isolation (signal→kill). The in-process embed (the @fragua/engine library: packaging pipeline + Bun split + node:sqlite + embed API + injected ExecutionEnvironment) is DEFERRED — earned only if/when subprocess limits bite, not speculatively. The one genuine fragua-side v1 prerequisite: run-level typed outputs (structured-outputs.md §11 — a declared workflow `outputs:` block, typed-partial egress envelope), which `fragua ci` emits as terminal JSON; a step downstream can't bind is a DAG dead-end. Known gap: run-outputs project from llm producers only (tool-terminal workflows can't yet surface typed results — structured-outputs §10#3). (3) Convergence candidates (graph-as-data authoring, pause taxonomy). SKETCH — the taxonomy spec's home and the cross-engine token shape are open."
status: draft
maturity: sketch
last-reviewed: 2026-06-15
---

# Ernesto interop

> **Supersedes the embedding plan.** `embeddable-engine.md` (unmerged, on the
> `docs/embeddable-engine-proposals` branch) explored decoupling fragua's
> engine so other systems could embed it — with Ernesto as the motivating
> embedder *of its own workflows*. That motivation is withdrawn (§2). One
> axis of it returns with a sharper, narrower driver (§5.2); the leak
> inventory there remains valid as own-merit hygiene. Everything below is
> verified against `ernesto@openclaw-h1-migration` (PR ask-ernesto/ernesto#2)
> and `backend@feat-ernesto-workspaces-clean` (PR bitrefill/backend#9861) as
> of 2026-06-12.

## 1. The decision

**Two engines, one contract.** fragua and Ernesto each keep their own
workflow engine; neither is implemented on top of the other. What they share
is vocabulary, an event taxonomy, and one integration seam: an Ernesto step
kind that executes a fragua run as a black-box step, by linking fragua's
executor as a library (§5). That is a *library use* of fragua at its outer
boundary — Ernesto's walker, store, and dispatch never route through fragua,
and fragua never hosts Ernesto's step kinds.

The precedent for keeping the engines siblings is already in Ernesto's tree:
the `fragua-pi` harness wraps `pi-agent-core`/`pi-ai` directly and documents
that fragua's `PiLlmBackend` is *"a sibling reference, not a dependency"*
(`ernesto:src/harness/fragua-pi/index.ts`). pi is the shared LLM substrate;
the engines stay separate implementations above it.

## 2. Why embedding lost

The mismatches are architectural — each one sits at fragua's spine, not at a
parameter:

| Axis | fragua | Ernesto |
|---|---|---|
| Store | sync `bun:sqlite`, single-writer, pure-SQL transactions (invariant I1), fold-replay determinism, OCC claims | async `StorePort` (`appendEvent`/`getRunState`/`putRunState`, all Promises — `ernesto:src/workflow-engine/store/port.ts:81`), Mongo-backed in the backend |
| Execution | one daemon process; executor + supervisor fibers over the store | any pod dispatches; BullMQ cron workers, poll workers; resume re-enters from a durable `ResumeState` (`outputs`/`skipped`/`paused` re-walk seed, `port.ts:39`) on a *fresh process* |
| Tenancy | single operator; `cwd` is the only project identity | `Principal` (user vs service) threaded through every dispatch; scope narrowing per step (`ernesto:src/workflow-engine/principal.ts`) |
| Dispatch | static graph, handlers resolved per node kind at build | `KindRegistry` — runtime by-URI resolution over routes + workflows, with a per-kind `KindPolicy` read by a middleware chain (workdir allocation, sandbox-bind, model routing, idempotency — `ernesto:src/workflow-engine/kind-registry.ts:32`) |
| Workflow identity | sha-pinned static IR; replay-by-fold is the determinism guarantee | dynamic workflows are first-class (`kind: 'dynamic-workflow'` wraps a runtime JS script; routes register at boot; declarations hot-load from workspace trees) |

Forcing one engine to host the other's column means giving up the property
that makes it good: fragua's replay determinism is a property of the
single-writer folded log; Ernesto's any-pod liveness is a property of the
durable-resume re-walk. They are different answers to different deployments
(local-first dev tool vs multi-tenant backend), both correct.

## 3. What is already shared (the accidental contract)

Ernesto borrowed fragua's vocabulary when it was built, and the overlap is
load-bearing today:

- **Envelope.** Ernesto's `StoredEvent` is `{runId, seq, type, payload, ts,
  routing}` plus a `writer` attribution (`ernesto:src/workflow-engine/types/event.ts:138`)
  — field-for-field fragua's event row plus `writer`.
- **Names.** `fact.run_started`, `fact.run_resumed`, `fact.run_paused_human`,
  `fact.node_completed` are identical strings in both taxonomies. Ernesto's
  subscribers are required to ignore unknown `fact.*` types (`event.ts:26`) —
  the same forward-compat rule fragua's `EVENT_CONTRACT_VERSION` encodes.
- **Run/step/node language.** Both call an execution a *run*, address work by
  *step id*, park on *pauses*, and separate lifecycle facts (walker/executor
  writes) from in-step facts (handler writes).
- **`${{ }}` substitution.** Ernesto: `${{ inputs.X }}` /
  `${{ steps.<id>.outputs.<path> }}`. fragua: `${{ inputs.X }}` /
  `${{ outputs.<producer>.<field> }}`. Same token syntax, same two
  namespaces, one naming divergence (`steps.*.outputs.*` vs `outputs.*`).

And the divergences that matter:

| Concept | fragua | Ernesto |
|---|---|---|
| Terminal facts | three (`fact.run_completed` / `_halted` / `_cancelled`) — **converging to one** | one `fact.run_terminated { status }` — the convergence target ([`fact-taxonomy.md`](fact-taxonomy.md) §3.1) |
| Streaming facts | `fact.message_appended` (whole messages); deltas are SSE-only, off-log | `fact.assistant_delta` / `tool_call` / `tool_result` / `thinking` / `usage` / `component` on-log |
| Pause taxonomy | `paused` / `paused_human` / `paused_auto` (statuses) | `paused` status + `ParkedPause.kind: 'human' \| 'signal'`; `fact.run_paused_signal` is new vocabulary (external-system watch) |
| Statuses | `queued running paused paused_human paused_auto completed cancelled halted quarantined` | `running paused completed errored aborted` |
| Cancel spelling | `cancelled` | store says `aborted`; harness layer says `canceled` |
| Run outputs | none (thread + artifacts; per-step typed outputs in the structured-outputs MVP) | `WorkflowDeclaration.outputs:` — run-level typed output bindings |

## 4. Shared contract piece 1 — the taxonomy spec

A single short markdown spec, versioned, defining:

1. **The envelope**: `{runId, seq, type, payload, ts, routing?}`; `seq`
   monotonic per run; `type` is `fact.<noun>_<verb-past>`; unknown types are
   ignored, never fatal.
2. **The core lifecycle set** both engines emit with agreed payload minima:
   `run_started`, `run_resumed`, `run_paused_human`, `node_completed`, and a
   terminal (engine-specific refinements allowed; a consumer that only knows
   the core set can follow any run).
3. **The extension rule**: an engine may emit beyond the core set; promoting
   an extension into the core set is a versioned spec change PR'd to both
   repos. This is the channel through which good ideas flow — e.g. Ernesto's
   `fact.run_paused_signal` (external-signal pause) and `fact.component`
   (structured UI intents) are candidates fragua may want; fragua's
   quarantine and schedule families are candidates Ernesto may want.

The spec is two pages, not a package. **No shared npm module for the
taxonomy** — a shared runtime type package would couple the engines' release
cadences at the type layer for no behavioral gain. Each repo checks in a copy
with the same version field; divergence is a bug caught in review (Alejandro
reviews Ernesto-lib changes; see §8).

Drafted (fragua-side copy): [`fact-taxonomy.md`](fact-taxonomy.md) — v0. Its
stance is **converge, not reconcile**: where the engines encode the same event
differently, pick one form and move both to it. The v0 instance is the
terminal fact — one `fact.run_terminated { status }` (Ernesto already emits it;
fragua converges, §8). **Canonical home: fragua** (this repo); Ernesto checks
in a mirror (§9.1).

## 5. Shared contract piece 2 — `kind: 'fragua'`

Clement's integration point, and the right one: an Ernesto step kind whose
handler executes a **whole fragua run as one black-box step**. Ernesto
already has the exact precedent in-tree — the `dynamic-workflow` kind wraps
an entire foreign runtime (Claude Code's workflow runtime) as ONE step:
scope-check upstream, idempotency + cost-rollup wrap it, inner structure
owned by the foreign runtime, not the DAG walker
(`ernesto:src/workflows/types.ts:266`). `kind: 'fragua'` is the same shape
with fragua as the foreign runtime.

### 5.1 The step

```yaml
review:
  kind: fragua
  workflow: review            # file-based: resolved against the workdir's .fragua/workflows/ (§9.4)
  inputs:
    pr_number: "${{ inputs.pr }}"
    config:    "${{ inputs.review_config }}"   # an object — see input passing below
```

Registered backend-side via `runner.registerStepKind('fragua', handler)` —
the same extension path `monitor` uses. `KindPolicy` defaults for the kind:
`cwd: 'ephemeral'` (§5.4), `tools.native: 'disallowed'` (the fragua subprocess
owns its own tools), plus whatever `timeoutMs`/`retry`/`idempotent` the author
sets — Ernesto's middleware wraps the whole fragua run for free.

**Input passing — two clean substitution passes, no namespace leak.** Ernesto
resolves the step's `inputs:` map over *its* namespace
(`${{ inputs.* }}` / `${{ steps.*.outputs.* }}`, `run-graph.ts:570`) to
concrete values *before* the handler runs — exactly as it does for a
`dynamic-workflow` step's `args`. The handler hands those values to fragua,
which then resolves its *own* workflow's `${{ inputs.X }}` over them. Ernesto's
`inputs`/`steps` vocabulary never reaches fragua; fragua sees only concrete
values. Non-scalar inputs (an object/array from a whole-string Ernesto token)
ride `fragua ci --input-json '<json>'` — the handler `JSON.stringify`s its
resolved inputs object once, and fragua validates it against the workflow's
typed `inputs:` schema ([`structured-outputs.md`](structured-outputs.md) §12).
No per-value encoding, no scalar-only wart.

### 5.2 Runner spec — subprocess via `fragua ci` (v1)

The handler spawns fragua's one-shot embedded executor as a child process:

```
fragua ci <workflow> --json --input k=v … --cwd <workdir> [--export <bundle>]
```

Everything the seam needs ships on `main` today (`cli/src/commands/ci.ts`):
a **run-private ephemeral store per invocation**, credential seeding, an
intent-plane save+enqueue, the `runOne` drive loop, `--json` JSONL on stdout,
and the total-status→exit-code map. The Ernesto handler is a process spawn +
a stdout line reader (§5.3) + an exit-code → `HandlerResult` map — **smaller
than the `monitor` handler**, and it needs almost nothing new from fragua
(§8).

**The subprocess boundary is a feature, not a tax.** It dissolves three
problems an in-process embed (§5.5) would have to engineer around:

- **Runtime mismatch → gone.** fragua's store is `bun:sqlite`; the backend is
  Node + pnpm. A child process runs fragua under its own Bun with **zero**
  Node-portability work — the host image needs the `fragua` binary and
  nothing else. The whole Bun-split / `node:sqlite` / spawner-twin effort
  (§5.5) is off the v1 path.
- **Env confinement → gone — and this was the sharp one.** An in-process
  embed cannot strip its host pod's `process.env`, so a workflow `bash` step
  would inherit every backend secret. A child process gets a **fresh,
  parent-constructed env**: the handler passes only the resolved provider
  creds + workdir, and `fragua ci`'s own startup env-strip (`env-creds.ts`)
  is a second layer. The hardest must-design-in problem is handled by the OS
  process model, not by new code.
- **Crash isolation → free.** `HandlerContext.signal` → `child.kill()`; a
  fragua crash cannot take down the pod. Per-dispatch tenant isolation falls
  out — each spawn gets exactly the creds its dispatch resolved, in a process
  that then exits.

Credentials: Ernesto's model-router middleware already materializes
per-dispatch provider env (`annotations.providerEnv`); the handler hands it
to the child as env. No shared fragua DB, no shared creds, anywhere.

Durability class: **restart-not-resume.** A pod death mid-run fails the step;
Ernesto's `KindPolicy.retry` + `idempotent` re-dispatch it. Identical to
every other in-pod step (an in-flight CAS turn dies with the pod too), and
retry is sound because effects are confined to the re-provisioned ephemeral
workdir (§5.4).

The one fragua-side addition the seam needs: `fragua ci` must surface the
run's **typed outputs** (§5.4) across the boundary — a terminal JSON object
on `--json`, mirrored into the `--export` bundle.

### 5.3 The event bridge

The handler reads `fragua ci --json` (one fact per line on stdout) and
translates each to `ctx.emit` (`EmitFactEvent`,
`ernesto:src/workflow-engine/types/handler.ts:36`) as the lines land:

| fragua fact | Ernesto emit |
|---|---|
| `fact.message_appended` (assistant) | `fact.assistant_message` |
| `fact.message_appended` (tool call / result parts) | `fact.tool_call` / `fact.tool_result` |
| `fact.node_completed` (`tokens`, `costUsd`) | `fact.usage` |
| `fact.node_started` / `node_completed` | `fact.component` (status/progress card) — optional polish |
| terminal facts | handler returns; lifecycle facts are the **walker's** to emit, not the bridge's |

The translation is shallow because §3's accidental contract did the work:
same envelope, same naming grammar. Note the granularity inversion — inside
fragua, deltas are off-log; inside Ernesto the *message-level* facts are
on-log and that is all the bridge forwards. Cost attribution rides
`fact.usage`, so Ernesto's cost-rollup middleware sees fragua tokens exactly
as it sees CAS tokens.

### 5.4 Environment, landing, HITL, outputs

- **Environment: Ernesto provisions, hands a path, fragua operates.** The
  handler spawns `fragua ci --cwd <workdir>` against the
  middleware-allocated workdir with an explicit child env; fragua picks
  `LocalEnvironment` (its non-git path) inside it. Confinement is three
  layers: the parent-constructed child env (§5.2), `fragua ci`'s startup
  env-strip, and `LocalEnvironment`'s `_cwd` path-guard. fragua's own
  worktree/accept/discard machinery stays **out** — Ernesto's workdir
  overlay/settle is the landing layer, and two git layers deep is one too
  many. Recommended default `cwd: 'ephemeral'`; `'workspace-workdir'` works
  where a fragua workflow should read workspace state, with settle as the
  gate for what lands.
- **Retry soundness falls out of confinement.** Ernesto's durability class
  for the kind is restart-not-resume (§5.2), which is only *correct* when
  re-running has no unreconciled external effects. Effects confined to the
  (re-provisioned, ephemeral) workdir make retry idempotent by
  construction. Tool steps that deliberately reach outside (`curl`, `gh`)
  are the declared exception class —
  [`tool-exec-variant.md`](tool-exec-variant.md)'s
  `idempotent:` marker becomes load-bearing here, mapping onto Ernesto's
  `KindPolicy.idempotent`/retry posture.
- **HITL: fail-fast in v1.** `fragua ci` stops with a non-zero exit on
  `paused_human` — it has no responder. The handler maps that to a typed
  `error` (`code: 'fragua_hitl_unsupported'`), and Ernesto-side lint rejects
  a fragua workflow with a `human` node at settle. The bridged variant
  (resume across the process boundary against a pinned `--db`) is exactly the
  surface [`hitl-channel.md`](hitl-channel.md) proposes (`--on-pause=emit`,
  `--resume`); it sequences after that ships, not in v1.
- **Outputs: the typed envelope crosses as JSON; run-level outputs are the
  one real prerequisite.** A black-box step earns its place in Ernesto's DAG
  by what downstream can bind: `${{ steps.review.outputs.verdict }}`,
  `skipIf:`, `fallback:`, and idempotency-key expressions all evaluate over
  step outputs. With only `finalText` the fragua step is a display-only dead
  end. So `fragua ci` must emit the run's typed-partial output envelope as a
  terminal JSON object — designed in
  [`structured-outputs.md`](structured-outputs.md) §11 (declared workflow
  `outputs:` block, absent ≠ `""` ≠ halt). The handler reads that object as
  the step's typed output; an absent field is handled by the consuming
  Ernesto step's own `skipIf`/`fallback`. A prototype may ship
  `{ status, finalText, usage, bundlePath? }` first, but that shape is
  explicitly pre-contract.
  - **Wire shape (the one fragua-side spec to pin):** `fragua ci --json`
    emits a final line `{ runId, status, outputs, usage }` after the event
    stream — `status` the terminal status per
    [`fact-taxonomy.md`](fact-taxonomy.md) §3.1 (`completed | failed |
    cancelled`), `outputs` the §11 typed-partial envelope (absent keys
    omitted), `usage` the run-total cost. The same object lands in the
    `--export` bundle. The handler keys on `status` for `HandlerResult` and
    binds `outputs` into the DAG; it is the only new `ci` surface v1 needs.
  - **Known gap (state it, don't paper over it):** run-level outputs project
    only from `llm` producers, because tool-step production is deferred
    ([`structured-outputs.md`](structured-outputs.md) §10 #3). A
    *tool-terminal* fragua workflow — fetch a dataset, compute a value, emit
    a file — cannot yet surface that as a typed run-output, which is exactly
    the non-dev (data / image / transform) shape some embeddings want. v1's
    output contract is honest for llm-terminal workflows and silent for
    tool-terminal ones; closing it is gated on §10 #3.

### 5.5 In-process embed — earned later, not v1

If subprocess overhead, process-management friction, or shipping the `fragua`
binary in the runner image ever becomes the binding constraint, the upgrade
is to link fragua's executor as a library (`@fragua/engine`) and run the same
drive loop in-process. The drive loop and stop-states are byte-identical, so
the swap touches only the invocation and the event tail — the kind handler,
the bridge mapping, and the run-output contract are all unchanged.

It is deliberately deferred because the bill is large and front-loaded, and
the subprocess path retires most of it (§5.2): a **packaging pipeline** (every
`@fragua/*` is `private:true` shipping raw TS — a Node consumer needs dist
artifacts + a publish channel); **runtime portability** (the `@fragua/store`
bun-free contract split + a `node:sqlite` driver — the backend's `.nvmrc`
pins Node 24.15 where it is stable; Node twins for `runWithBun`
(`core/.../tool.ts:287`) and `Bun.Glob` (`workspace/.../local-env.ts:193`); a
Node CI lane + a `bun:*`-free guard test); an **embed API** (`buildExecutorDeps`
as a public constructor, config-as-data, a programmatic `seedCreds(store,
record)`, a `driveRun({ …, signal, onEvent })` that replaces the JSONL tail
with a callback and the injected `ExecutionEnvironment` that makes *Ernesto
provisions, fragua operates* a real interface rather than a `--cwd` handoff);
and **pi floor alignment** between the two consumers sharing one
`node_modules`. The honest cost is that `@fragua/*` enters the backend's
dependency graph; the containment is the one-entry, semver'd surface. None of
it is needed until subprocess is proven and its limits bite.

## 6. Convergence candidates

Vocabulary-level alignment, pursued opportunistically — not shared code:

1. **Env lifecycle.** fragua's five-phase model (provision / operate /
   checkpoint / land / dispose, embeddable-engine.md §4.1) and Ernesto's
   workdir machinery (`KindPolicy.cwd` allocate → overlay → settle) are the
   same lifecycle with different names. Under the v1 subprocess this is the
   `--cwd` handoff (Ernesto provisions the workdir, fragua operates inside it,
   settle lands); the §5.5 embed would sharpen it into a typed injected
   `ExecutionEnvironment` interface. Adopting the phase names in both docs
   documents a real seam either way.
2. **Graph-as-data.** Ernesto's `WorkflowDeclaration` is already
   workflow-as-plain-data in TS (`steps:` record, `depends:`/`next:` sugar,
   validation downstream) — independent confirmation of
   [`graph-as-data.md`](graph-as-data.md)'s core bet (data in, IR out, no
   builder). Align the authoring vocabulary while both are soft:
   `steps.<id>.outputs.<path>` vs `outputs.<producer>.<field>` is the kind
   of pointless divergence the contract should erase (§9.4).
3. **Run-level outputs.** Ernesto has `outputs:` at the workflow level;
   fragua has none — and §5.4 makes them a prerequisite (a fragua step
   without typed outputs can't participate in `depends`/`skipIf`/
   `fallback`/idempotency expressions). A run-level output mapping over
   fragua's structured-outputs grammar
   ([`structured-outputs.md`](structured-outputs.md) §11) is the missing piece
   that makes a fragua run *composable from outside* — on the critical path,
   not a candidate.
4. **Pause taxonomy + external wait.** Ernesto's `signal` pause kind (park on
   an opaque `signalKey`; a durable worker resumes — the `monitor` kind rides
   it) is a cleaner generalization than growing more `paused_*` statuses.
   **fragua intends to gain an external-wait primitive** (a workflow waiting
   on CI, a deploy, or a remote job without an LLM step polling) — this is
   wanted, and **needs its own design**: the resume mechanism, the durable
   watcher, and how it folds under fragua's single-daemon model (vs Ernesto's
   any-pod worker). It is a tier-2 convergence
   ([`fact-taxonomy.md`](fact-taxonomy.md) §6.2): once fragua builds it, the
   taxonomy adopts the `human | signal` split. A future fragua proposal owns
   the design; this doc only records the intent and the convergence target.

## 7. Disposition of the embedding work

| embeddable-engine.md piece | Fate |
|---|---|
| Axis 1 — Bun split (`@fragua/store` barrel) | **deferred to the §5.5 in-process upgrade** — the v1 subprocess runs fragua under its own Bun, so no `node:sqlite` driver is on the v1 path. Own-merit value (fragua-on-Node) unchanged. |
| Axis 2 — `EnvRef` / `SandboxProvider` | injection half deferred with §5.5 (the `--cwd` handoff covers v1); the git/`EnvRef` fact-vocabulary half stays own-merit |
| Axis 3 — generic cost `{unit,value}` | no interop pressure (Ernesto's `fact.usage` is token+USD-shaped too); own merit only |
| §7 evictions (blobs / creds / provider config) | own-merit hygiene; the credential eviction's `CredentialResolver` shape is a natural sequel to the §5.5 embed's `seedCreds`, but not a prerequisite for either v1 or the embed |
| Leak inventory (§10) | still valid; keep as the audit record |
| [`graph-as-data.md`](graph-as-data.md) | unchanged, now also an interop convergence (§6.2) |

The branch's doc should be re-scoped (frontmatter + a pointer here) rather
than deleted — the file:line audit is the part worth keeping.

## 8. Process

- Alejandro stays a reviewer on Ernesto-lib changes; taxonomy-affecting
  changes in either repo reference the shared spec version.
- fragua-side work, v1 — small, because the subprocess seam ships today:
  **(1)** run-level outputs ([`structured-outputs.md`](structured-outputs.md)
  §11) — the one genuine prerequisite, and buildable on its own merit
  (fragua's own `fragua runs` output wants the same projection); **(2)**
  `fragua ci` emits the typed-partial output envelope as a terminal JSON
  object on `--json` + into the `--export` bundle; **(3)** object/array inputs
  ([`structured-outputs.md`](structured-outputs.md) §12) — **pairs with (1)**
  (same grammar + TypeBox path); ergonomics, not a hard blocker (per-value
  encoding works), but it dissolves the §5.1 input wart and is a standalone
  CLI UX win (`--input-json`, type-directed `--input` parse).
- fragua-side work, later: the **terminal-fact convergence** — collapse
  `run_completed`/`run_halted`/`run_cancelled` into one
  `fact.run_terminated { status }` ([`fact-taxonomy.md`](fact-taxonomy.md)
  §3.1; lossless discriminated union, `EVENT_CONTRACT_VERSION` bump + the
  enum-literal sweep). **Not a v1 blocker** — the §5.4 `ci` envelope already
  emits the converged `status` computed from whichever terminal fact fired,
  so this is taxonomy hygiene, sequenced when fragua next touches the terminal
  set. The HITL bridge ([`hitl-channel.md`](hitl-channel.md), upgrades §5.4
  from fail-fast to resumable); the §5.5 in-process embed surface, **only when
  subprocess is proven and its limits bite** — not speculatively; closing the
  tool-terminal-output gap (§10 #3 of structured-outputs).
- Ernesto-side work, v1: the `fragua` kind handler — a `fragua ci` spawn + a
  stdout JSONL reader + an exit-code map (smaller than the `monitor`
  handler); a `human`-node-rejecting lint; the taxonomy spec copy.
- Sequencing: nothing blocks the Ernesto handler — `fragua ci --json` is on
  `main` now. It can land against the pre-contract `finalText` shape
  immediately and tighten to the typed envelope when (1)+(2) ship.

## 9. Open decisions

1. ~~**Taxonomy spec home.**~~ **Resolved: fragua is canonical**, Ernesto
   mirrors. The engines don't share a review loop; the contract lives where
   the shared maintainer reviews (fragua), and Ernesto pulls the mirror.
   ([`fact-taxonomy.md`](fact-taxonomy.md) sits in `proposals/` while v0;
   graduates to a top-level `docs/` contract doc on freeze.)
2. **Terminal status vocabulary.** The convergence onto one
   `fact.run_terminated { status }` forces one string set:
   `completed | failed | cancelled` (neutral, proposed),
   `completed | errored | aborted` (Ernesto's current wire, zero churn there),
   or `completed | halted | cancelled` (fragua's). The one string-level call
   convergence forces — [`fact-taxonomy.md`](fact-taxonomy.md) §3.1.
3. ~~**Token-shape alignment.**~~ **Resolved: both aliased.** The contract
   blesses both `steps.<id>.outputs.<path>` (Ernesto) and
   `outputs.<producer>.<field>` (fragua) as accepted spellings of a cross-step
   output read; neither engine has to rename. Cosmetic, and a hard rename
   would churn authored workflows for no behavioral gain.
4. ~~**`workflow:` resolution in the `fragua` step.**~~ **Resolved:
   file-based**, against the workdir's `.fragua/workflows/`. A fragua
   workflow with a `tool` node is arbitrary code execution in the pod, so
   its source must pass Ernesto's review gate — settle — as a sha-visible
   file in the workspace tree, not an inline blob in a step definition.
   Security requirement, not ergonomics.
