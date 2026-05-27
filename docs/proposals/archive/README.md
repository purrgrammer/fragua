# Archived proposals

Proposals that have **shipped** or been **superseded**. They are kept as a
design record only — nothing live should depend on them. The authoritative
description of shipped behavior lives in [`docs/SPEC.md`](../../SPEC.md) and
[`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md); active design work lives one
directory up in [`docs/proposals/`](../).

| Doc | State |
|---|---|
| [`event-contract-version.md`](event-contract-version.md) | **Shipped** — event-contract version axis split + recoverable pause on mismatch. |
| [`bundles.md`](bundles.md) | **Shipped** in 0.2.0 — portable `.fragua` bundles (`ci --export` / `show` / `import`), run_state derived on import. Reach-goals (message-content-as-blobs, resume-of-imported) remain unbuilt. |
| [`db-import.md`](db-import.md) | **Superseded** by `bundles.md` — kept for its identity-collision-safety and table-by-table portability rationale. |
