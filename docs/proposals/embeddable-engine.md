---
title: Embeddable engine — decouple core/executor from Bun, git/local-fs, and the dev domain
summary: "fragua's engine (graph + executor + folded event log) is generic enough to embed in non-dev systems (data analysis, image generation) — but three families of assumption from the seed use case (an AI coding agent over a git worktree, on Bun) have calcified into the reusable layers. This doc catalogues every verified leak (file:line on main) and lands one principle that fixes all of them: replace baked concretes with kind-tagged, opaque, registered injection points. Four axes — (1) outside Bun: split @fragua/store into a bun-free contract entry + a ./sqlite impl so the executor imports only IEventStore; (2) outside git/local-fs: a kind-tagged, opaque EnvRef on run_state + a SandboxProvider/Landing registry, so the executor never speaks git; (3) outside the dev domain: ExecutionEnvironment optional ('none' kind), tool-declared mutation (no hardcoded bash/write/edit), and a generic cost {unit,value} instead of tokens/costUsd; (4) the contract layers themselves — the git+token vocabulary is baked into @fragua/types' event taxonomy, store's schema, and core's read/intent planes (the embedder-facing surface), so the fix is a contract change ridden on EVENT_CONTRACT_VERSION + a reversible schema migration. A unifying sub-theme: the store has accreted four things that aren't coordination state (blobs, env provenance, credentials, provider config) — evict each to its own port with a store-backed default. NO CODE until the contract deltas + migration are pinned. SKETCH."
status: draft
maturity: sketch
last-reviewed: 2026-06-03
---

# Embeddable engine

> **Sketch.** The engine's *spine* — a graph compiled to a deterministic state
> machine, an executor that folds an append-only event log, content-addressed
> artifacts — is domain-agnostic and embeddable as a library. But the seed use
> case (**an AI coding agent over a git worktree, on Bun**) left three families
> of assumption baked into the reusable layers (`@fragua/types`, `@fragua/core`,
> `@fragua/store`): a **Bun** runtime dependency, a **git/local-filesystem**
> environment model, and a **software-development** domain. This doc maps every
> leak and lands one principle that fixes all of them. The contract deltas (new
> fact types, the generic `cost` shape, the schema migration) are **not pinned
> to the byte yet** — hence `sketch`.

## 1. The load-bearing principle

> **Replace baked concretes with kind-tagged, opaque, registered injection
> points.** Wherever the engine *names* a concrete — Bun's `bun:sqlite`, git's
> `baseGitSha`, the dev tool `bash`, the LLM's `tokens` — it should hold an
> *interface* it resolves at the edge. The dev/git/Bun implementation becomes
> **one registered backend**, not **the assumption**.

Why this is safe, and why it doesn't threaten rigor: **fragua's determinism is a
property of the folded log, not of re-execution** (SPEC §1). The log records
*that* a turn happened and its facts — never *how* it was produced or *where*
its side effects landed. So a Postgres store, a Docker sandbox, or a
warehouse-query capability is a different *body* under the same *control plane*;
replay-by-fold, OCC, and every operator intent are untouched.

## 2. Grounding (this doc is against `main`)

Everything here is verified on `main` (post-0.4.0). Three things that exist on
the in-flight `feat/structured-outputs` branch are **deliberately not assumed**:
typed step `outputs:` / `emit_output` / `$FRAGUA_OUTPUT` (being rethought), the
`parallel` node, and `fact.node_completed.outputs`. On `main`:

- the node model is `start | exit | llm | human | tool`;
- **data flows step-to-step through the shared `thread:`** (`graph.ts:40`,
  with `summary: low|medium|high` compression, `:35`) **and artifacts** — there
  is no typed-output data plane;
- the `tool` node is a **shell command** (`tool_command`) — and is itself slated
  for a redesign (§5), so this doc states the *requirement* it must satisfy and
  does not prescribe its shape.

Dependency picture:

```
web → server → store ← daemon → core ← agent      (cli sits above all)
              ↑ @fragua/types (leaf — imported by every package)
```

