---
title: Tool-node production — typed `outputs:` on `tool` steps
summary: "A `tool` step may declare typed `outputs:` over the same grammar as `llm` steps and emit a struct forward without spending a model turn. The engine allocates a scratch file through a new `ExecutionEnvironment` capability, hands its path to the process in `$FRAGUA_OUTPUT`; the process writes one JSON document there in place (`command > "$FRAGUA_OUTPUT"`); the engine reads it back from the fd it retained (`O_CLOEXEC`) when it created the scratch inode — never re-opening the child-controlled path, so a child that swaps a symlink, FIFO, or device onto the path reads back empty (the retained fd stays pinned to the regular inode the engine created) and fails closed, bounded by `maxBytes+1` independently of any stat, and with an abort discriminated in the read-back catch so a mid-read cancel lands as a terminal halt instead of being mislabeled a fault that advances past the cancel — validates against the node's TypeBox schema, and attaches it to `fact.node_completed.payload.outputs` — the same fact field, index, blob-spill, and `${{ outputs.X.f }}` resolver the `llm` producer already uses. A declared output the process never leaves on the retained inode (absent/oversized/unparseable/invalid) is a node failure, not an empty struct — the producer-side dual of the fail-closed read. The scratch path is deterministic in `(run, node, iteration)` and, at allocation, unlinked then re-created `O_CREAT|O_EXCL|O_CLOEXEC` with the fd retained for read-back — a failed create is a hard node failure, so a re-run answers "did this dispatch emit?" without a nonce and without an orphan-GC sweep (a bounded, self-healing `SIGKILL` leak is deferred behind a Door). No new fact type, no reducer change, no `EVENT_CONTRACT_VERSION` bump: the touch surface is an optional scratch capability on `ExecutionEnvironment` (both `LocalEnvironment` and `WorktreeEnvironment` in `@fragua/workspace`), the tool handler, the daemon plumbing that threads the node's `outputs:` decl into the tool handler, a parser type-gate loosening, and an `ir_version` bump plus a converter. A producing tool stays side-effect-bearing (`external`) and stays outside fan-out branches; provable purity, and data-driven routing on the emitted value, are named as separate future doors."
status: shipped
maturity: shipped
last-reviewed: 2026-06-16
---

# Tool-node production — typed `outputs:` on `tool` steps

