# Archived proposals

Proposals that have **shipped** or been **superseded**. They are kept as a
design record only — nothing live should depend on them. The authoritative
description of shipped behavior lives in [`docs/SPEC.md`](../../SPEC.md) and
[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md); active design work lives one
directory up in [`docs/proposals/`](../).

| Doc | State |
|---|---|
| [`cli-topology.md`](cli-topology.md) | **Shipped** — five of six children landed (intent-plane, fragua-ci, cli-store-client, bundles, event-contract-version); the principle ("sole fact-writer + store-clients") lives in `CLAUDE.md`. Only [`hitl-channel.md`](./hitl-channel.md) remains open. |
| [`event-contract-version.md`](event-contract-version.md) | **Shipped** — event-contract version axis split + recoverable pause on mismatch. |
| [`bundles.md`](bundles.md) | **Shipped** in 0.2.0 — portable `.fragua` bundles (`ci --export` / `show` / `import`), run_state derived on import. Reach-goals (message-content-as-blobs, resume-of-imported) remain unbuilt. |
| [`db-import.md`](db-import.md) | **Superseded** by `bundles.md` — kept for its identity-collision-safety and table-by-table portability rationale. |
| [`large-run-inputs.md`](large-run-inputs.md) | **Shipped** — Part A (`routing.input` removed; schedule desc → run title; schema v1→v2) and Part B (spill oversized `routing.inputs` to the blob CAS, GC roots, bundle export/import, scrubber composition) both landed. Sits behind the experimental bundle/scrubber contract — that flag is owned by [`secret-scrubbing.md`](./secret-scrubbing.md). |
| [`fan-out-nodes.md`](fan-out-nodes.md) | **Shipped** — Model A intra-run parallel fan-out: `type: parallel`, multi-node read-class branches, on-log reactive frontier, bounded-concurrency semaphore, E036–E045. |
| [`reactive-frontier.md`](reactive-frontier.md) | **Shipped** — the `Promise.race` commit-as-settled pool replaced the `Promise.all` superstep batch, plus per-branch watchdog + abort-loop liveness. |
| [`mcp-tools.md`](mcp-tools.md) | **Shipped (experimental)** — MCP servers per `.mcp.json`, tools materialised as `mcp__<server>__<tool>`, stdio + HTTP transports, store-backed OAuth (`fragua mcp login`/`logout`), step-level opt-in via `mcp_servers:`. Connector contract not frozen. |
| [`reversible-migrations.md`](reversible-migrations.md) | **Shipped** — `{ up, down }` migration steps + `fragua db migrate --to <version>` walking down; forward path unchanged. |
| [`typed-routing-struct.md`](typed-routing-struct.md) | **Shipped** — typed wrapper view for `run_state.routing` (option (c), reserved namespaces) via the `packages/core/src/routing.ts` validate-and-degrade accessors. |
| [`concurrency.md`](concurrency.md) | **Shipped** — the umbrella and decision record for intra-run parallel fan-out: the linearization invariant, the on-log frontier, the recovery-granularity axis. Everything it specified landed via `fan-out-nodes.md` and `reactive-frontier.md`. |
| [`structured-outputs.md`](structured-outputs.md) | **Shipped** — typed `outputs:` on `llm` steps, `${{ outputs.X.f }}` fail-closed reads, `emit_output`, the shared type grammar, run-level `outputs:` (§11), object/array inputs (§12). |
| [`tool-outputs.md`](tool-outputs.md) / [`tool-outputs.critique.md`](tool-outputs.critique.md) | **Shipped** — typed `outputs:` on `tool` steps via the `$FRAGUA_OUTPUT` scratch file, read back through a retained fd. The critique is kept as the arbitration record. |
| [`agent-tool.md`](agent-tool.md) | **Shipped** — the opt-in LLM-callable `agent` tool (orchestrator-workers): a bounded worker agent inside the calling `llm` turn, same worktree, fresh context, every knob clamped to the caller's, typed `outputs` back, transcript under a `__agent.*` synthetic node id, worker steps nested under the caller in the Cost breakdown. |
| [`pi-085-auth-migration.md`](pi-085-auth-migration.md) | **Shipped** — the move off pi-ai's global OAuth registry onto per-provider `ProviderAuth`, pinned at 0.87.1. |
| [`secret-scrubbing.md`](secret-scrubbing.md) | **Shipped (experimental)** — Aho-Corasick credential scan on `runs export`, `[REDACTED:source]` markers, `liveLiteralHit`, `fragua ci --export` exit 80. The scrubber registry and marker format are still unfrozen; the open §15 / V2 items have no sponsor. |
| [`workflow-ir.md`](workflow-ir.md) | **Shipped (A + C), (B) deferred** — the stored IR with `ir_version` and converters landed; `sha = hash(canonical IR core)` waits until the graph feature set is complete. Archived as a record; revive with a brief when (B) is wanted. |
| [`tool-exec-variant.md`](tool-exec-variant.md) | **Parked** — `exec: {cmd, args}` argv form + `idempotent:` marker on the `tool` kind. Designed, no sponsor for 120+ days. |
| [`hitl-channel.md`](hitl-channel.md) | **Parked** — `fragua ci --on-pause=…` / `--resume` / console resolver. Route options on the pause fact shipped; the rest has no sponsor. |
| [`cache-retention.md`](cache-retention.md) | **Parked** — one `defaults.cache-retention` key threaded to pi-ai's `cacheRetention`. Small and sound; no sponsor. |
| [`fan-out-runs.md`](fan-out-runs.md) | **Parked** — the cross-run fan-out primitive. The direction is now carried by `workflow-as-step.md` (one child run per step); revive only if the N-way sweep shape is wanted on its own. |
| [`worktree-opt-out.md`](worktree-opt-out.md) | **Parked (unsound as drafted)** — `--no-worktree` in-place execution. Refuted on its no-bump claim and carries an in-place crash-replay gap; both block. |