The audit's headline: git/fs/shell vocabulary *correctly* concentrates in the
backend/product layers (daemon, cli, workspace, agent, server) — those are the
**reference dev implementation**. The leak is only what climbed *below* them,
into `types` / `core` / `store`. Those descents are §§3–6.

## 3. Axis 1 — outside Bun

**Goal:** `@fragua/types`, `@fragua/core`, and the executor run on plain Node, so
the engine embeds by injecting a store impl.

**State:** ~90% done. `IEventStore` exists (`store/src/types.ts`, split into four
sub-interfaces), is bun-free, and the executor + all of `daemon/src` + `core`
depend on the *interface*, not `SqliteStore`. There are **zero** `bun:sqlite`
imports in `daemon/src` or `core/src`.

**The one blocker — the barrel.** `store/src/store.ts:1` does a value import
`import { Database } from "bun:sqlite"`, and `store/src/index.ts:66` re-exports
`SqliteStore` from it. Because ESM `export … from` eagerly evaluates the source
module, importing *anything* from `@fragua/store` (even the bun-free
`readActiveNodes`) drags `bun:sqlite` into the runtime graph; on Node it throws
at import.

**Fix — subpath split** (mirrors how `@fragua/core` already splits `./handler` /
`./intent-plane` / `./read-plane`):

- `@fragua/store` — bun-free contract + pure helpers: `types.ts`
  (`IEventStore`, event types, `ConcurrencyError`), `reducers.ts`,
  `routing-blobs.ts`, `run-id.ts`, the `pragmas.ts` constants, `scrub/`,
  `bundle.ts`, `sha256.ts`. Stop re-exporting `store.ts`.
- `@fragua/store/sqlite` — the Bun impl: `SqliteStore`, all `*-queries.ts`,
  `migrations.ts`, `sweep.ts`, `write-queue.ts`, `blob-fs.ts`.

Executor / `daemon/src` / `core` keep importing `@fragua/store` unchanged; only
the daemon **entrypoint**, **cli**, **server**, and tests switch their
`SqliteStore` import to `@fragua/store/sqlite`. Add a guard test asserting the
main entry has no `bun:sqlite` in its transitive graph.

## 4. Axis 2 — outside git/local-filesystem

**Goal:** the executor never speaks git. The environment is a generic substrate
(Docker pod, remote VM, or nothing), with git/worktree as *one* backend.

**Already clean.** `ExecutionEnvironment` (`core/types/execution.ts`) is the I/O
surface a handler sees — `cwd/projectCwd/readFile/writeFile/exists/exec/listDir/
glob` — and its header anticipates a remote/Docker backend. The leak is in the
*lifecycle around* it:

- `Provisioner` is git-typed (`daemon/worktree-provisioner.ts`): `baseGitSha()`,
  `baseGitRef()`, `snapshot(): SnapshotResult` (treeSha/commitSha/diffBaseSha).
- `WorktreeProvisioner` downcasts via `env instanceof WorktreeEnvironment`.
- the executor reads `provisioner.baseGitSha()` and stamps git fields onto
  `fact.run_started` (`events.ts:434`) and a `SnapshotResult` onto
  `fact.snapshot_recorded` (`events.ts:791`).
- accept/discard/diff (`workspace/run-actions.ts`) is `git cherry-pick`/`apply`/
  `diff` over `refs/fragua/{snapshots,heads}`.

### 4.1 The model — five-phase lifecycle, opaque provenance

A run environment is **the substrate where side effects happen**. Git/worktree
is one implementation of a five-phase lifecycle:

| Phase | Engine concept (kind-agnostic) | git-worktree | docker |
|---|---|---|---|
| **Provision** | acquire substrate → I/O surface + base provenance | `git worktree add` | `docker run` |
| **Operate** | `ExecutionEnvironment` reads/writes/execs | local fs + child_process | RPC into container |
| **Checkpoint** | recoverable snapshot at a boundary → opaque token | `write-tree` + snapshot ref | image commit / *none* |
| **Land** | apply or drop effects to the real target | `cherry-pick base..head` | `docker push` / promote |
| **Dispose** | release substrate | `git worktree remove` | `docker rm` |

