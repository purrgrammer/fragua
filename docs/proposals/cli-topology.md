---
title: CLI topology — umbrella roadmap (store-client CLI, intent plane, embedded CI, pluggable HITL)
summary: "Umbrella over four independently-shippable proposals, unified by one principle: the daemon is the sole fact-writer; everything else is a store-client. Holds the shared cut, the dependency DAG + ship order, and the cross-cutting decisions log. Detail lives in the child proposals."
status: proposed
maturity: sketch
last-reviewed: 2026-05-21
---

# CLI topology — umbrella

> **This is an index, not a spec.** The design is decomplected into four child
> proposals, each built/tested/shipped on its own. This file holds only what is
> shared across them: the principle, the topology cut, the dependency DAG +
> ship order, and the cross-cutting decisions. Everything else lives in the
> children linked below.

## 1. The one load-bearing principle

**There are exactly two roles: the sole fact-writer, and store-clients.** The
daemon/executor is the only thing that writes `fact.*`. *Everything else* —
server, CLI — reads and writes `intent.*`. Two corollaries:

- **An intent is a durable request, not an RPC.** The writer's contract ends at
  "this is in the log." No client blocks on, or errors about, daemon liveness.
- **One write plane, many ports.** Validation, event construction, and run-id
  minting are one code surface, behind thin adapters: HTTP (the browser's port —
  it can't open SQLite) and argv (the terminal's port — it can).

## 2. The topology cut

| Entity | Role | Store | Tails? | Exit code means |
|---|---|---|---|---|
| **daemon** | sole fact-writer | shared | — | — |
| **server** | store-client + HTTP/SSE veneer **for the browser** | shared | serves SSE | — |
| **`fragua <verb>`** | store-client for the terminal; **no HTTP** | local/shared | only `watch` | intent **recorded** |
| **`fragua ci`** | embeds the executor (writes facts) | **ephemeral, portable** | yes | run **outcome** |

Today's CLI is the worst of both worlds: `discoverHarnessUrl` (`run.ts:70`)
opens the local store, reads `daemon_lock`, closes it — then HTTP round-trips to
the *same machine*. If you can read the store to find the daemon, you can write
the intent to the store directly.

## 3. Precursors + child proposals

**Precursors (land before the line of work):**

| Proposal | What | Maturity |
|---|---|---|
| pre-0.1.0 cleanup — **shipped** | nuked the `agent` tool + sub-agent machinery; collapsed migrations to a fresh baseline; widened `run_id` to a ULID | ✅ done |
| [`executor-pbt-decomposition.md`](executor-pbt-decomposition.md) | untangle the executor; **Phase 8** extracts the assembly into a factory with injectable tool/credentials registries — what `fragua ci` stands on | designed |

**Children:**

| # | Proposal | What | Maturity |
|---|---|---|---|
| 1 | [`intent-plane.md`](intent-plane.md) | shared validate/construct/mint surface, two ports | designed |
| 2 | [`fragua-ci.md`](fragua-ci.md) | embedded executor over an ephemeral, portable store | sketch |
| 3 | [`cli-store-client.md`](cli-store-client.md) | CLI as a direct store-client; `run` enqueues, `watch` tails; log UX; `db migrate` | sketch |
| 4 | [`hitl-channel.md`](hitl-channel.md) | pluggable HITL — the interviewer pattern over pause-fact/answer-intent | sketch |
| 5 | [`db-import.md`](db-import.md) | cross-machine import of a run's events into another store | sketch |
| 6 | [`event-contract-version.md`](event-contract-version.md) | gate resume on an event-contract version, not the DB counter; make mismatch a recoverable pause not a terminal halt | sketch |

## 4. Dependency DAG + ship order

```
  cleanup-pre-0.1.0 ─┐  (agent-tool removal · migration collapse · run_id widen)
  executor Phase 8 ──┤  (assembly factory + injectable registries)
                     ▼
        intent-plane  ──┬──▶ fragua-ci (MVP: fail-on-pause)
         (foundation)   │         │
       + store {migrate:false}    ├──▶ db-import ──▶ event-contract-version
                        └──▶ cli-store-client       (independent; substrate
                                  │                   under safe cross-version
                                  └──▶ hitl-channel   import)
                                       (auto-approve, console)
```

Two precursors land first: the **cleanup** (subtractive; removes the run-tree
and stranded-old-run edges, widens `run_id`) and **executor Phase 8** (the
assembly factory `fragua ci` reuses). `event-contract-version` is independent
but is the substrate that makes cross-version `db-import` safe.

**Order: cleanup + executor Phase 8 → intent-plane (+ store `{migrate:false}`) →
fragua-ci (urgent) → cli-store-client → hitl-channel → db-import.** An
adversarial pass moved `fragua-ci` off "needs only intent-plane": it also needs
the assembly factory and the env→creds bridge, which is why it is now `sketch`.

## 5. Cross-cutting decisions

1. **Remove `--url`.** Remote control is out of scope; the CLI is a co-located
   store-client. Revisit if remote control becomes a goal. *(owns: cli-store-client)*
2. **Rename `events.writer` `'web'` → `'client'`.** The axis is fact-writer
   (`'daemon'`) vs store-client (`'client'`); a direct-writing CLI is neither
   `'daemon'` nor `'web'`. Schema migration + enum-consumer sweep (CLAUDE.md §1).
   *(touches: intent-plane, cli-store-client, store schema)*
3. **Widen `run_id` for cross-machine import.** Today ULID-*like* (~40 bits
   suffix entropy after `% 32`). Cross-machine merge (db-import) needs more — true
   ULID / UUIDv7 / no modulo-32 loss. **Lands in the cleanup** (free while the
   schema is reset); the moved `newRunId` is already the wide form.
   *(owns: cleanup-pre-0.1.0; hosts: intent-plane; motivates: db-import)*
4. **`fragua db migrate` — explicit, consent-driven.** Migrations are
   transactional + version-gated, so concurrent `migrate()` is *safe*; the reason
   to stop a store-client from auto-migrating is *surprise*, not correctness.
   Full semantics in [`cli-store-client.md`](cli-store-client.md). *(owns: cli-store-client)*
5. **Store `{migrate:false}` open mode.** The store constructor always migrates
   (`store.ts:346`); a store-client must open without bumping. New store API,
   foundational to the whole CLI line. *(owns: cli-store-client; pull forward with
   intent-plane)*
6. **Remove the `agent` tool.** Done in the cleanup precursor — eliminates
   sub-agent runs and the `parent_run_id` linkage, which is what makes a run a
   self-contained row for `db-import`. *(owns: cleanup-pre-0.1.0)*

## 6. What this resolves

- **`serve.json` deletion** (the question that started this): load-bearing *for
  a mode being designed away* (standalone `serve` URL discovery). Removed via §2
  (no HTTP discovery in the CLI) + URL → a store row (the harness already does
  this via `updateDaemonLockHttp`; standalone `serve` gets its own `server_lock`
  row so `serve.json` dies into it).
- **Ground rule #4 ("store is the sole coordination surface")** holds uniformly
  once `serve.json` is gone and URL publication lives in the store.
- **"HITL in CI"** — answered by `hitl-channel`'s auto-approve channel.
