# Proposals

Design documents for work that is **not yet a frozen part of the spec**. Each
file declares its `status` + `maturity` in its frontmatter; this index gives
the cross-doc view. Shipped proposals move to [`archive/`](archive/).

The authoritative description of shipped behaviour lives in
[`docs/SPEC.md`](../SPEC.md) and [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md);
this directory is for *active* design work and freeze checklists.

## Live

| Doc | State | Open work |
|---|---|---|
| [`hitl-channel.md`](hitl-channel.md) | sketch | `fragua ci --on-pause=auto\|fail\|first\|emit`, `--resume`, console resolver. Route options on the pause fact are already shipped (§5.2). |
| [`secret-scrubbing.md`](secret-scrubbing.md) | shipped-experimental | `scrubber:` config block (§15), `cwd` v1 contract call (full-redact vs basename-normalize), per-export label / `--keep-cwd-path` flags, V2 items. |
| [`structured-outputs.md`](structured-outputs.md) | designed (MVP) | Narrow MVP: `outputs:` on **`llm` steps only**; one type grammar shared with `inputs:` (provider-supported JSON-Schema subset, no recursion/`$ref`), compiled to TypeBox; `${{ outputs.X.f }}`, `emit_output` tool, fail-closed reads, native strict-mode via the tool channel; spill via the input CAS path; nonce-wrapped prompt interpolation. Tool production, route-carried outputs, native final-message JSON deferred (§10). `ir_version` bump. |
| [`tool-exec-variant.md`](tool-exec-variant.md) | designed | 0.1.1. `exec: {cmd, args}` argv form + `idempotent:` marker on the `tool` kind. |
| [`workflow-ir.md`](workflow-ir.md) | (A)+(C) shipped, (B) deferred | (B) — `sha = hash(canonical IR core)` — waits until the graph feature set is complete. §8 is the freeze gate + canonicalization checklist. |

## Archived

See [`archive/README.md`](archive/README.md). Shipped: `cli-topology.md`,
`event-contract-version.md`, `bundles.md`, `large-run-inputs.md`. Superseded:
`db-import.md`.
