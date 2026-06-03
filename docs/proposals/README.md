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
| [`structured-outputs.md`](structured-outputs.md) | designed | Lands post-0.1.0 as an `ir_version` bump. `outputs:` on `llm` steps, `${{ outputs.X.f }}`, `emit_output` tool, dominance-by-success validator. |
| [`workflow-ir.md`](workflow-ir.md) | (A)+(C) shipped, (B) deferred | (B) — `sha = hash(canonical IR core)` — waits until the graph feature set is complete. §8 is the freeze gate + canonicalization checklist; §8.4 adds the `NodeAttrs`→union cleanup. |
| [`embeddable-engine.md`](embeddable-engine.md) | sketch | Decouple core/executor from Bun, git/local-fs, and the dev domain via kind-tagged injection ports; evict non-coordination state (blobs, env, creds, provider config) from the store. Four axes + a verified leak inventory. NO CODE until contract deltas pinned. |
| [`graph-as-data.md`](graph-as-data.md) | sketch | TypeScript workflow authoring as a peer front-end (`graph()` → IR). Blocked on the `NodeAttrs`→union refactor; hand-wavy on generics + authoring surface. |

## Archived

See [`archive/README.md`](archive/README.md). Shipped: `cli-topology.md`,
`event-contract-version.md`, `bundles.md`, `large-run-inputs.md`,
`reversible-migrations.md`. Superseded: `db-import.md`, `tool-exec-variant.md`.
