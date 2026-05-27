---
title: Tool exec variant — injection-safe argv execution, with an idempotency marker
summary: "The `tool` node executes only one way: `run:` → `sh -c <substituted string>`. Interpolating a value into that string is a shell-injection + tokenization hazard (the handler already carries a mitigation comment), it is non-reproducible (per-machine `/bin/sh` variance), and it mangles exit codes through the shell layer. Add a second, mutually-exclusive form — `exec: {cmd, args}` — that spawns argv directly with NO shell and substitutes per-element (a value becomes exactly one inert argv token, never re-parsed). This is the correct default for any step consuming generated/untrusted content — evals above all. Companion (independently shippable): an `idempotent:` marker that lets crash-recovery auto-re-run a tool instead of quarantining it. Both are additive over the source-hashed IR — zero freeze coupling; if workflow-ir (B) lands later they are clean `ir_version` bumps."
status: shipped
maturity: designed
last-reviewed: 2026-05-27
---

# Tool exec variant

> **Status: the `exec:` form shipped.** `tool` nodes now accept `exec: {cmd,
> args}` with per-element substitution, no shell, and blocklist +
> shell-interpreter refusal on `cmd` (validator E033/E034). The `idempotent:`
> marker (§4) is the remaining deferred follow-up.

> Sibling of [`structured-outputs.md`](structured-outputs.md) (it makes
> `${{ steps.X.outputs.f }}` interpolation safe) and
> [`workflow-ir.md`](workflow-ir.md) (both additions are IR-core node attrs).
> **Additive, 0.1.1 — does not gate the 0.1.0 event-contract axis split.** No
> IR-hash coupling: at the 0.1.0 minimal freeze `sha = sha256(source)` (A), so
> these are parser/handler/env changes, not freeze decisions.

## 1. The mechanism today — one way to run a command

A `tool` node runs `node.attrs.tool_command` as a **single shell string**
(`packages/core/src/handler/handlers/tool.ts:1–3`). The string is substituted at
dispatch time (`tool.ts:45`) and executed unconditionally through a shell:
`Bun.spawn(["sh", "-c", cmd])` (`tool.ts:278`) / `spawn("/bin/sh", ["-c",
command])` (`packages/workspace/src/local-env.ts:231`). The
`ExecutionEnvironment.exec` contract is string-only (`local-env.ts:184`).

Three defects fall out of "everything is a shell string."

### 1.1 Interpolation is a shell-injection + tokenization hazard

The handler already knows this — `tool.ts:83–89` carries the mitigation comment:

> *"Tool commands are shell strings. A `${{ inputs.x }}` value may [contain a]
> newline [that] turns one statement into several when /bin/sh re-tokenises…
> whitespace; shell does not."*

Every interpolated value is shell source. A value containing `;`, `$()`,
backticks, a quote, or a newline is at best a broken command and at worst
arbitrary execution. Structured-outputs widens the surface (it interpolates
`${{ steps.X.outputs.f }}` too); its blob→`.path` dance
([`structured-outputs.md`](structured-outputs.md) §3) is a *point* workaround for
one case. An argv form is the *general* fix.

### 1.2 Non-reproducible

`/bin/sh` is a different program across machines/distros/CI (dash vs bash, IFS,
glob, brace expansion). The same `run:` line is not guaranteed to tokenize
identically everywhere — bad for deterministic evals and for resume-after-import
([`db-import.md`](db-import.md)).

### 1.3 Exit codes pass through a shell layer

The shell can mask pipeline failures (no `pipefail` by default) and mangle the
exit code that becomes `outcome=success|fail`.

## 2. The fix — a second, mutually-exclusive form

The node kind stays `tool`. Two forms, **separate keys, no shape-overload**
(the lesson from the routing-surface pass — explicit beats clever
type-discrimination):

```yaml
# Shell form — flexible: pipes, redirects, globs, multi-statement
build:
  type: tool
  run: "npm run build 2>&1 | tee build.log"

# Exec form — injection-safe, reproducible, no shell
grade:
  type: tool
  idempotent: true                      # §4 — pairs naturally with a scorer
  exec:
    cmd: python
    args: [grade.py, --candidate, "${{ steps.gen.outputs.answer }}", --rubric, "${{ inputs.rubric }}"]
```