**The load-bearing insight:** the executor only *triggers* lifecycle transitions
(a boundary — step/hitl/terminal — is an engine concept) and *stamps opaque
provenance tokens* it never interprets. `baseGitSha`/`diffBaseSha` are git's
*interpretation* of provenance and must not appear in the engine.

### 4.2 Proposed surface

```ts
type EnvKind = "none" | "local" | "git-worktree" | "docker" | string   // open union

type EnvProvenance = Record<string, unknown>   // backend-defined; engine stamps, only the provider reads
type ChangeSummary = { label: string; additions?: number; deletions?: number }   // kind-agnostic display

// What run_state carries — a reference to an env + its kind (separating env from run state):
interface EnvRef {
  kind: EnvKind
  locator: string | null         // worktree path / container id; null until provisioned
  status: "unprovisioned" | "provisioned" | "disposed"
  recoverable: boolean           // can this run resume / land on THIS host?
  base?: EnvProvenance           // captured at provision
  final?: EnvProvenance          // captured at terminal
  changeSummary?: ChangeSummary
}

interface SandboxProvider {      // generalizes Provisioner; no git in the signatures
  readonly kind: EnvKind
  provision(runId: string, spec: EnvSpec): Promise<{ env: ExecutionEnvironment; base: EnvProvenance }>
  checkpoint(runId: string, boundary: Boundary): Promise<{ token: EnvProvenance; change?: ChangeSummary } | null>
  dispose(runId: string): Promise<void>
  envFor(runId: string): ExecutionEnvironment | undefined
}
interface Landing {              // generalizes run-actions; resolved by ref.kind
  accept(ref: EnvRef, gate: RunActionGate): Promise<AcceptResult>
  discard(ref: EnvRef): Promise<DiscardResult>
  diff(ref: EnvRef, range?: DiffRange): Promise<string>
}
interface SandboxRegistry { get(kind: EnvKind): { provider: SandboxProvider; landing: Landing } }
```

This kills the `instanceof` downcast (provenance flows *out* of `provision`/
`checkpoint`), the git vocabulary in facts (→ `fact.env_provisioned.{kind,base}`
and `fact.env_checkpointed.{boundary,token,final?,change?}`), and the seven git
columns on `run_state` (→ one `env_ref` JSON column, with generated
`env_kind`/`env_status` if the UI filters on them).

### 4.3 Two sharp boundaries

- **`cwd` stays put.** It is the *only* project identity (`SELECT DISTINCT cwd`;
  there is no projects table). So `cwd` = project identity + provisioning
  *source* (→ `EnvSpec.source`); `EnvRef.locator` = provisioned substrate
  (*output*). Folding `cwd` into `EnvRef` breaks project listing. This finally
  disambiguates `cwd()` vs `projectCwd()`: source vs substrate.
- **Kind is decided at enqueue, not provision.** Today `WorktreeProvisioner`
  picks worktree-vs-local via `isGitRepo()` at provision time, inside the daemon.
  Move it to a `SandboxResolver(runRequest) → {kind, spec}` at enqueue, persisting
  `EnvRef{kind, status:"unprovisioned"}` into the genesis. Kind becomes part of
  the run's declared identity — which is what makes export/import honest without
  a daemon (§4.4).

### 4.4 Export/import — "env ready" vs not

A bundle carries the `EnvRef` but not the substrate (git snapshot refs live in
the repo, not the DB; a container lives on a host — see
[`archive/bundles.md`](archive/bundles.md)). So on import the engine states
honestly, with no git and no daemon: `status:"provisioned", recoverable:true` →
live/portable; `status:"disposed"` (the common exported case) → checkpoints
unreachable → **inspect-only** (replay the log, render `final.changeSummary`, no
land). The "ready vs not" distinction falls out of kind+status being declared
identity.

## 5. Axis 3 — outside the dev domain