> **Status: SHIPPED (#80).** `type: tool` now accepts typed `outputs:` and emits
> a struct forward by writing one JSON document to `$FRAGUA_OUTPUT`, read back
> after the process exits through a retained scratch-file fd (never re-opening
> the child-controlled path) and validated against the declared schema; a tool
> that exits 0 without a parseable, valid struct fails the node. The parser gate
> widened to admit `tool` (mint E053 for any other type); `ir_version` bumped to
> 5 with an identity converter; no fact type, reducer, or `EVENT_CONTRACT_VERSION`
> change. The landed design follows this proposal's retained-fd channel; two
> nuances below are simplified in the shipped code — the scratch fd relies on
> Node's default close-on-exec rather than an explicit `O_CLOEXEC` flag, and the
> `renamed` diagnosis is a metadata-only inode comparison run before `dispose()`.
> The deferred Doors (proactive scratch-root GC, remote-backend read-back,
> data-driven routing on the emitted value) remain open.
>
> **Status (original): proposal, UNREVIEWED.** Produced by a `propose` run that paused on
> its cost budget at the `feasibility` node before a human read it, and checked
> in as-is so the design isn't lost. Treat every claim as a candidate, not a
> settled decision. Its own arbitration pass returned `revise` from three of
> five lenses and left four blocking items unresolved, recorded alongside it in
> [`tool-outputs.critique.md`](tool-outputs.critique.md). B2 is the one to read
> first: the retained-fd read-back cannot see an atomic save
> (`cmd > tmp && mv tmp "$FRAGUA_OUTPUT"`), so the most common safe write idiom
> is misreported as `no_emission`. Tracked by #80.
>
> **Status: proposal.** Additive. Adds `outputs:` on `tool` steps and a single
> emission channel (`$FRAGUA_OUTPUT`, a scratch-file path passed through env,
> allocated and read back through a new `ExecutionEnvironment` capability).
> Reuses the whole structured-outputs spine on the write side: the type grammar,
> the `(run_id, node_id, iteration)` index, `fact.node_completed.payload.outputs`,
> blob spill, and the `${{ outputs.X.f }}` resolver. Ships as an `ir_version`
> bump plus a converter — no new fact type, no reducer change, no
> `EVENT_CONTRACT_VERSION` bump. It reverses the tool-node production ban stated
> in SPEC §3.8 and ARCHITECTURE.md §5 (quoted and marked-reversed in *Contracts
> reversed* below) and changes nothing already authored.
>
> **Dependency.** The `run:` + env core works against the tree today. The
> `exec:` and `idempotent:` arms below assume the still-unmerged
> [`tool-exec-variant.md`](tool-exec-variant.md) (`exec:` per-argument
> substitution; the `idempotent:` marker) — they are additive over this proposal
> and land with, or after, that one.

## The problem

`tool` nodes are side-effect-only. SPEC §3.8: "exit 0 → `outcome=success`,
non-zero → `outcome=fail`. They do not *produce* data forward (they consume
`${{ … }}` in `run:`)." The handler enforces exactly this — the tool handler's
`HandlerResult` is a bare transition carrying `outcomeStatus` and zeroed
tokens/cost, never an `outputs` field. The only writer of `result.outputs` today
is the `llm` backend.

The consequence is that **fragua has no node that is simultaneously (a)
deterministic and (b) able to hand a value to a downstream step.** The prescribed
workaround (SPEC §3.8: "call the script from inside an llm step's bash tool")
buys the data by spending a model turn — it puts a nondeterministic component in
a path whose whole point was determinism, opens a fresh prompt-injection surface
(the script's stdout re-enters as prompt text), and adds a cost/latency line.

This is load-bearing, not theoretical:

- **fragua's own workflows pay the tax.** `review.yaml`'s `prep_diff` is a
  `type: tool` step that materialises the diff for the read-only lens branches and
  already carries a hand-rolled git-option-injection hardening comment — but it
  cannot hand any computed value forward, so the six lenses re-read
  `review-diff.patch` off disk. `ocr_review.yaml`'s `select` step (a faithful port
  of Alibaba's open-code-review) is authored `type: llm` with
  `allowed-tools: [read, grep, bash]` and a prompt that instructs the model "Use
  `bash` (git) — do NOT guess" and hand-rolls ref-injection validation, to do work
  its own comment calls "Engineering, not the LLM." It is a shell script wearing a
  model — and it computes the map fan-out cardinality, so the number of concurrent
  branches in a run is decided by a model turn.
- **The external case.** Ernesto's `content://autofill-product` is a 53-agent
  pipeline whose entire connective tissue is one pure function
  (`content://autofill-glue`, ~260 lines, no I/O) called at four phase boundaries
  to compute gate booleans and prompt strings, ported byte-for-byte from the prior
  orchestrator (which is what made cutover verifiable). In fragua today this needs
  four `llm` steps whose only job is to shell out to a pure function and re-emit
  its output — four model turns in the deterministic spine, and the
  byte-identical-prompt property becomes unverifiable.

structured-outputs.md §10.3 already named this the deferred follow-up its MVP
contract admits without a rewrite: "**Tool-step production (`$FRAGUA_OUTPUT`)** —
the gather→judge composition (a `tool` emits structured evidence an `llm`
judges)." This proposal walks through that door.

## The design

A `tool` step gains an optional `outputs:` block, declared over the **identical**
type grammar `llm` steps use (scalars / `choice` / records via `fields` / arrays
via `items`; no recursion, no `$ref`). `outputs:` and `routes:` stay mutually
exclusive on a `tool` step exactly as on an `llm` step: the parser already
rejects a step that declares both (`packages/core/src/parser/yaml.ts:661` — a
`ParseError`, fired *after* the type gate that today rejects `outputs:` on any
non-`llm` step). This proposal loosens that type gate to admit `tool`, so the
same both-declared `ParseError` begins covering `tool` nodes with no new check
(see *Validation* below). When a tool declares `outputs:`, the engine gives the
process a place to write the struct and reads it back after the process exits.

### The emission channel: `$FRAGUA_OUTPUT`

The engine allocates a scratch file at a **deterministic, per-node path outside
`cwd()`** (so the file never enters a snapshot delta or a `fragua runs diff`),
**unlinking any file already at that path and then creating a fresh inode with
`O_CREAT | O_EXCL`**, passes its absolute path to the process as the environment
variable `FRAGUA_OUTPUT`, and reads it back after the process exits. The process
writes exactly one JSON document to that path. The checked create is load-bearing
for fail-closed (§ *Deterministic path, unlink then checked create* below): a
redispatch or `idempotent:` auto-re-run starts from a fresh inode, so it never
reads a leaked prior attempt's bytes — and a stale file that survives a failed
unlink is a loud allocation failure, not a silent stale read.

#### The scratch capability on `ExecutionEnvironment`

The read-back cannot use the environment's existing surface. `env.readFile`
resolves its argument against `cwd()` and throws `PathEscapeError` for anything
outside that jail (`packages/workspace/src/local-env.ts:139–160`), which is
exactly where the scratch file must live; and the tool handler is in
`@fragua/core`, where ground rule 9 bans `node:fs`. So the mechanism needs a
new, small capability on `ExecutionEnvironment`
(`packages/core/src/types/execution.ts`). It is declared **optional** (`?`) so
adding it does not fan out to every `ExecutionEnvironment` implementor — in
particular the `makeReadOnlyEnv` object literal in
`packages/core/src/types/read-only-env.ts`, which would otherwise fail `strict`
typecheck the moment a required method landed. It is implemented on the two real
spawning environments — `LocalEnvironment` and `WorktreeEnvironment`
(`@fragua/workspace`) — and the tool handler guards on its presence (§ *Handler
flow*):

```ts
/** Allocate a scratch file for out-of-band IPC with a spawned process
 *  (e.g. `$FRAGUA_OUTPUT`), at a DETERMINISTIC path keyed by
 *  (run, node, iteration). Unlinks any file already at that path, THEN
 *  creates the scratch inode itself with O_CREAT | O_EXCL | O_CLOEXEC and
 *  RETAINS the returned fd. The read-back reads from THAT retained fd, never
 *  by re-opening the child-controlled path — so the bytes read are always the
 *  regular inode this allocation created, whatever the child later plants at
 *  the path. If the unlink silently failed (best-effort, or a child chmod'd
 *  write-perm off the run subtree), the O_EXCL create fails EEXIST and this
 *  method REJECTS — the caller maps a rejected allocation (EEXIST/EACCES) to a
 *  HARD node failure, never a silent proceed onto a stale inode. Fail-closed
 *  therefore depends on this CHECKED create PLUS the RETAINED fd. The child
 *  writes IN PLACE (`command > "$FRAGUA_OUTPUT"` truncates the engine-created
 *  inode); atomic-rename-over-the-path is NOT supported — a rename swaps the
 *  path to a new inode the retained fd never sees. read() DETECTS that case via
 *  a diagnostic, metadata-only stat and returns `renamed`, which the handler
 *  fails closed with an actionable `producer.rename_not_supported` fault naming
 *  the in-place-`>` requirement, rather than silently misreporting it as
 *  `no_emission`. The path is OUTSIDE cwd() — it never enters a snapshot delta —
 *  and neither the create nor the read touches the cwd-jailed
 *  readFile/resolvePath. Optional: only the spawning environments implement it;
 *  a producing tool never runs in an env that lacks it (see Handler flow).
 *  Rejects on allocation failure. */
createScratchFile?(key: ScratchKey): Promise<ScratchFile>;

interface ScratchKey {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
}

interface ScratchFile {
  /** Absolute deterministic path, outside cwd(); hand this to the child via
   *  env. Any file previously at this path was unlinked at allocation, then a
   *  fresh empty inode was created with O_CREAT | O_EXCL | O_CLOEXEC and its fd
   *  retained. The child writes into it IN PLACE (`> "$FRAGUA_OUTPUT"`
   *  truncates the same inode); it must NOT atomic-rename over the path — a
   *  rename the retained fd never sees is detected (via a diagnostic stat) and
   *  reported as `renamed`, a named node failure, not a silent success. */
  readonly path: string;
  /** Read back this dispatch's file from the RETAINED fd (pread from offset 0),
   *  bounded independently of any stat. Because the read uses the fd the engine
   *  retained at O_EXCL-create — not a re-open of the child-controlled path — it
   *  is inherently safe against a child that swaps a symlink, FIFO, device, or
   *  directory onto the path: the fd stays pinned to the regular inode the
   *  engine created, so `ln -sf /dev/zero "$FRAGUA_OUTPUT"`, `mkfifo …`, and a
   *  symlink swap all leave the retained fd reading the original inode the
   *  engine created (empty unless the child wrote to it in place before
   *  unlinking the path) → `absent` → fail-closed. There is no
   *  open() on a child-controlled path to wedge, so no O_NONBLOCK/O_NOFOLLOW,
   *  no fstat classifier, and no blocking window are needed.
   *   - read at most maxBytes+1 bytes into a fixed buffer; { kind: "oversize" }
   *     iff the (maxBytes+1)-th byte exists. The read never allocates the whole
   *     payload and never trusts a stat-reported size.
   *   - `signal` bounds the bytewise read loop for defence in depth.
   *  `absent` when this dispatch's process left no bytes on the retained inode
   *  AND the path was not swapped to a different inode carrying bytes — the
   *  process never wrote (no valid JSON is zero-length). `renamed` when the
   *  retained inode is empty BUT a DIAGNOSTIC-only fstat(retained fd) vs
   *  stat(path) shows the path now resolves to a DIFFERENT regular inode holding
   *  bytes: the child wrote via a temp-file + `mv`/`sponge`/`--output`/atomic-
   *  save idiom the retained fd never sees. That stat reads metadata only, never
   *  a byte, so it does NOT re-open the child-controlled path for reading and
   *  re-introduces none of the FIFO/device/blocking class — it exists solely so
   *  the handler can name the in-place-`>` requirement instead of misreporting a
   *  correct-looking command as `no_emission`, and it runs before `dispose()`
   *  unlinks the evidence. A symlink/FIFO/device swap stat-reports size 0 or a
   *  non-regular type (not bytes on a new regular inode) and stays `absent`.
   *  The checked O_EXCL allocate means a stale prior-attempt file can never
   *  satisfy the read: a surviving stale file fails the allocate loudly instead.
   *  Never resolves through resolvePath for reading. */
  read(maxBytes: number, signal: AbortSignal): Promise<
    | { kind: "absent" }
    | { kind: "renamed" }
    | { kind: "oversize" }
    | { kind: "ok"; text: string }
  >;
  /** Close the retained fd and unlink the path; idempotent, never throws —
   *  safe to call on every exit path. */
  dispose(): Promise<void>;
}
```

#### Deterministic path, unlink then checked create

Both implementations mint the path under a **run-keyed** OS-temp subtree,
`<tmp>/fragua-scratch/<run_id>/<node_id>-<iteration>` (never under `cwd()`) —
deterministic in the `(run, node, iteration)` key, no nonce. The `iteration` in
that key is the executor's **per-node re-entry/retry counter**
(`HandlerContext.iteration`, `handler/types.ts:158` — "0 on first entry; bumped
every time a backward edge returns control to this node", used to key idempotency
hashes), **not** a monotonic total-dispatch counter. That semantic is
load-bearing: a crash-restart re-dispatch of the same node reuses the *same*
`(run, node, iteration)` key (`types.ts:349`, "re-dispatches the same `(nodeId,
iteration)`"), which is exactly why the allocate below can unlink (and, failing
that, loudly reject on) the prior attempt's scratch file, and why the `INSERT OR
REPLACE` outputs write supersedes a partially-recorded first struct. A future
change to `iteration`'s meaning must revisit this mechanism.

`createScratchFile` **unlinks any file already at that path, then creates the
inode itself with `O_CREAT | O_EXCL | O_CLOEXEC` and retains the returned fd for
the read-back.** Two properties fall out:

- **Snapshot-exclusion by construction.** The path is outside `cwd()`, so it is
  invisible to the diff/snapshot machinery without any in-worktree carve-out.
- **Fail-closed by a checked allocation, not a best-effort unlink.** The `O_EXCL`
  create — not the unlink — answers "did *this* dispatch emit?" without a nonce,
  **and without trusting the unlink to have succeeded.** A redispatch or an
  `idempotent:` auto-re-run gets a freshly created, empty stub; if this process
  exits 0 without writing, `read()` observes `absent` (the zero-length stub) and
  the node fails closed. The dangerous case is a crash *inside the read-back
  window*: the child wrote a valid struct and its side-effect completion
  committed, but `fact.node_completed` did not (so the run is not quarantined and
  carries no orphan intent); a restart then re-dispatches at the same `(run, node,
  iteration)` key. If the allocation-time unlink *silently failed* (best-effort,
  or the child `chmod`'d write-perm off `<tmp>/fragua-scratch/<run_id>/`), a
  best-effort unlink **alone** would leave that stale-but-*valid* file in place,
  and a re-run child that exits 0 without re-writing — exactly the case
  fail-closed exists to catch — would read it and the node would wrongly
  **succeed** with a struct this dispatch never computed. `O_EXCL` closes that
  hole: the create fails `EEXIST` on the surviving file, and a failed allocation
  (`EEXIST`/`EACCES`) is a **hard node failure**, never a silent proceed onto a
  stale inode. POSIX unlink-then-create also hands a re-run a fresh inode even
  against a zombie writer still holding the old fd; the re-run reads its own
  retained fd on the new inode, so a zombie's writes land on the old, unlinked
  inode and never reach the read. (A prior dispatch's zombie that reopens the
  *path* after the re-run's `O_EXCL` create writes to the re-run's inode; the
  worst it can do is interleave bytes into a document that then fails to parse —
  fail-closed, never a wrong success.) The nonce the earlier draft carried bought
  nothing this checked create plus the retained fd does not.

This is also why the scratch file does **not** violate I2 ("no handler state
outside the projection"): it is transient IPC consumed *within a single handler
invocation*, unlinked before the handler returns via `dispose()`, and reconciled
against a leak by the *next* allocation's unlink rather than persisted for a later
read. Replay never reads it (the emitted struct is folded from
`fact.node_completed`, § below). It is a pipe, not state.

#### Cleanup

**Cleanup is best-effort, and correctness never depends on it.** The handler
calls `dispose()` in a `finally`, so the retained fd is closed and the file
unlinked on every *reached* exit path — valid emission, fault, non-zero exit,
abort, or spawn crash. `dispose()` is idempotent and swallows a missing-file
unlink and a double-close, so a double-dispose is harmless.

`finally` does **not** run on `SIGKILL` / OOM, so a hard-killed daemon leaks the
scratch file (and its still-open fd, which the OS reclaims on process death) for
a dispatch that was in flight. That leak is **bounded and
self-healing**: the path is deterministic in `(run, node, iteration)`, so there is
at most one file per key, and the *next* allocation at that key — the re-run after
the daemon restarts — unlinks it before use. A terminal run that never re-runs
leaves at most one small file per producing dispatch under
`<tmp>/fragua-scratch/<run_id>/`, in the OS temp dir the OS itself reclaims. **No
proactive sweep ships here.** A daemon-boot or run-terminal GC of the scratch root
is a *Door* (§ *Doors* below), not a correctness or hygiene requirement — and a
sweep keyed on run-terminal facts could not reconcile `fragua ci` / imported-run
subtrees across stores anyway, so its hygiene value is marginal and it is deferred
rather than half-built.

The channel is a **file path passed through env**, and nothing else:

- Presence is unambiguous. "Did it emit?" is "does the file exist and parse?" —
  not a heuristic over a stream that already carries logs.
- It is injection-inert. `$FRAGUA_OUTPUT` is an environment variable, never part
  of the command string; a producing tool adds no new execution surface (see
  *Blocklist* below).
- It is identical across `run:` and `exec:`. The variable rides `execve`
  unchanged, so the two invocation forms behave the same (tool-exec-variant §2.1
  already reserves "a future `$FRAGUA_OUTPUT`" as env through `execve`).
- stdout is already claimed. The tool handler streams stdout/stderr as
  observability chunks and a `tool_node` diagnostic message; a producer needs an
  out-of-band channel, and a file path is the only one that satisfies all three
  properties above.

### How the `outputs:` decl reaches the handler

The schema the handler validates against is the node's `outputs:` decl, and it
has to travel from the parsed IR into the tool handler through the daemon.
Today the tool handler is assembled in
`packages/daemon/src/auto-dispatcher.ts` — `specForNode(node.id, kind, edges,
node.attrs, …)` builds a `ToolConfig` (`{ toolCommand }`) and calls
`makeToolHandler`; `ToolConfig` carries no `outputs`, and `HandlerContext` has no
node attrs. This proposal threads the decl explicitly: `specForNode` reads
`node.attrs.outputs` (the `OutputsDecl` the parser already produces for `llm`
steps, now admitted on `tool` nodes) and passes it into `ToolConfig`
(`{ toolCommand, outputs }`), widening the `attrs` param `specForNode` passes
into `ToolConfig` to carry `outputs`; `makeToolHandler` closes over it and, when present, compiles it
once and runs the read-back-and-validate flow. The scratch *key* does not travel
this path: `specForNode` runs at graph-load time and has no per-dispatch
`runId`/`iteration` to supply. The handler mints the `ScratchKey` at run time
from `ctx.runId` / `ctx.nodeId` / `ctx.iteration`, which are already present on
`HandlerContext` (`handler/types.ts:88–90`) — so **no `HandlerContext` change is
needed.** `@fragua/daemon` is therefore part of the touch surface (see
*accounting* below).

### Handler flow

When the node declares `outputs:`, the tool handler calls
`ctx.env.createScratchFile?.({ runId: ctx.runId, nodeId: ctx.nodeId, iteration:
ctx.iteration })` — building the key from the `HandlerContext` fields, not from
anything `specForNode` passed — before spawning, adds `FRAGUA_OUTPUT=<path>` to
the child environment, and runs the command through `ctx.env.exec` as today.
Because the capability is optional (§ above), the handler guards: if a node
declares `outputs:` but `ctx.env.createScratchFile` is absent, it is
`outcome=fail` / `producer.invalid_emission` — a producing tool must run in a
spawning environment, and both real ones (`LocalEnvironment`,
`WorktreeEnvironment`) implement it, so this guard fires only on a misconfigured
env, never in normal execution. On process exit, in order:

1. **Non-zero exit → `outcome=fail`**, unchanged. The output file is not read; the
   node failed for the existing reason. (`dispose()` still fires in `finally`.)
2. **Exit 0, no `outputs:` declared** → `outcome=success`, unchanged. The tool is
   side-effect-only; nothing is read.
3. **Exit 0, `outputs:` declared:** read back from the retained fd via
   `scratch.read(FRAGUA_OUTPUT_MAX_BYTES, ctx.signal)`. A symlink/FIFO/device/
   directory the child swaps onto the path cannot be read at all — the retained
   fd stays pinned to the regular inode the engine created, so a swap reads back
   as `absent` (a temp-file rename is separately reported as `renamed`, below)
   and fails closed (§ *Bounded read from the retained fd* below);
   there is no separate `invalid` kind because there is no open() on a
   child-controlled path to classify.
   - `{ kind: "oversize" }` (more than the cap of bytes present) → **`outcome=fail`**,
     fault `producer.invalid_emission`. The bytes past `maxBytes+1` are **never
     read** (§ *Bounded read from the retained fd* below).
   - `{ kind: "renamed" }` (the retained inode is empty but the path now holds
     bytes on a *different* inode — a temp-file + `mv`/`sponge`/`--output`/
     atomic-save idiom the retained fd never sees) → **`outcome=fail`**, fault
     `producer.rename_not_supported`, whose `failureReason` names the
     in-place-`>` requirement (`command > "$FRAGUA_OUTPUT"`). The `renamed`
     kind is produced *before* `dispose()` unlinks the path, so the diagnostic is
     captured rather than the evidence destroyed silently, and the detection is a
     metadata-only stat — the path is never re-opened for reading (§ *Bounded
     read from the retained fd* below).
   - `{ kind: "absent" }`, or the returned text is unparseable JSON, or the
     parsed value fails `validateOutputsValue` against the node's compiled schema
     → **`outcome=fail`** with a named fault (`producer.no_emission` for absent,
     `producer.invalid_emission` for unparseable/invalid). This is the
     producer-side dual of the fail-closed read (§ below): a tool that exits 0
     without emitting a valid declared struct is a **node failure**, never an
     empty struct.
   - If `read()` itself throws, the handler **discriminates abort from I/O in
     the catch, before mapping to any fault** — the same carve-out `tool.ts`'s
     exec path already makes (`isAbortError → halt`, `tool.ts:159–164`). A
     cancel or deadline that fires on `ctx.signal` *during* the read-back throws
     `AbortError`; the handler must check `isAbortError(err)` first and, on a
     hit, return the same `{ kind: "halt", reason: "error" }` shape the exec path
     already returns for `"tool aborted"` (`tool.ts:159–164`) — the shape that
     lands terminally (as `errored` via `result-to-facts`), so the run cannot
     advance *past* the cancel — **not** swallow it into a transition-fail.
     Mislabeling a mid-read cancel as
     `producer.invalid_emission` would let the run advance *past* the cancel with
     the abort lost — the exact regression this carve-out prevents. **Only** a
     genuine non-abort I/O error (an unreadable mount, a broken path) maps to
     `outcome=fail` / `producer.invalid_emission` — recoverable on a `fail` edge,
     replayable, never a run-fatal `halt`. A hostile or broken *emission* (as
     opposed to an abort) fails *the node*, never the run.
   - `{ kind: "ok" }` that parses and validates → the handler sets
     `result.outputs` to the validated struct; `outcome=success`.

The validation reuses the shared type-grammar→TypeBox compiler and value
validator that back `emit_output` for `llm` steps — `compileOutputsToTypeBox` /
`validateOutputsValue` already live provider-agnostically in
`packages/core/src/types/outputs.ts` and are imported *from* `@fragua/core` by
the `@fragua/agent` backend (`backend.ts:24,30`). The tool handler (also in
`@fragua/core`) calls the same two functions directly — no lift, no new
dependency. The grammar, the compiler, and the validator stay one implementation
with two callers.

#### Bounded read from the retained fd

The emission is attacker-controlled: the process decides what sits at
`$FRAGUA_OUTPUT` when it exits, and a read that **re-opened** that path would be
defeated by one level of indirection — `ln -sf /dev/zero "$FRAGUA_OUTPUT"; exit 0`
makes a `stat` follow to a device reporting `st_size=0`, and a full read would
stream `/dev/zero` unboundedly into a JS string, OOMing the single daemon and
killing every concurrent run; `mkfifo "$FRAGUA_OUTPUT"` blocks a `read`/`open`
forever with no writer, and **`ctx.signal` cannot rescue it** — an `AbortSignal`
cannot cancel a syscall already wedged in the libuv threadpool. This design
sidesteps the entire class by **never re-opening the child-controlled path.**
`createScratchFile` already holds the fd of the regular inode it created
(`O_EXCL | O_CLOEXEC`), and `scratch.read()` `pread`s from that retained fd. The
bytes read are always the inode the engine created, whatever the child later
plants at the path:

- **Read from the retained fd, never a re-open.** A child that `ln -sf /dev/zero`,
  `mkfifo`s, or symlink-swaps the *path* changes nothing the retained fd sees: it
  is pinned to the original regular inode (the child must `unlink` the path first,
  which leaves that inode intact but empty). The read comes back `absent` and
  fails closed. Because there is no `open()` on a child-controlled path, there is
  no FIFO/device/symlink class to defend — no `O_NONBLOCK`/`O_NOFOLLOW`, no
  `fstat` classifier, no `{ kind: "invalid" }` branch, no TOCTOU window, and no
  blocking-open wedge to bound. The whole hardened-read apparatus an earlier draft
  carried was paid for solely by re-opening the path; retaining the fd deletes it.
- **A rename is diagnosed, not silently swallowed.** On the `absent` branch
  *only* — the read already having found the retained inode empty — a
  metadata-only `stat` on the path (compared to `fstat` on the retained fd)
  distinguishes a temp-file + atomic-rename idiom (path now a *different* regular
  inode carrying bytes) from a genuine no-write, and returns `renamed` for the
  former. This reads **no bytes** off the child-controlled path — it is a
  metadata comparison, not a re-open for reading — so it re-introduces none of the
  DoS class the retained fd removed (a symlink to `/dev/zero` stat-reports size 0,
  a FIFO/device stat-reports a non-regular type; neither is a regular inode with
  bytes, so both stay `absent`). It exists solely so the handler can return
  `producer.rename_not_supported` — naming the in-place-`>` fix — for the common
  safe idioms (`jq . in > tmp && mv tmp "$FRAGUA_OUTPUT"`, `--output`, `sponge`)
  instead of the misleading `no_emission`, and it runs before `dispose()` unlinks
  the evidence.
- **Bound the read independently of any stat.** `pread` from offset 0 at most
  `maxBytes + 1` bytes: `{ kind: "oversize" }` iff the `(maxBytes+1)`-th byte
  exists. Neither the read nor `JSON.parse` ever sees a payload larger than the
  cap, so neither can allocate an unbounded string. The 4 KB payload cap does not
  help here: it applies at `appendFact`, long after the struct would already be in
  memory.
- **`ctx.signal` bounds the read loop for defence in depth.** The bytewise read
  honours `ctx.signal`. Because the read is a `pread` on a regular local inode the
  engine already holds open, it cannot wedge on a child-controlled non-regular
  path — the threadpool-uninterruptibility hazard is gone on the local/worktree
  backend, not merely bounded. (A remote backend that *cannot* retain the fd
  across the child — spawning into a separate namespace or host — would have to
  re-open by path and re-introduce this class; that read-back is a Door, §
  *Doors*. Any such implementation must state the hardening correctly: a terminal
  symlink is rejected at `open()` with `ELOOP` via `O_NOFOLLOW` and surfaced as
  `{ kind: "invalid" }` from inside `read()`, *separately* from an `fstat`
  non-regular check — FIFO/device/directory on a successful open — and the
  residual blocking-mount wedge on a *regular* file bounded by a hard-killable
  read worker, not by `ctx.signal`.)

The read buffer grows incrementally toward `FRAGUA_OUTPUT_MAX_BYTES` (8 MiB)
rather than allocating the cap upfront, so the transient memory cost tracks the
actual emission size and is ceilinged at 8 MiB × concurrent producing dispatches
— a bounded, per-node cost with no persistence, well under the daemon's working
set at any realistic concurrency.

`FRAGUA_OUTPUT_MAX_BYTES = 8 MiB`, the same 8 MiB value as the tool handler's
existing stdout `SOFT_CAP_BYTES` (`tool.ts:321`) — comfortably above any struct that legitimately
spills to the blob CAS, and a documented, single knob. An oversized or malformed
emission is a per-node `producer.invalid_emission` failure, not a run-global
outage.

#### Where the fault name lives

`failureReason` on the fail transition carries the producer fault as a
human-displayed diagnostic string — for example, `producer.no_emission` (absent),
`producer.rename_not_supported` (bytes on a renamed-over inode the retained fd
never saw), or `producer.invalid_emission` (unparseable / oversize /
schema-invalid).
It has no programmatic branch point in the engine (no reducer or edge selector
matches on its value), so these strings are **illustrative labels, not required
constants** — the exact wording is a readability choice, not a contract, and no
test or UI should pin the literal. It is the field the tool handler *already* uses
for its
consumer-side fail-closed path
(`tool.ts:100–102`, `failureReason: err.message` on `UnpopulatedOutputError`).
`failureReason` is the terminal home for the producer fault, exactly as it is for
the consumer fault — the producer path is the symmetric dual and shares the field.
No new `HandlerResult` field, no `fact.node_completed.payload` field, and no new
observability field: adding any of them would be surface this design does not
need. No requirement for fail-edge fault-visibility beyond the existing
`failureReason` path is documented anywhere in fragua's contracts, and the
pre-existing consumer-side fail-closed path (`UnpopulatedOutputError`) already
lives on `failureReason` alone with the identical characteristics — so the
producer path matches it rather than adding more.

### Fail-closed parity

The structured-outputs principle — "reading an output a producer never populated
is a loud, recoverable, replayable halt, never a silent `""`" — holds identically
here, on both sides:

- **Consumer side (unchanged):** `${{ outputs.X.f }}` that resolves to a struct a
  tool producer never populated throws `UnpopulatedOutputError` → the consuming
  node fails closed.
- **Producer side (new):** a tool declaring `outputs:` that ends without a valid
  emission is `outcome=fail`. The failure is a recorded `fact.*`, so it folds
  identically on every replay.

A large *valid* emission is bounded at read (`FRAGUA_OUTPUT_MAX_BYTES`) but not at
*interpolation*: the type grammar caps neither array nor string length, so a big
struct read into a downstream `run:` argument can still exceed `ARG_MAX` and fail
at spawn. That is a pre-existing property shared with every `llm` producer, caught
at runtime — not introduced or changed here.

Replay never re-executes the shell: the emitted struct (or the failure) is
recorded on `fact.node_completed`, and the outputs index is rebuildable from it.

### One index, one fact, no contract bump

A producing tool is a **second writer into the existing outputs machinery, not a
second mechanism.** The handler sets `result.outputs`; `result-to-facts.ts`
already carries `result.outputs` onto `fact.node_completed.payload.outputs`
(size-agnostic, provider-agnostic, spilling to the blob CAS above the 4KB payload
cap at append time); the outputs index already inserts `(run_id, node_id,
iteration) → struct` in the same transaction as the fact. None of that changes.

Therefore:

- **No new fact type.** `fact.node_completed.payload.outputs` is reused verbatim.
- **No reducer change, no `EVENT_CONTRACT_VERSION` bump.** The fact shape and the
  fold are unchanged.
- **`ir_version` bump + converter** — the same pattern per-step and run-level
  outputs used. Adding `outputs:` to the `tool` node shape is an IR change; the
  converter maps older tool nodes forward unchanged (they simply have no
  `outputs:`).

The *event/store* surface is untouched, but the change is not zero-touch. Full
touch-surface accounting:

- **`@fragua/workspace`** — the new optional `createScratchFile(key)` /
  `ScratchFile` capability, implemented on both `LocalEnvironment` and
  `WorktreeEnvironment` (deterministic path under the run-keyed
  `<tmp>/fragua-scratch/<run_id>/` subtree, outside `cwd()`; unlink-then-
  `O_CREAT|O_EXCL|O_CLOEXEC`-create at allocation with the fd **retained** for
  read-back, a failed create → hard node failure; bounded, out-of-jail read via
  `pread` on that retained fd — `maxBytes+1` bounded, no re-open of the
  child-controlled path, no non-blocking/`O_NOFOLLOW`/`fstat`-classifier
  apparatus; a diagnostic metadata-only `stat` on the `absent` path to
  distinguish a rename (`renamed`) from a genuine no-write, reading no bytes;
  `dispose()` closes the fd and unlinks, idempotent). No sweep ships
  (§ *Cleanup*).
- **`@fragua/core`** — the optional `createScratchFile?(key)` addition to the
  `ExecutionEnvironment` interface (`types/execution.ts`); the tool handler
  (`handlers/tool.ts`) allocate → spawn-with-env → read-back → validate → attach
  → `dispose()` flow, the presence-guard on the optional capability, and
  `FRAGUA_OUTPUT_MAX_BYTES = 8 MiB`; the parser type-gate loosening
  (`parser/yaml.ts`); the IR bump + converter (`ir.ts`); the `HandlerResult.outputs`
  JSDoc (`handler/types.ts`), which still reads "`emit_output` tool (llm steps)"
  and must drop the llm-only assertion.
- **`@fragua/daemon`** — `specForNode` (`auto-dispatcher.ts`) reads
  `node.attrs.outputs` and threads the `OutputsDecl` into `ToolConfig`, widening
  the `attrs` param it passes into `ToolConfig` to carry `outputs`. That is its
  *only* change. It does
  **not** pass a scratch key: `specForNode` runs at graph-load and has no runtime
  `runId`/`iteration` to give (those are per-dispatch). The handler builds the
  `ScratchKey` at run time from the `runId`/`nodeId`/`iteration` fields already
  present on `HandlerContext` (`handler/types.ts:88–90`).
- **Docs** — the authored statements in *Contracts reversed* (entries 1–4, 6–9):
  SPEC §3.8 (prose + substitution-token table), the two ARCHITECTURE.md glosses,
  `docs/handler-contract.md`'s **two** sites (the `HandlerResult.outputs` gloss
  `:92` and the tool-node prose `:314–320` — authoritative for the handler API
  under ground rule 1), plus the three further authoritative in-repo docs that
  state the reversed position verbatim — `.agents/skills/workflows/SKILL.md` (the
  on-demand `workflows` skill), `docs/workflows.md`, and `AGENTS.md`/`CLAUDE.md`
  ground rule 13. (structured-outputs.md is named as the superseded prior
  position, not edited.)
- **Already done, no work:** `compileOutputsToTypeBox` / `validateOutputsValue`
  (already provider-agnostic in `core`), `result-to-facts.ts`, the `outputs`
  index, blob spill, and the `${{ outputs.X.f }}` resolver — all reused verbatim.
- **Deferred, not here:** the W019 warning that steers
  `${{ … }}`-carrying producers to `exec:` ships in
  [`tool-exec-variant.md`](tool-exec-variant.md), where its recommended remedy
  (`exec:`) actually exists.

### `exec:` interaction — recommended, not required

A producing tool is exactly the step class whose arguments carry generated content
(the injection class `exec:` fixes: per-argument substitution makes a value with
spaces, quotes, `$()`, or backticks one inert argv element). `$FRAGUA_OUTPUT`
rides `execve` for both `run:` and `exec:`, so production works under either form.

**`exec:` is the recommended form for a producer, not a hard requirement.** A
producer whose command uses only literal `run:` arguments is safe and legal. For
producers the `exec:`-vs-`run:` position is closed: recommend `exec:`, do not
require it — and ship **no warning to enforce it.** A validator
warning that steers a `${{ … }}`-interpolating producer toward `exec:` is deferred
to [`tool-exec-variant.md`](tool-exec-variant.md) for two decisive reasons: its
recommended remedy (`exec:`) does not exist until that proposal lands, and the
interpolation hazard is not producer-specific — *every*
`tool` node interpolates `${{ … }}` into `run:`, so the warning belongs with the
`exec:` machinery, not gated behind `outputs:`.

The `exec:` form and its per-argument scan are that proposal's, not this one's.
The `run:` + `$FRAGUA_OUTPUT` core here works without it.

### `idempotent:` / quarantine — re-emission is required, byte-identity is not

A producing tool spawns a shell, so it is `sideEffect: "external"` and quarantines
the run on a mid-spawn crash — unless it is marked `idempotent:` (the marker
from the unmerged [`tool-exec-variant.md`](tool-exec-variant.md) §4; the
`"idempotent"` literal already exists in the `SideEffect` union but nothing sets
it for tool nodes yet), which lets it auto-re-run instead. A re-run of a producing
tool **must re-emit** (it declared `outputs:`; the fail-closed producer contract
applies to the re-run exactly as to the first run).

A producing tool is **not** automatically pure: `outputs:` says it emits a struct,
not that emission is its *only* effect — it may `email`-then-emit or
`charge`-then-emit. Marking it `idempotent:` widens the pre-existing
double-execution-on-restart window to that effect; the marker is the sanctioned
mitigation, but it does not *make* the effect idempotent — it asserts the author
made it so.

The re-emission **need not be byte-identical.** The outputs index is `INSERT OR
REPLACE` keyed by `(run_id, node_id, iteration)`, and `getLatestOutput` resolves
the latest completed emission (pre-existing `llm`-producer behaviour — not new
here; a tool producer inherits it unchanged); a second, differing struct simply
supersedes a partially-recorded first. Atomicity holds because the index row and
`fact.node_completed` commit in one transaction — a pre-commit crash leaves no
index row and no fact, so a re-run starts from a clean slate. Replay always folds
the *recorded* value and never re-executes. Byte-identical re-emission is a
property an author may want (it is the property Ernesto's byte-for-byte port
depends on) but the engine does not require it for correctness; requiring it would
only become meaningful under a `pure` classification (see *Doors*).

**Exit 0 is no longer a total-success guarantee for a producer — the fail-edge
consequence.** A post-exit-0 emission failure
(absent / renamed / oversize / unparseable / schema-invalid) surfaces as
`outcome=fail` — the *same* outcome a non-zero exit produces — so at the `fail`
edge it is **indistinguishable** from a command failure. The consequence is that
the pre-existing hazard "a `fail` edge routed back into a re-run re-executes an
already-committed side effect" now also applies to a producer whose *emission*
(not its command) failed: a producer that `charge`-then-emits and whose emission
then fails, routed on `fail` into a re-run, charges again. Emission can fail
*before* any side effect runs, so a failed emission does **not** imply the effect
occurred — it implies nothing either way; the author cannot read "emission failed"
as "nothing happened." This is the author's responsibility exactly as for any
side-effecting tool: design the effect idempotent, and do not route a producer's
`fail` edge into a path that repeats a non-idempotent effect. The engine adds no
new guarantee here — a producing tool is a side-effecting tool with a typed
emission bolted on, and it inherits that tool's fail-edge semantics wholesale.

### Blocklist / injection — unchanged

A producing tool weakens no execution invariant. All shell execution still goes
through the scanned path: `run:` through the argv-aware blocklist and
shell-interpreter refusal, `exec:` through the same scan per argv element.
`$FRAGUA_OUTPUT` is an env var handed to the child, never a command fragment and
never author-substitutable into the command — so it introduces no bypass.

The engine-injected `FRAGUA_OUTPUT` also survives the env-deny filter: both
`LocalEnvironment` and `WorktreeEnvironment` strip child env by a secret-name
rule and an optional predicate applied at spawn (`local-env.ts:252–262`), and
the CI predicate keys on a set of secret suffixes (`_KEY` / `_SECRET` / `_TOKEN` /
`_PASSWORD` / `_CREDENTIAL` / `_PASS` / `_AUTH` / `_PASSPHRASE`,
`env-creds.ts:46–53`). `FRAGUA_OUTPUT` matches none of them, so no deny path can
strip the variable the producer must read. The implementation treats the name as
reserved to keep it that way, pinned by a guard test that asserts `FRAGUA_OUTPUT`
survives both the secret-name rule and the CI predicate (so a future tightening of
either filter cannot silently strip the channel). The reserved name also means the
engine's injected `FRAGUA_OUTPUT` unconditionally overwrites any same-named
variable an author set on the child; the guard test pins deny-filter survival but
not this author-intent collision, so a producer must not rely on its own
`FRAGUA_OUTPUT`.

## Contracts reversed

Several authored contract statements assert tool nodes never produce. This
proposal reverses each; none touches an already-authored workflow. Entries 1–4
and 6–9 are the authoritative in-repo statements this proposal must edit on
landing; entry 5 names the prior closed position (structured-outputs.md) the
reversal supersedes (a proposal doc, not edited), so the change reads as
intentional rather than an oversight.

1. **SPEC §3.8, tool-node prose.** Today:

   > "Tool nodes (`type: tool`, §3.1) are side-effect-only: exit 0 →
   > `outcome=success`, non-zero → `outcome=fail`. They do not *produce* data
   > forward (they consume `${{ … }}` in `run:`). Workflows that need to run a
   > deterministic script and reason about its output should call the script
   > from inside an llm step's `bash` tool instead…"

   Reversed to: a `tool` node **may** declare `outputs:` and produce a typed
   struct via `$FRAGUA_OUTPUT`; the prescribed "call it from an llm step's bash
   tool" workaround is no longer the only path to a computed value forward.

2. **SPEC §3.8, the substitution-token table.** Today (`SPEC.md:239`):

   > "`${{ outputs.<producer>.<field>…] }}` — A typed step output emitted by an
   > upstream `llm` node that declared `outputs:`."

   Reversed to: "…emitted by an upstream **`llm` or `tool`** node that declared
   `outputs:`." And the prose (`SPEC.md:249`, §3.8) that reads "An `llm` step
   declares typed `outputs:`" and "`outputs:` is `llm`-only … `tool` and `human`
   steps consume outputs but do not produce them" changes to admit `tool`
   producers; `human` steps still only consume.

3. **ARCHITECTURE.md §5, the `HandlerResult.transition` description** (`:334`).
   Today:

   > "optional `outputs` (structured values from `emit_output`, llm steps only)."

   Both sub-claims change: the struct now arrives from `emit_output` **or**
   `$FRAGUA_OUTPUT`, and it is no longer **llm-only**.

4. **ARCHITECTURE.md §3, the `fact.node_completed` `outputs?` gloss** (`:185`).
   Today, in full:

   > "`outputs?: Record<string, unknown>` (present iff the node declared
   > `outputs:` **and emitted a value via `emit_output`**; written to the
   > `outputs` index table in the same transaction)".

   The `emit_output` clause is a producer precondition, not just a gloss — so it
   *does* change: emission is now `emit_output` (llm) **or** `$FRAGUA_OUTPUT`
   (tool). The **field shape and the fact type are unchanged** — the `outputs?`
   record and its same-transaction index write are reused verbatim, which is the
   whole point of reusing the field; only the naming of *how* a value gets there
   widens.

5. **structured-outputs.md, the prior closed position** (the state this proposal
   supersedes; named here so the reversal reads as intentional, not accidental).
   §3 "Out":

   > "Tool-step production (`$FRAGUA_OUTPUT`); `tool` steps consume, never
   > produce."

   §4:

   > "All three **consume** `${{ inputs.* }}` / `${{ outputs.X.f }}` by
   > interpolation. **Only `llm` steps produce** `outputs:`, and only when they
   > do not `route:`."

   That cut was an MVP scoping decision, not a design conclusion — the same doc's
   §10.3 named tool production as a deferred follow-up the MVP contract admits
   without a rewrite. This proposal reverses the "never produce" / "only `llm`
   steps produce" position for `tool` (not `human`) and walks through the §10.3
   door.

6. **`.agents/skills/workflows/SKILL.md` (the on-demand `workflows` skill,
   `:253`).** Today:

   > "`outputs:` is **`llm`-only to produce** (`tool`/`human` consume but never
   > produce) and **mutually exclusive with `routes:`**…"

   Reversed to: `outputs:` is produced by `llm` **or `tool`** steps (`human`
   still consumes but never produces); the mutual-exclusivity-with-`routes:`
   clause is unchanged. This edit is load-bearing because the skill is what an
   agent loads on demand before authoring a workflow — left stale, it would keep
   asserting a false contract to every future author.

7. **`docs/workflows.md` (`:94–95`).** Today:

   > "Only `llm` steps *produce* outputs; `tool` and `human` steps consume but
   > never produce, and `outputs:` is mutually exclusive with `routes:`."

   Reversed to: `llm` **and `tool`** steps produce outputs; `human` steps
   consume but never produce; the `routes:` exclusivity is unchanged.

8. **`AGENTS.md` / `CLAUDE.md` ground rule 13 (`AGENTS.md:97`; `CLAUDE.md` is a
   symlink).** Today the rule reads, in part:

   > "`outputs:` is llm-only and mutually exclusive with `routes:`… Tool nodes
   > are side-effect-only … `tool`/`human` never produce them."

   Reversed to admit `tool` producers: `outputs:` is produced by `llm` or `tool`
   steps, `human` never produces, and a producing `tool` emits via
   `$FRAGUA_OUTPUT` rather than `emit_output`. The `outputs:`/`routes:`
   exclusivity is unchanged.

9. **`docs/handler-contract.md` (the authoritative handler API doc, AGENTS.md
   ground rule 1) — two edit sites.** First (`:92`), the `HandlerResult.outputs`
   gloss. Today:

   > "`outputs?: Record<string, unknown>` — structured outputs from
   > `emit_output` (llm steps with `outputs:` declared); present iff the node
   > emitted a valid struct".

   Reversed to widen the emission naming: the struct now arrives from
   `emit_output` (llm) **or** `$FRAGUA_OUTPUT` (tool), and "llm steps" becomes
   "llm or tool steps". The field shape is unchanged.

   Second (`:314–320`), the tool-node prose. Today:

   > "tool nodes do not feed data forward to downstream nodes. A workflow that
   > needs to run a deterministic script and reason about its output should call
   > the script from inside an llm step's `bash` tool instead…" and "the
   > graph-level `tool` node is a distinct primitive for side-effect-only shell
   > steps…".

   Reversed to: a `tool` node **may** declare `outputs:` and feed a typed struct
   forward via `$FRAGUA_OUTPUT`; the "call it from an llm step's bash tool"
   workaround is no longer the only path, and the node is a side-effect-**or-
   produce** shell step. This is exactly the stale-authoritative-doc failure this
   proposal flags for the `workflows` skill (entry 6): `docs/handler-contract.md`
   is named authoritative for the handler API by ground rule 1, so leaving it
   stale would keep asserting a false contract.

## Validation

One parser surface moves; no fact or reducer surface does, and **no new validator
code ships here.**

- **Type gate loosened (parse-time).** `packages/core/src/parser/yaml.ts:651–665`
  today throws a `ParseError` for `outputs:` on any non-`llm` step. The gate
  widens to admit `type: tool`. Everything downstream of the gate is unchanged —
  including the both-declared check (`:661`), which now fires for a `tool` node
  that declares `outputs:` **and** `routes:` with no new code (this discharges
  the open mutual-exclusivity question: it is a parse error, not undefined
  behavior).

No new **error** code is needed: the `outputs:`/`routes:` collision and the
empty/malformed `outputs:` block reuse the existing parse-time `ParseError` and
E033/E034 paths, which are type-agnostic once the gate admits `tool`. The
producer-resolution diagnostics are already node-type-blind: the E033/E034 static
sweep runs over "every node that declares `outputs:`" (`validator.ts:515–518`),
and the E035/W015 reference oracle keys the producer off `producer.attrs.outputs`
— *presence of a decl*, not `type: llm` (`validator.ts:595`-region, `if
(producerOutputs === undefined)`). Admitting `tool` at the parse gate makes a
`tool` producer resolve through those existing paths with no new branch; the
comment at `validator.ts:515` already reads "non-llm/tool step." No new
**warning** code either: the `exec:`-steering warning is deferred to
`tool-exec-variant.md` (§ *`exec:` interaction*).

## Doors

**What this permits now.** The gather→judge composition without a model turn in
the gather: a `tool` computes structured evidence (a diff spec, a gate boolean, a
set of prompt strings, a fan-out cardinality) and an `llm` or a `tool` consumes it
typed. fragua's own `select`/`prep_diff` steps become deterministic tool
producers; Ernesto's four glue phases become four `tool` steps whose emitted
structs are validated and replayable rather than four model turns.

**Parallel-branch legality stays closed — and this names and overrides a prior
open lean, not just the producing case.** [`fan-out-nodes.md`](archive/fan-out-nodes.md)
§Open left the tool-in-branch door ajar and leaned *toward* admitting a
non-producing read-class tool in a branch: "Read-class `tool` node in a branch in
v1, or `llm`-only (E041)? Lean: allow a read-class `tool` (it's deterministic and
side-effect-free by classification)." This proposal cites that lean and overrides
it, with its own argument: write-capability on a `tool` node is **not** statically
provable. `ctx.env.exec` runs an arbitrary shell string regardless of
`allowed-tools`, so even a nominally read-class tool can `>` a file or `rm` in the
shared, read-only worktree — the exact concurrent-write hazard E042 guards, and
the exact reason the `allowed-tools` scan E042 relies on cannot certify a shell
tool side-effect-free. A *producing* tool is only a sharper instance: it writes by
definition — to `$FRAGUA_OUTPUT` — so "produces ⇒ read-class" is doubly false.
**E041 stays: fan-out branch nodes remain `type: llm` only**, for producing and
non-producing tools alike. The door that would reopen this is a *provable*
no-write classification (a `pure` marker enforced by a sandbox, or a whitelisted
argv with no filesystem reach), which is the `pure`-has-no-consumer question
tool-exec-variant §4 deferred — this proposal does not create that consumer, and
says so explicitly rather than leaving the door ajar by omission.

**Data-driven routing stays a separate door.** A producing tool *already*
expresses a deterministic gate via its **exit code** (nonzero → the `fail` edge),
so a `skipIf`-style success/fail gate is reachable today. Routing on the *emitted
value itself* — picking an edge by `${{ outputs.X.status }}` — is a genuinely new
capability (edge selection today is two cases only: the `route` tool or the
`outcome` status). It is **out of scope here**: it changes the edge selector,
orthogonal to production, and belongs in its own proposal. The consequence to
state plainly: until that door opens, a data-producing tool can branch on an exit
code but not on a value.

**Proactive scratch-root GC stays a separate door.** Cleanup is best-effort and
correctness never depends on it (§ *Cleanup*): the deterministic path plus the
checked unlink-then-`O_EXCL`-create at allocation self-heal the only leak (a
`SIGKILL`ed daemon's in-flight file) on the next re-run, and the OS reclaims its
own temp dir. A proactive
daemon-boot / run-terminal sweep of `<tmp>/fragua-scratch/` is a possible future
hygiene increment, deferred here: it is not correctness- or hygiene-load-bearing
(at most one small file per key), and a sweep keyed on run-terminal facts cannot
reconcile `fragua ci` / ephemeral / imported-run subtrees across stores, so its
value is marginal. If it ever ships, `@fragua/workspace` would export the sweep
and `@fragua/daemon` would call it (boot + `fact.run_terminated` path).

**Remote / sandbox backend read-back stays a separate door.** The retained-fd
read here works because the daemon and the child share a kernel: the fd
`createScratchFile` opens survives across the spawn, and the read-back `pread`s
it. A future Docker/remote sandbox backend that spawns the child into a separate
namespace or host **cannot** retain that fd across the boundary and must read the
emission back by **re-opening a child-controlled path** — which re-introduces the
exact FIFO/device/symlink/blocking-mount class the retained fd sidesteps. That
backend's `read()` is out of scope here and is flagged as a Door. When it ships,
its re-open-by-path read must state the hardening correctly (the distinction the
retained-fd path removed): a terminal symlink is refused at `open()` with `ELOOP`
via `O_NOFOLLOW` and returned as `{ kind: "invalid" }` from inside `read()`,
*separately* from an `fstat`-on-the-fd non-regular check (FIFO/device/directory on
a successful open); and the residual blocking-mount wedge on a *regular* file —
which `ctx.signal` cannot cancel once wedged in the threadpool — bounded by a
disposable, hard-killable read worker, not by the signal. None of that ships on
the local/worktree backend, where the retained fd removes the whole class.

## Rejected alternatives

- **stdout-as-JSON.** Zero ceremony, but stdout is already the tool node's
  diagnostic channel (observability chunks + the `tool_node` message), so JSON on
  stdout collides with logging and makes "did it emit?" ambiguous. Lost to
  presence-ambiguity.
- **A trailing sentinel-delimited block on stdout.** Worst of both: it parses a
  side-channel out of a stream already used for two purposes, and inherits the
  collision without gaining unambiguous presence. Lost on every axis to the file
  path.
- **A new fact type / reducer case for tool outputs.** Would force an
  `EVENT_CONTRACT_VERSION` bump and a second production mechanism for the same
  data. Lost because `fact.node_completed.payload.outputs` + the rebuildable index
  already carry it — a second *writer* costs nothing a second *mechanism* would.
- **A scratch file under `cwd()` instead of a new `ExecutionEnvironment`
  capability.** The read-back could reuse `env.readFile` if the file lived inside
  the worktree. Rejected: (a) it would then enter the snapshot delta and
  `fragua runs diff`, regressing the snapshot-exclusion property, unless a
  bespoke path-exclusion carve-out were added to the diff/snapshot machinery —
  more surface than the capability it avoids; and (b) `readFile` still runs
  through the `resolvePath` jail, so an in-worktree emission is only "safe" by
  accident of location and still needs a dedicated out-of-jail read for any
  future sandbox backend. The `createScratchFile()` capability puts the file
  outside `cwd()` by construction, keeps the read out of the jail, and is the one
  surface a Docker/remote backend already has to implement to honour
  `$FRAGUA_OUTPUT`. Chose the capability over the in-worktree file.
- **A per-dispatch nonce in the scratch path plus a daemon-boot / run-terminal
  sweep.** An earlier draft made the path `…-<iteration>-<nonce>` (fresh per
  allocation) and reconciled orphans with a sweep of the scratch root on
  run-terminal facts and at daemon boot, to guarantee a re-run never read a prior
  attempt's leaked file. Rejected as strictly more machinery than the guarantee
  needs: a deterministic path plus a checked **unlink-then-`O_EXCL`-create** at
  allocation answers "did *this* dispatch emit?" identically — the prior file is
  unlinked before the re-run's child can write (and a survivor is a loud
  allocation failure, never a silent read of stale bytes), and POSIX
  unlink-then-create hands the re-run a fresh inode even against a zombie writer
  holding the old fd. With the nonce gone the sweep
  loses its only correctness role, becomes bounded self-healing hygiene (one file
  per key, cleared by the next allocation or the OS), and — since it could not
  reconcile cross-store `ci`/imported runs anyway — is deferred behind a Door
  rather than half-built. Chose the smaller channel.
- **Re-opening the child-controlled path with a hardened read (`O_NONBLOCK |
  O_NOFOLLOW` open + `fstat`-on-fd non-regular classifier + a `{ kind: "invalid"
  }` branch).** An earlier draft let the child write via any means (including a
  temp-file → atomic-rename over the path) and read the emission back by
  **re-opening `$FRAGUA_OUTPUT` after exit**, then defended that re-open against
  `ln -sf /dev/zero`, `mkfifo`, and symlink-swap with a non-blocking `O_NOFOLLOW`
  open, an `fstat` on the returned fd rejecting non-regular files, and a TOCTOU
  analysis — an apparatus that still left a residual regular-file blocking-mount
  wedge (uninterruptible by `ctx.signal`) as an open Door. Rejected: the *only*
  thing that apparatus bought was tolerance of an atomic-rename write, and **no**
  motivating producer needs one — `prep_diff` (`git diff > …`), Ernesto's glue
  (`echo`/`printf >`), and `ocr_review`'s list all truncate the engine-created
  inode in place via `>`, which a **retained fd** reads directly; and the
  partial-read hazard atomic-rename defends against cannot occur, because the
  engine reads only *after* the child exits. Retaining the `O_EXCL | O_CLOEXEC`
  fd `createScratchFile` already opened, and reading back from it, defeats
  `ln -sf /dev/zero`, `mkfifo`, and symlink-swap for free (the fd is pinned to
  the regular inode the engine created; a child that unlinks and re-plants leaves
  the retained fd on the now-empty inode → `absent` → fail-closed), keeps the
  `maxBytes+1` bound, and **deletes** the non-blocking open, the classifier, the
  `invalid` branch, and the residual-wedge Door on the local/worktree backends.
  The re-open-by-path read survives only as the deferred remote-backend Door,
  where no fd can cross the namespace boundary. Chose the retained fd, dropping
  atomic-rename *support* (producers write in place, `command > "$FRAGUA_OUTPUT"`)
  — though a rename is still *detected* on the `absent` path by a metadata-only
  `stat` (never a byte read, never a re-open) and reported as
  `producer.rename_not_supported`, so a temp-file idiom (`mv`, `sponge`,
  `--output`) fails with an actionable diagnostic naming the in-place-`>` fix
  rather than a misleading `no_emission`.
- **A dedicated home for the producer fault (typed `HandlerResult` field, fact
  field, or a `tool.completed` observability field).** The fault rides the
  existing `result.failureReason` — the terminal home the tool handler already
  uses for its consumer-side fail-closed path, symmetric with the consumer fault
  and carrying no fact-shape change. A new field is unneeded surface. An earlier
  draft added a `producerFault?` observability field to also surface the fault
  when a node *recovers on a `fail` edge* (where `failureReason` is dropped). Cut:
  no requirement for fail-edge fault-visibility is documented, and the
  pre-existing consumer-side path lives on `failureReason` alone with the
  identical gap, so the field was strictly more than parity. The field is not
  shipped; a fail-edge fault-visibility improvement, if wanted, belongs in its own
  follow-up covering both the consumer and producer sides symmetrically.
- **Requiring `exec:` for every producer.** A producer whose command has only
  literal arguments is safe under `run:`; a hard requirement would reject correct
  workflows for a hazard they do not have. Lost to over-restriction; `exec:`
  stays the recommended-not-required form, with the `${{ … }}`-steering warning
  deferred to `tool-exec-variant.md` where its remedy exists.
- **Requiring byte-identical re-emission under `idempotent:` re-run.** The index
  is `INSERT OR REPLACE` and resolves the latest emission, and the fact + index
  commit atomically, so a differing re-emission is already correct. Lost as
  unnecessary machinery; byte-identity becomes meaningful only under a future
  `pure` classification.
- **Treating a producing tool as read-class / branch-legal.** A shell tool's
  write-capability is not statically provable from its command string, and a
  producer writes to `$FRAGUA_OUTPUT` regardless. Lost because E042's hazard
  (concurrent writes corrupting the shared snapshot nondeterministically) is
  unenforceable for an arbitrary shell string.
- **Making `tool` a general-purpose handler kind** (arbitrary structured I/O, a
  programmable node type). Out of scope and against the grain: `tool` stays a
  side-effect-or-produce shell step with a typed emission, not a plugin surface.

## Non-goals

- **Binary / blob outputs.** `outputs:` remains the small JSON type grammar;
  arbitrary bytes stay on disk, read by the consumer.
- **HITL-produced outputs.** `human` steps consume; they do not produce.
- **A `pure` marker.** tool-exec-variant §4 argues `pure` is dead metadata until
  something consumes it. This proposal deliberately does **not** create that
  consumer (a producing tool stays `external` and non-branch-legal); `pure` is
  re-examined only if and when provable purity is pursued to reopen branch
  legality.
- **A general-purpose handler kind.** `tool` remains a shell step.
- **Data-driven edge selection.** Routing on emitted values is a separate door,
  named above.
