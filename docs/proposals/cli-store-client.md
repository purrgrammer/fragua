---
title: CLI as a direct store-client — remaining items
summary: "The CLI is a direct store-client (no HTTP): it opens the local SQLite, reads via the read plane, writes intents via the intent plane — SHIPPED. Trimmed to the three items that did NOT land: removing the vestigial --url, the `fragua db migrate` verb, and extending the ci exit-code taxonomy to run/runs."
status: mostly-shipped
maturity: shipped
last-reviewed: 2026-05-25
parent: cli-topology.md
---

# CLI as a direct store-client — remaining items

> **Shipped.** The whole CLI is a direct store-client — it opens the local store
> (`packages/cli/src/store-client.ts`, `withStoreClient`, `migrate:false`) and
> reads/writes through the two planes; **no command makes an HTTP call** to a
> fragua server. `fragua run` saves + enqueues via the intent plane and tails via
> `readPlane.eventsSince` (follow by default; `--no-follow` to exit); the
> operate/schedule verbs are store-clients; the `'web'`→`'client'` writer rename
> landed; `fragua ci` embeds the executor. The full design record is in git.
>
> Child of [`cli-topology.md`](cli-topology.md). This file is trimmed to the
> three items that have NOT landed.

## Open items

1. **Remove the vestigial `--url`.** No CLI command makes an HTTP call anymore,
   but `runs` still declares `--option("--url <url>", …)` and threads it through
   `discovery()` — dead wiring (`bin/fragua.ts`, `operator.ts`). Remove the
   option and the `url?` field on the discovery shape so the surface matches
   reality.

2. **`fragua db migrate` — explicit, consent-driven.** The `{migrate:false}`
   store-open mode shipped (store-client verbs open without bumping schema and
   error on a version mismatch). But the operator-facing `fragua db migrate`
   verb the error points at does NOT exist (`db.ts` has vacuum / gc-blobs /
   backup only). Add it: `--dry-run` prints the plan (`vN → vM: [list]`), pairs
   with `db backup --to`. Harness/daemon keep auto-migrate; this is the manual
   path for a store-client operator. Migrations are transactional + version-gated,
   so concurrent `migrate()` is safe — the reason to gate it is *surprise*, not
   correctness.

3. **Extend the exit-code taxonomy to `run`/`runs`.** The full
   `HaltReason`/`PauseReason`/`QuarantineReason` → code map landed for `fragua ci`
   (`packages/cli/src/ci-exit.ts` `ciExitCode`, exhaustive over the unions, with a
   `never` check per CLAUDE.md §1). `run --follow` / `runs tail` still use the
   coarse `followRun` map (halt→1, cancel→130, else 0). Route them through
   `ciExitCode` too so a followed run's exit code carries the same outcome detail
   — pipelines can *retry* on `occ_exhausted`/`timeout_exhausted` and distinguish
   pause-needs-human from fail.

## Note on the shipped shape vs the original sketch

Two things shipped *differently* from the original design and the umbrella's §2
table: `run` **follows by default** (`--no-follow` opts out), not
enqueue-and-exit; and there is no separate `fragua watch` verb — tailing an
existing run is **`fragua runs tail`** (the follow loop is shared between
`run --follow` and `runs tail` in `run-follow.ts`).