**Already generic** (the good news): the node model; tool injection by name;
**artifacts** (content-addressed blobs keyed `(node, key)` with a `mime` — an
image is `image/png`, a dataset `text/csv`; no git/diff in the model); the
shared `thread:` (pi's content union is multi-modal — text/image/toolcall — so
non-text payloads ride natively); `ctx.artifacts.put()` + `ctx.http` on the
handler context (a tool produces bytes + calls an API with no filesystem).

**The reframe:** for non-dev domains the model isn't "shell + files," it's
"typed capabilities (tools) producing typed artifacts." The engine is already
that shape. The leaks (engine edits that unblock everything):

1. **`ENV_MUTATOR_TOOLS = ["bash","write","edit"]`** hardcoded
   (`core/types/read-only-env.ts:25`) — core knows dev tool *names*. → Make
   mutation a `Tool.mutatesEnv: boolean` each tool declares; the executor gates
   on "does the effective toolset contain any mutating tool." No names in core.
2. **`ExecutionEnvironment` is mandatory** — the `tool` handler hard-halts
   without it (`tool.ts:103-108`, "no execution environment wired"). → The
   `"none"` env kind (§4) makes it optional; a run whose tools are all
   API/artifact-based provisions no substrate.
3. **The `tool` node is a shell command** (`graph.ts:59` `tool_command`;
   `tool.ts:3` "runs `node.attrs.tool_command` as a single shell command") —
   the only non-LLM, non-human work primitive is shell. **Fix: OPEN.** The
   `tool` node is being redesigned independently; this doc only fixes the
   *requirement*: the engine needs a generic non-LLM work primitive that is
   **not hardwired to shell**, that produces results via the existing generic
   channels (`ctx.artifacts` + the shared `thread:`), and whose mutation posture
   it declares (#1). Whether that is "shell is one registered capability among
   many" or another shape is the redesign's call, not this doc's.
4. **Cost is token+USD-shaped.** `HandlerResult.transition` mandates `tokens` +
   `costUsd` (and LLM-cache splits); `fact.node_completed` carries them
   (`events.ts:465-466`); this propagates to `evaluateBudget`, node
   `max_tokens`/`max_cost_usd`/`budget_usd`, and the `total_cost_usd` /
   `billed_tokens` generated columns (`schema.sql:92-94`). A non-LLM step
   reporting `tokens:0` falsely reads as "no billable work." → Generalize to
   `cost: { unit: "usd"|"tokens"|"images"|"rows"|string; value: number }`, with
   budget ceilings denominated per unit. Tokens become *one* unit pi fills.
5. **Agent-layer dev defaults** (softer; the agent layer *is* the LLM backend,
   but these are baked rather than configured): `AGENTS.md`/`CLAUDE.md`
   auto-prepend, `context_files` as fs text, the `<project-conventions>` /
   `<environment>` framing, skills discovery over `.agents/skills/*/SKILL.md`. →
   Move to wiring-time config, following the persona pattern (already injected,
   not hardcoded). Skill *resolution* becomes a `SkillRegistry` port (§8) so a
   `"none"`-env run can load skills from a registry, not `env.readFile`.

## 6. The deepest finding — the contract layers bake git + cost

The coupling bottoms out **below** `core`, in the layers everything folds:

### 6.1 `@fragua/types/events.ts` — the canonical event taxonomy (the leaf)

Every package imports this. First-class, on `main`:
- **git:** `fact.run_started.{baseGitSha,baseGitRef}` (`:434`);
  `fact.snapshot_recorded` (entirely git — `:791`); `SnapshotStat`/`ChangeStat`
  (committed-vs-uncommitted); `fact.run_paused_human.payload.snapshot` (`:588`);
  `intent.accept_run`/`fact.run_accepted` ("replayed the run's commits", `:832`);
  `intent.discard_run`/`fact.run_discarded` ("deleted refs/fragua/…", `:366`).
- **LLM cost:** `fact.node_completed.{tokens,costUsd,…cacheReadTokens}`
  (`:465-466`); `intent.budget_adjusted.metric: "cost"|"tokens"`.

### 6.2 `store/src/schema.sql` — the persistence contract

`run_state` mirrors it: `base_git_sha` (`:86`), `final_git_sha` (`:103`),
`change_stat` (`:106`), `inbox_status`, `accepted_sha`, plus `total_cost_usd` /
`billed_tokens` generated columns (`:92-94`). And the two **squatter tables**
(§7): `provider_credentials` (`:304`), `provider_config` (`:323`).

### 6.3 `core` read/intent planes — the embedder-facing surface

- **Read-plane wire schema** (`read-plane/schemas.ts`) — `RunSummary`/`RunDetail`
  expose `changeStat` (`:77`), `baseGitSha` (`:82`), `worktreePath` (`:161`).
  This is what an embedder's UI deserializes.
- **A live filesystem syscall in core** — `read-plane/projections.ts:7,164`:
  `existsSync(join(state.cwd, ".fragua", "worktrees", state.runId))`. The
  engine's read plane reaches into the host filesystem and hardcodes the worktree
  layout. *The deepest leak — behavior, not a type.*
- **Intent plane** mirrors: `EnqueueRunParams` carries `baseGitSha`/`baseGitRef`/
  `cwd`/`workflowScope`/`workflowPath`.

**Implication:** the fix is a **contract change** — new fact types
(`fact.env_provisioned`, `fact.env_checkpointed` replacing the git payloads), the
`EnvRef` shape, generic `cost`. It rides `EVENT_CONTRACT_VERSION`
([`archive/event-contract-version.md`](archive/event-contract-version.md)) for
the fold contract and a reversible schema migration (shipped `{up,down}`
support) for the columns. Per ground rule #1 + the enum-literal-consumers note,
it is spec-first and touches every fold/projection/SQL consumer.

## 7. The eviction sub-theme — the store holds non-coordination state

`@fragua/store` is "the only coordination surface" (invariant #4). But it has
accreted four things that **neither fold nor coordinate**:

| Squatter | What it really is | Evict to | Default impl |
|---|---|---|---|
| Blobs (`BlobFS` + `blobs`/`artifacts` rows) | payload bytes | `IBlobStore` | `BlobFS` |
| `base_git_sha`… | environment | `EnvRef` / `SandboxProvider` (§4) | git-worktree |
| `provider_credentials` | secrets | `CredentialResolver` | `SqliteAuthBackend` |
| `provider_config` | configuration | config cascade / `ProviderRegistry` | store-backed |

This sharpens invariant #4 from *"the only place state transitions land"* to
*"the only place **coordination** state lives — not secrets, not config, not
payload, not environment."*

Two notes on the cut:
- **Blobs: split the byte CAS, not the metadata.** The `blobs`/`artifacts` *rows*
  are written in the same SQL transaction as the `fact.*` that references them, so
  they stay on `IEventStore`. The *bytes* are already physically separate
  (`BlobFS`, deliberately out of the WAL) — promote them to an injectable
  `IBlobStore { put(bytes)→sha; get(sha); has; delete }` the store *composes*.
  Safe because of the existing write-before-reference + GC-orphans discipline.
- **Secrets eviction explains the scrubber.** The secret-scrubbing machinery
  ([`secret-scrubbing.md`](secret-scrubbing.md)) exists *because* api keys live
  in `provider_credentials` and leak into bundles. A `CredentialResolver` (with
  the store-backed impl as default) lets an embedder source keys from env/vault
  and stops making secrets *mandatorily* part of the coordination DB. The engine
  depends on the port; the table is one resolver's storage detail — exactly like
  `BlobFS` is one `IBlobStore`.

## 8. The injection-point set (the spine)

The engine becomes a kernel with pluggable subsystems. The guard against config
soup: tier them.

```
Capability ports (must provide — define what the engine can do):
  IEventStore · IBlobStore · SandboxRegistry · ToolRegistry · SkillRegistry

LLM substrate (FIXED — see §9):
  pi-agent-core / pi-ai. The body is already an interface (one impl: PiLlmBackend
  in @fragua/agent); a CLI-subprocess body is a separate, compatible seam.

Policy defaults (override-only — sane default):
  Clock · IdGenerator · CostModel (generic cost {unit,value} for non-pi work)
```

`Clock` is already half-injected (the `now` hook on `ExecutorOpts`); `IdGenerator`
wraps `newRunId`; `HttpClient` (`ctx.http`) and the handler-resolver (`Dispatcher`)
are already clean seams — document, don't re-engineer.

## 9. Non-goals / fixed points

- **pi is the LLM substrate, not a seam.** It gives a generic message type that
  converts cleanly across providers, supports custom providers + hooks, and its
  multi-modal content union *helps* non-dev domains. `AgentMessage` is the
  canonical thread shape in `@fragua/types` **on purpose**; making the SDK
  swappable is a non-goal. `ModelRegistry` and `AuthStorage` stay pi/store-backed
  concrete classes (custom providers cover extensibility); only
  `CredentialResolver` is promoted to a port (§7).
- **The `tool` node redesign is separate** (§5.3). This doc states the
  requirement; the shape is owned by that work.
- **Structured step outputs are out of scope.** Data flow on `main` is the shared
  `thread:` + artifacts; the typed-output design is being reworked and this doc
  does not depend on it.

## 10. Complete leak inventory (file:line on `main`)

The implementation checklist.

### Axis 1 — Bun
| Leak | Location | Fix |
|---|---|---|
| Barrel pulls `bun:sqlite` | `store/src/index.ts:66` → `store.ts:1` | subpath split `@fragua/store/sqlite` |

### Axis 2 — git / local-fs
| Leak | Location | Fix |
|---|---|---|
| `Provisioner` git-typed + `instanceof` downcast | `daemon/worktree-provisioner.ts` | `SandboxProvider` (opaque) |
| executor stamps git on facts | `daemon/executor.ts` (run_started/snapshot) | stamp opaque `EnvProvenance` |
| git accept/discard/diff | `workspace/run-actions.ts` | per-kind `Landing` |
| git fact taxonomy | `types/events.ts:366,434,588,791,832` | `fact.env_provisioned`/`env_checkpointed` |
| git columns | `store/schema.sql:86,103,106` | one `env_ref` JSON column |
| read-plane git wire | `core/read-plane/schemas.ts:77,82,161` | `EnvRef` + `changeSummary` |
| **`existsSync` + `.fragua/worktrees` in core** | `core/read-plane/projections.ts:7,164` | `EnvRef.locator`, no syscall |
| intent-plane git params | `core/intent-plane/plane.ts` (`EnqueueRunParams`) | `EnvSpec` |

### Axis 3 — dev domain
| Leak | Location | Fix |
|---|---|---|
| hardcoded mutator tool names | `core/types/read-only-env.ts:25` | `Tool.mutatesEnv` |
| `ExecutionEnvironment` mandatory | `core/handler/handlers/tool.ts:103-108` | `"none"` env kind |
| `tool` node = shell command | `graph.ts:59`, `tool.ts:3` | **OPEN** — tool-node redesign |
| cost token+USD-shaped | `handler/types.ts`, `events.ts:465-466` | `cost {unit,value}` |
| `billed_tokens`/`total_cost_usd` cols | `store/schema.sql:92-94` | per-unit aggregate |
| skills/context_files/AGENTS.md defaults | `agent/system-prompt.ts` | wiring config + `SkillRegistry` |

### Eviction (§7)
| Squatter | Location | Port |
|---|---|---|
| blob bytes | `store/blob-fs.ts` | `IBlobStore` |
| credentials | `store/schema.sql:304` (`provider_credentials`) | `CredentialResolver` |
| provider config | `store/schema.sql:323` (`provider_config`) | config cascade / `ProviderRegistry` |

## 11. What stays product-layer (the boundary)

These *should* stay dev-specific — the reference product over the engine: the
web diff viewer, worktree inbox, `RunDetail` changeStat rendering, the CLI
`accept`/`diff` verbs, the coding system-prompt preamble, `CORE_TOOLS`
(read/write/edit/bash/grep), `WorktreeEnvironment`/`WorktreeProvisioner`/
`snapshotter`/`run-actions` (the git `SandboxProvider`+`Landing`), and
`PiLlmBackend`. The test: does it live in `web`/`cli`/`daemon`/`agent`/
`workspace` (fine), or did it climb into `types`/`core`/`store` (a leak)?
Axes 1–3 + the eviction are exactly the things that climbed.

## 12. Migration shape

Independently shippable, in order:

1. **Bun split** (Axis 1) — non-breaking, mechanical. Unblocks "executor as a
   Node library." No contract change.
2. **Eviction of blobs + creds + provider config** (§7) — `IBlobStore`,
   `CredentialResolver`, `ProviderRegistry` ports with store-backed defaults.
   Mostly interface extraction; the defaults preserve product UX.
3. **Generic cost** (Axis 3 #4) — `cost {unit,value}` on `HandlerResult` +
   `fact.node_completed`; tokens become the `"tokens"` unit. Reversible schema
   migration replacing the `billed_tokens`/`total_cost_usd` generated columns
   with a per-unit aggregate. Rides `EVENT_CONTRACT_VERSION`.
4. **`EnvRef` + sandbox registry** (Axis 2) — reversible migration collapsing the
   git columns into `env_ref`; new `fact.env_provisioned`/`fact.env_checkpointed`;
   `WorktreeProvisioner` → `GitWorktreeProvider`; `run-actions` → the `git`
   `Landing`. Read/intent planes carry `EnvRef`/`changeSummary`; the `existsSync`
   in `projections.ts` dies.
5. **Env-optional + tool-node redesign + `mutatesEnv`** (Axis 3 #1-3) — gated on
   the separate tool-node redesign.

Each contract step is a union edit: grep `packages/` for every enum/literal
consumer (the `RunStatus`/`FactEvent['type']` discipline), not just the
typecheck. Schema steps use the shipped reversible `{up,down}` migration support.

## 13. Open decisions

1. **Checkpoint timing.** Keep synchronous-in-the-OCC-txn (checkpoint lands
   before dispose, transactionally with the terminal fact), or allow async
   checkpoint backends? The latter weakens recoverability for backends that can't
   checkpoint cheaply — make `checkpoint()→null` + `recoverable:false`
   first-class either way.
2. **`none`/`local` landing.** Is a non-git run's `accept` a no-op, a copy-out,
   or unavailable? Determines whether "land" is universal or kind-gated.
3. **Cost scalar vs vector.** `cost {unit,value}` (one unit per node) or
   `Record<unit,value>` (a run mixes tokens + images + rows)? The vector is more
   honest for mixed pipelines but complicates ceilings.
4. **`CredentialResolver` shape for OAuth.** api_key is a pure lookup; OAuth needs
   refresh-under-lock — the port must accommodate the refresh path the
   store-backed `AuthStorage` does today without forcing every resolver to.

## 14. Relationship to other proposals

- [`workflow-ir.md`](workflow-ir.md) — the `NodeAttrs`→discriminated-union
  refactor (§8.4 there) is the IR cleanup the per-kind work here assumes; new
  node attrs / fact types ride its `ir_version` / contract axes.
- [`graph-as-data.md`](graph-as-data.md) — TS workflow authoring; same
  string→reference principle one altitude down (node ids, routes, thread
  membership as typed handles). Sketch.
- [`archive/event-contract-version.md`](archive/event-contract-version.md) — the
  fold-contract bump the new fact types ride.
- [`archive/bundles.md`](archive/bundles.md) — what an exported run carries;
  `EnvRef.status`/`recoverable` builds the import honesty (§4.4) on it.
- [`secret-scrubbing.md`](secret-scrubbing.md) — exists because secrets live in
  the store; the `CredentialResolver` eviction (§7) addresses the root.