### 2.1 Decisions (pinned)

1. **`run:` (string → shell) XOR `exec:` (map → argv).** Exactly one required;
   validator E-code on both-present and neither-present. Rejected a
   type-discriminated single `run:` (string-vs-list) — it re-introduces the
   shape-overload the routing pass deliberately removed.
2. **`exec: {cmd, args: [...]}`** — `cmd` is argv[0], `args` the rest. Over a
   bare `[cmd, ...args]` list: clearer command-vs-args boundary, a better error
   class (no missing-argv[0]), and it reads cleanly under interpolation.
3. **Interpolation — the load-bearing decision:**
   - `run:` — whole-string substitute → `sh -c` tokenizes. Flexible, unsafe;
     keeps the existing newline mitigation.
   - `exec:` — **per-element substitute, no re-split.** Each `cmd` / `args[i]` is
     substituted as exactly one token. A value with spaces, quotes, newlines,
     `$()`, or backticks becomes one inert argv element, never re-parsed. **This
     is the safety contract.**
4. **`ExecutionEnvironment` gains an argv variant.** `exec(command: string)`
   stays (shell); add the vector path → `spawn(cmd, args)` with no shell, in both
   `local-env.ts` and `worktree-env.ts`. Env (including a future
   `$FRAGUA_OUTPUT`, [`structured-outputs.md`](structured-outputs.md) §3.1)
   passes through execve unchanged.
5. **Exit code → outcome: identical** across forms, and exec is *cleaner* — no
   shell layer to mask a pipeline failure or rewrite the code.

### 2.2 Blocklist — exec must not become a bypass

`run:` keeps the shell-string scan (`packages/workspace/src/blocklist.ts`) and
the `cd`-escape scan (`local-env.ts:332–340`). For `exec:`:

- Check the resolved `cmd` (basename + resolved path) against the blocklist.
- **Refuse shell interpreters as `cmd`** (`sh`/`bash`/`zsh`/`dash`/`fish`/…). If
  you want a shell, use `run:` — which *is* scanned. Otherwise
  `exec: {cmd: sh, args: [-c, "curl … | sh"]}` sails past the string scanner.
- Static reject when `cmd` is a literal (validator); runtime reject on the
  resolved argv[0] when `cmd` is interpolated.

This preserves the invariant **all shell execution goes through the scanned
path.** It is the one security decision in the proposal and wants explicit
sign-off (§6).

## 3. Why evals are the validating use case

An eval step feeds model-generated (untrusted) content into a scorer. Under
`run: "python grade.py ${{ steps.gen.outputs.answer }}"`, an answer containing
`; rm -rf`, `$(curl evil)`, or just a quote is broken-to-RCE. The exec form makes
that one inert argv element. Evals need exactly the three properties exec
delivers and shell does not:

- **Injection-safe** — generated content as literal args, not shell source.
- **Reproducible** — no `/bin/sh` variance across machines/CI (eval determinism;
  also import-resume fidelity).
- **Clean exit semantics** — the scorer's exit code reaches `outcome` without
  shell/pipefail interference.

So exec is not merely an ergonomic alternative — it is the **correct default for
any step interpolating generated content**, and evals are the workflow class that
makes that non-negotiable. Paired with `idempotent: true` (§4), `exec` + a
deterministic scorer is the canonical eval-step shape.

**Future lint (not now):** a `run:` interpolating a generated
`${{ steps.*.outputs.* }}` value can warn *"prefer exec for injection safety."*
Cheap guard-rail once structured-outputs lands.

## 4. Companion — the `idempotent:` marker (independently shippable)

A tool spawn is wrapped in `ctx.externalCall(...)`, which emits
`fact.side_effect_intent` before and `fact.side_effect_done` /
`fact.side_effect_failed` after (`packages/daemon/src/recorder.ts:41–65`). On a
daemon crash mid-spawn, the startup sweep cannot know whether the side effect
landed, so it **quarantines** — `tool.ts:35–37`: *"shell is inherently
non-idempotent, but the intent/done facts let the startup sweep quarantine a run
whose daemon crashed mid-spawn."* The recovery decision already has the seam
(`packages/daemon/src/wake-pending.ts:204` — `treat_as_done` vs quarantine).

