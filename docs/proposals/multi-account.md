---
title: Multi-account support per provider
status: proposed
maturity: sketch
last-reviewed: 2026-05-07
---

# Multi-account support per provider

> Today, credentials are `Record<provider, AuthCredential>` in
> `~/.swarm/auth.json` — exactly one credential slot per provider type.
> Multiple Anthropic accounts (work vs. personal, separate billing,
> separate quota pools) cannot coexist. The OpenAI-compatible
> custom-provider escape hatch in `models.json` does not generalise:
> it requires an OpenAI-shaped endpoint, so Anthropic / Bedrock /
> Vertex / Gemini have no workaround at all.

## Motivation

Two operator drivers, both real:

- **Billing / org separation.** A single human runs swarm against a
  personal Anthropic key for hobby projects and a work key billed to
  their employer. Today they share one slot; switching means rewriting
  `auth.json`. Telemetry and analytics roll up by `provider`, so
  per-org cost reporting is impossible without re-tagging at the
  warehouse.
- **Per-run / per-workflow credentials.** A scheduled run on one
  project should bill to one account; an interactive run on a sibling
  project should bill to another. The selection wants to live at the
  *operational* layer (run intent, schedule, project config), not in
  the workflow file — otherwise every workflow forks per account.

Failover within a vendor and rate-limit-pool rotation are obvious
later wins, but neither is the v1 driver. They fall out for free once
accounts are first-class.

## Approaches considered

### A. Custom-provider workaround (rejected)

Register `anthropic-work`, `anthropic-personal` as separate provider
entries. Workflow declares `llm_provider="anthropic-work"`.

Rejected for three reasons:

1. **Doesn't cover non-OpenAI providers.** The `models.json`
   custom-provider path expects an OpenAI-completions-compatible
   endpoint. Anthropic, Bedrock, Vertex, Gemini, AWS — all
   inaccessible.
2. **Wrong axis of variation.** Per-run credentials wants account to
   be a runtime selection. Encoding it in the provider name forces
   every workflow that uses Anthropic to fork per account.
3. **Loses curated metadata.** pi-ai's bundled model list, OAuth
   provider IDs, retry classifications all key on canonical provider
   slugs. A custom entry is a parallel universe with none of that.

### B. First-class accounts under one provider type (recommended)

Credentials become `(provider, account, credential)`. Workflow refs
stay `llm_provider="anthropic"` — account is selected at the
operational layer. A reserved `"default"` account name preserves
today's single-account ergonomics: existing `auth.json` files import
as `{ anthropic: { default: <cred> } }` with no behaviour change for
any existing workflow.

This is the shape this proposal commits to.

## Shape

### Storage

Credentials become two-level. The on-disk and in-DB representation
both key on `(provider, account)`:

```jsonc
// auth.json (or its DB-backed successor)
{
  "anthropic": {
    "default": { "type": "oauth", ... },
    "work":    { "type": "api_key", "key": "!cmd op read op://Work/..." }
  },
  "openai": {
    "default": { "type": "api_key", "key": "..." }
  }
}
```

Migration is mechanical: any flat `{ provider: cred }` entry is
re-read as `{ provider: { default: cred } }`. No write-side migration
required for existing single-account installations.

### Selection precedence

Highest wins:

1. Run intent — `swarm run … --account work` / `POST /runs { account }`.
2. Schedule's `account` field for runs created by a schedule.
3. Project config — `<cwd>/.swarm/config.jsonc` →
   `accounts.<provider>: "work"`.
4. Global config — `~/.swarm/config.jsonc` → `accounts.<provider>`.
5. `"default"` literal.

Workflows do **not** carry an `llm_account` attribute. Account is an
operational dimension, not an authoring one. A workflow author who
hardcodes `anthropic-work` in a node would re-introduce exactly the
fork-per-account problem this proposal exists to avoid.

### Event taxonomy impact

Every site in `packages/types/src/swarm-events.ts` and downstream
that carries `provider: string` extends to `(provider, account)`.
The grep-the-monorepo set is the same one CLAUDE.md flags for
enum-literal consumers — the typecheck pass alone won't catch label
maps, hardcoded SQL `WHERE` clauses, or analytics aggregations:

| Surface | Today | After |
|---|---|---|
| `fact.provider_error { provider }` | string | `{ provider, account }` |
| `fact.run_paused_provider_retry { provider }` | string | `{ provider, account }` |
| Summariser metadata | `provider/model` | `provider:account/model` |
| Fidelity / sessionId hint | `provider`-keyed | `(provider, account)`-keyed |
| Quarantine table | `provider` | `(provider, account)` |
| `analytics-queries.ts` rollups | group by `provider` | `provider` *and* `(provider, account)` both kept |

