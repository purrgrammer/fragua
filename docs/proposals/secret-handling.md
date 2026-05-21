---
title: Secret handling — env credential discovery + store-boundary redaction
status: proposed
maturity: sketch
last-reviewed: 2026-05-20
---

# Secret handling — env discovery + redaction

> ⚠️ **HALF-BAKED SKETCH.** Captures a direction, not a design. The
> redaction half is safety-critical and must not ship off a sketch — it
> needs a threat-model pass and a test matrix first.

## Why

Both [deployment targets](../deployment.md) — local and CI — put agents, which
run shell and edit files, on machines that hold provider credentials. Two
independent surfaces, one critical:

1. **Audit artifacts must not leak secrets.** CI uploads `swarm.db` as a
   replayable audit artifact. If creds live in the `provider_credentials` table,
   the artifact leaks every org key.
2. **Transcripts must not leak secrets.** An agent that runs `cat .env`, or a
   provider error echoing a partial key, writes a secret into `messages` /
   observability events / blob previews — durable, then shipped in the artifact.

## Two parts

### Part A — env credential discovery (revives prior behaviour)

On `swarm harness` / `swarm daemon` start, scan `process.env` for the provider
key vars pi-ai knows (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) and register
them as **in-memory, non-persisted** credentials. Residue of this exists
(`packages/agent/src/backend.ts`, `summariser.ts` comments reference "user just
set `ANTHROPIC_API_KEY`"); reinstate it as a first-class, documented path.

- Default-on when the `provider_credentials` table is empty; explicit
  `--creds-from-env` to force.
- **Critical property:** env creds are never written to `provider_credentials`.
  This is what makes the CI audit artifact **secret-free by construction** — not
  scrubbed, never written. The redaction in Part B is then defense-in-depth, not
  the primary control for the artifact.

### Part B — store-boundary redaction scrubber (critical)

A redactor applied at the **store write boundary** — `appendMessage`,
`appendObservabilityEvents`, blob-preview writes — not in handlers. Boundary
placement means a leak is caught regardless of which handler produced it.

- **Known-value redaction (primary).** Maintain the set of active secret strings
  (env creds + any stored key fields). Replace any occurrence in written content
  with `[redacted:<provider>]`. Most reliable because we know the exact strings.
- **Shape-regex fallback (secondary).** Mask common token shapes (`sk-…`,
  `ghp_…`, AWS `AKIA…`, etc.) for keys we don't hold.
- Applies to `messages.content`, observability event payloads, and the bounded
  blob preview. Raw blob *content* on disk is a separate question (see below).

### Part C — redacted export (only if a local DB with persisted creds is ever shared)

`swarm db backup --redacted` nulls `provider_credentials` / `provider_config`
payloads on export. Only matters if someone hands out a *local* `swarm.db` that
has persisted creds in it. CI doesn't need it — Part A keeps the CI DB clean by
never writing creds. Lowest priority; listed for completeness.

## Open questions

- **Redaction cost on the hot path.** Scrubbing every message write is a string
  scan. Known-value set is small (a handful of keys) → cheap; the regex fallback
  is the cost. Make the regex pass opt-in/configurable?
- **Raw blob content.** Part B redacts the *preview*. A tool that writes a full
  `.env` to a blob still stores the secret in the content file. Redact blob
  content too, or treat blob writes as trusted? (Leans: scan blob content for
  known values at least.)
- **Partial-key echoes.** Providers sometimes echo `sk-…last4`. Known-value
  matching won't catch a truncated echo; the shape regex might over- or
  under-match. Acceptable residual risk?
- **Where the active-secret set lives.** The scrubber needs the current secret
  values at write time → a process-global registry the store can consult without
  a DB round-trip. Injection shape TBD (store can't import agent).
- **Interaction with [`credentials.md`](./credentials.md) /
  [`multi-account.md`](./multi-account.md).** Both move/expand credential
  storage; the scrubber's "active secret set" must track whatever those land on.

## Non-goals

- Encryption at rest of the store (separate concern; single-user local DB read =
  full read anyway, per SPEC §5).
- Secret *management* (rotation, vault integration) — out of scope; this is leak
  prevention only.