`idempotent: true` is the missing input that lets that decision **auto-re-run
instead of quarantine** — the author has declared re-running is safe.

- **Default `false`** — matches today's conservative quarantine. You opt *into*
  auto-re-run. Unsafe behaviour (double-execution) requires explicit opt-in over
  a safe default — the right polarity. A wrong promise double-executes; that is
  inherent and acceptable for a strictly opt-in flag.
- **Refine the existing `sideEffect` taxonomy, don't add an orphan boolean.**
  `HandlerSpec.sideEffect` already exists (`human.ts` returns
  `sideEffect: "none"`; `auto-dispatcher.ts` sets it). Model this as
  `sideEffect: "none" | "idempotent" | "effecting"` rather than a boolean that is
  only meaningful when `sideEffect ≠ none`.
- **Ship `idempotent`, NOT `pure`.** `idempotent` has a consumer (the recovery
  arm). `pure` (no side effect + deterministic) would buy caching / skip /
  reorder — but fragua's replay never re-runs side effects and nothing
  reorders/memoizes nodes, so `pure` has no consumer in the current model. Adding
  it is dead metadata (ground rule 8 + spec-first). Defer until something
  consumes it.

## 5. Spec impact

- **SPEC §3.1** (the `tool` node) gains the `run:` ⊕ `exec:` distinction and the
  per-element-substitution safety contract.
- **`ExecutionEnvironment` contract** (workspace adapters) gains the argv variant
  alongside the string `exec`.
- **SPEC crash-recovery** (and `wake-pending`) gains the `idempotent` arm:
  auto-re-run vs quarantine.
- **Blocklist** gains an argv-aware path (resolved `cmd`, shell-interpreter
  refusal).
- **`workflows` SKILL** documents `exec:` as the default for steps interpolating
  generated content, and `idempotent: true` + `exec` as the eval-step shape.
- **Freeze note (only bites under workflow-ir (B)):** the canonicalization spec
  ([`workflow-ir.md`](workflow-ir.md) §8.1) must cover the new attrs — `idempotent`
  (bool, fold into the optional-normalization rule) and **`exec.args`, which is
  ORDERED — do NOT sort** (argv order is semantic, same class as `context_files`).
  Until (B), nothing here touches identity.

## 6. Scope / dependencies / MVP

- **Depends on:** nothing. Additive over the existing tool handler.
- **Wins independently:** yes — exec fixes a present-day injection hazard; the
  `idempotent` marker improves present-day crash recovery. Neither needs
  structured-outputs, though exec is what makes structured-outputs' interpolation
  safe.
- **Sequence:** 0.1.1, after the 0.1.0 event-contract axis split. `exec` and
  `idempotent` are independently shippable; bundle or split as convenient.
- **MVP (exec):** the `ExecutionEnvironment` argv signature; the `run`/`exec`
  discriminator in parser + `graph.ts` types + validator (both/neither E-code);
  per-element substitution; the argv-aware blocklist with shell-interpreter
  refusal; tests.
- **MVP (idempotent):** the `sideEffect` taxonomy extension; the `wake-pending`
  auto-re-run-vs-quarantine arm; default `false`; tests on the recovery path.

### Open questions

- **The shell-interpreter refusal (§2.2)** — confirm the policy (refuse, vs scan
  the `-c` payload). Refusal is simpler and preserves the scanned-path invariant;
  it is the one security decision to pin before code.
- **`cmd` interpolation** — allowed (runtime blocklist on resolved argv[0]
  catches a dynamic shell), but confirm whether a *literal* non-shell `cmd` is
  required for the static check to be meaningful.

## Related

- [`structured-outputs.md`](structured-outputs.md) — exec is what makes
  `${{ steps.X.outputs.f }}` interpolation injection-safe; `$FRAGUA_OUTPUT`
  rides exec unchanged.
- [`workflow-ir.md`](workflow-ir.md) — both attrs are IR-core; §8.1
  canonicalization must cover `exec.args` ordering + `idempotent` if (B) freezes.
- [`event-contract-version.md`](event-contract-version.md) — neither addition
  touches the fold contract (tool execution produces `fact.node_completed` with
  the same shape; the reducer folds `nextNode`/metrics, not exec internals).