Quarantining one account does not quarantine the vendor. Failover
within a vendor (try the next account when this one is paused) is a
follow-up; the data shape needed for it lands here.

### CLI surface

```sh
swarm providers ls                              # tree view: provider → accounts → credentialed status
swarm providers add anthropic --account work    # add a non-default account
swarm providers rm  anthropic --account work    # remove just one account
swarm providers test anthropic --account work
swarm run … --account work                      # operational override
```

`swarm providers add anthropic` (no `--account`) targets `default` —
existing muscle memory unchanged.

## Composition with the deferred credentials proposal

[`credentials.md`](./credentials.md) (status: deferred, maturity:
designed) declares:

```sql
CREATE TABLE credentials (
  provider TEXT PRIMARY KEY,
  ...
);
```

When that proposal is un-deferred, the primary key becomes
`(provider, account)`. Both proposals can land independently, but
whichever ships first should be aware of the other:

- If credentials-in-DB lands first with `provider TEXT PRIMARY KEY`,
  multi-account requires a schema migration — costly because
  credential rows are encrypted blobs.
- If multi-account lands first against `auth.json`, credentials-in-DB
  inherits the two-level shape from day one.

Lower-cost ordering: multi-account first against `auth.json`,
credentials-in-DB second with `(provider, account)` baked in.

## Open questions

1. **OAuth account scoping.**
   - pi-ai's `OAuthProviderId` keys per provider, not per account.
     Each account having its own OAuth state is the obvious shape,
     but the OAuth callback URL / port-forwarding flow may not
     cleanly disambiguate which account is being logged in.
   - v1 stance: API-key accounts are unrestricted; OAuth providers
     are restricted to `default` account only. Lift later if a real
     use case shows up.

2. **Custom-provider × accounts.**
   - A custom entry in `models.json` (e.g. `ollama`) inherits
     accounts uniformly: `{ ollama: { default: cred, work: cred2 } }`.
   - But: the value of multi-account on a self-hosted Ollama is near
     zero. v1 supports it for symmetry; doc explicitly notes the
     intended use is hosted vendors.

3. **Model availability per account.**
   - Some orgs have early-access models others don't (Anthropic
     beta access, OpenAI invite-only models). Open whether `account`
     can override the registered model list, or whether the registry
     stays global and accounts are credential-only.
   - v1: credential-only. Model availability is a lookup-time concern;
     401/403 from a missing model surfaces via existing
     `provider_error` plumbing.

