# Archived proposals

Proposals that have **shipped** or been **superseded**. They are kept as a
design record only — nothing live should depend on them. The authoritative
description of shipped behavior lives in [`docs/SPEC.md`](../../SPEC.md) and
[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md); active design work lives one
directory up in [`docs/proposals/`](../).

| Doc | State |
|---|---|
| [`cli-topology.md`](cli-topology.md) | **Shipped** — five of six children landed (intent-plane, fragua-ci, cli-store-client, bundles, event-contract-version); the principle ("sole fact-writer + store-clients") lives in `CLAUDE.md`. Only [`hitl-channel.md`](../hitl-channel.md) remains open. |
| [`event-contract-version.md`](event-contract-version.md) | **Shipped** — event-contract version axis split + recoverable pause on mismatch. |
| [`bundles.md`](bundles.md) | **Shipped** in 0.2.0 — portable `.fragua` bundles (`ci --export` / `show` / `import`), run_state derived on import. Reach-goals (message-content-as-blobs, resume-of-imported) remain unbuilt. |
| [`db-import.md`](db-import.md) | **Superseded** by `bundles.md` — kept for its identity-collision-safety and table-by-table portability rationale. |
| [`large-run-inputs.md`](large-run-inputs.md) | **Shipped** — Part A (`routing.input` removed; schedule desc → run title; schema v1→v2) and Part B (spill oversized `routing.inputs` to the blob CAS, GC roots, bundle export/import, scrubber composition) both landed. Sits behind the experimental bundle/scrubber contract — that flag is owned by [`secret-scrubbing.md`](../secret-scrubbing.md). |