4. **Default-account discoverability.**
   - If a project hasn't pinned an account and a vendor has multiple
     credentialed (e.g. `default` + `work`), what happens?
   - Options: error at validation time, prompt at enqueue, fall back
     to `default` silently.
   - Recommended: validate at enqueue. If `default` exists, use it;
     if it doesn't and multiple accounts exist, error with a clear
     message ("anthropic has accounts [work, personal]; pick one
     with --account or set accounts.anthropic in config.jsonc").

5. **Account name validation.**
   - Free-form strings are dangerous (path traversal, log injection).
     Constrain to `[a-zA-Z][a-zA-Z0-9_-]{0,63}`.
   - `default` is reserved.

6. **Per-run intent vs. per-step.**
   - Run intent picks one account for the whole run. What about a
     workflow with two LLM nodes that should each bill to a different
     account?
   - v1: not supported. Account is a run-level dimension; per-step
     selection is the same axis problem the workflow attribute
     fights with. If real workflows pinch, revisit with a
     `llm_account` attribute *as the lowest-precedence override*
     (still beaten by run/schedule/project intent).

7. **Schedule-level account in `scheduled-runs.md`.**
   - `scheduled-runs.md` is shipped. Adding `account` to schedule
     rows is an additive schema column with default `null`
     (interpret as "use config / default"). No migration of existing
     schedules.

8. **Analytics rollup migration.**
   - `analytics-queries.ts` aggregations group by `provider` today.
     Adding `account` is purely additive (new queries / dimensions);
     existing queries keep working. The web UI's Analytics page
     gains a per-account drill-in as a follow-up — out of scope here.

9. **Telemetry leakage of account names.**
   - Account names may carry semantic info ("acme-corp", "client-X").
     Should the `provider_error` event redact the account name when
     emitted to telemetry?
   - v1: no redaction. Account names are operator-chosen and operator-
     visible; redacting them defeats their purpose. Document that
     account names are not for storing secrets.

10. **Pause classification key.**
    - `paused_provider_retry` keys quarantine on `provider`. If we
      key on `(provider, account)`, a quarantined `work` account
      doesn't block `default` — desired. But the `STATUS.md` /
      ARCH §3 status enum claim ("provider quarantined") should be
      audited for whether any consumer assumes provider-level
      granularity.

11. **Migration ergonomics.**
    - Existing flat `auth.json` files: re-read as `{ provider: { default: cred } }` on load. Write path normalises to two-level.
    - One-time `swarm providers migrate` is unnecessary if reads tolerate both shapes; a write through the new code path materialises the two-level shape on first edit.

12. **Failover semantics (deferred).**
    - With accounts first-class, "if `default` is paused, try `work`"
      is a natural follow-up. The shape needed (account list per
      provider, ordering) is implicit in the `Record<account, cred>`
      map but not consumed by any router yet.
    - Out of scope for this proposal; capture in
      [`provider-auto-retry.md`](./provider-auto-retry.md) follow-up
      or a new `provider-failover.md` when scheduled.

## What this does not commit to

- **In-workflow account selection.** No `llm_account=` node
  attribute. Account is operational, not authored.
- **Per-step credential rotation within a run.** A run picks one
  account at start; all LLM calls in that run use it.
- **Account-level model registries.** Models stay registered against
  provider type, not `(provider, account)`. Token-counting,
  capability lookups, default-model fallback all key on provider
  alone.
- **Multi-tenant isolation.** This is a single-operator-with-multiple-
  accounts feature. True multi-tenant (different humans, RBAC,
  per-user encryption keys) is out of scope and would need the
  `credentials.md` threat-model resolution first.
- **OAuth multi-account on day one.** API-key only for non-default
  accounts in v1.

## Implementation sketch (when scheduled)

1. **Schema / storage layer.**
   - `AuthStorageData` becomes `Record<string, Record<string, AuthCredential>>`.
   - Read-side back-compat: a flat `{ provider: cred }` is treated
     as `{ provider: { default: cred } }`.
   - Write-side normalises to two-level.
   - `AuthStorage.hasAuth(provider, account?)`,
     `getAuth(provider, account?)`, `getApiKey(provider, account?)`.

2. **Config cascade.**
   - `~/.swarm/config.jsonc` and `<cwd>/.swarm/config.jsonc` gain
     an `accounts: Record<string, string>` block.
   - Resolution helper picks account per provider with the
     precedence chain above.

3. **Run intent surface.**
   - CLI: `swarm run … --account <name>` (single string; applies to
     every provider used in the run).
   - HTTP: `POST /runs` body gains `account?: string`.
   - Persisted on `run_state` (new column `account TEXT`).

4. **Schedule surface.**
   - Schedule rows gain an `account TEXT NULL` column. `INSERT … RETURNING`
     callers updated; existing rows interpret `NULL` as "use config".

5. **Event taxonomy.**
   - `provider_error`, `paused_provider_retry`, summariser events
     extend to carry `account`. Same-PR scan across `packages/` for
     consumers (per CLAUDE.md ground rule #1).
   - ARCH §3 row updates.

6. **Agent / handler bridge.**
   - `PiCodergenBackend` resolves `(provider, account)` once per
     run, passes the resolved credential through pi-ai unchanged.

7. **CLI providers commands.**
   - `swarm providers ls` becomes a tree (provider → accounts →
     credentialed status).
   - `add` / `rm` / `test` accept `--account` (defaulting to
     `default`).

8. **Web UI.**
   - Provider page shows accounts as nested rows.
   - Run detail shows the resolved `(provider, account)` for each
     LLM step.
   - Analytics page: per-account drill-in is a follow-up, not v1.

9. **Validator.**
   - `bun run swarm validate` warns when a workflow node's
     resolved account doesn't have credentials registered.
   - New warning code; same-PR update to
     `.agents/skills/swarm-author/SKILL.md` validator-codes table.

10. **Docs.**
    - ARCH §3 (event taxonomy) and §7 (operator routes) updated.
    - SPEC §3 (credentials model) updated.
    - `STATUS.md` "What swarm delivers today" gains the multi-account
      capability.
    - This proposal flips to `in-progress` while landing, `shipped`
      when STATUS.md can claim it without qualification.
