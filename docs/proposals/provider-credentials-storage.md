---
title: Provider credentials in the store — built-in pi-ai providers
summary: "Move built-in provider credentials from ~/.swarm/auth.json into a provider_credentials table on the global store. AuthStorage becomes store-backed; !cmd/env credential resolution is cut from the main path. Custom providers stay on models.json until the follow-up proposal lands."
status: proposed
maturity: designed
last-reviewed: 2026-05-15
---

# Provider credentials in the store — built-in pi-ai providers

> Built-in provider credentials live in `~/.swarm/auth.json` today, coordinated across the daemon,
> serve, and `swarm providers` CLI by `proper-lockfile`. The credential *value* can be a `!cmd`
> shell string or an env-var name resolved at read time (`resolve-config-value.ts`). Both are extra
> moving parts the store should own.
>
> This proposal moves built-in credentials into a `provider_credentials` table and cuts `!cmd`/env
> resolution from the main credential path. Custom providers (`models.json`) stay untouched; the
> follow-up [provider-config-storage](./provider-config-storage.md) lifts those.

## Why

- **Ground rule 4** ("the store is the only coordination surface") is violated today: `auth.json` +
  `proper-lockfile` is a second coordination surface. Restarting one process while another reads
  stale state, torn whole-file writes corrupting every provider at once, and the file-lock dance
  are all symptoms.
- **Originating pain** (2026-04-20, session `0abe0c64`): the first ci-gate run required restarting
  both daemon *and* serve to get a key recognised — auth coupled to process lifecycle.
- `!cmd` / env-var **credential resolution** (`resolve-config-value.ts`) is dead weight for the
  built-in path. Keys are short literal strings; the indirection serves no one. (Custom providers
  use the same machinery — they're the reason this proposal can't kill it outright; PR2 does.)

## Scope split — what this proposal does *not* do

| Concern | This proposal | Follow-up ([provider-config-storage](./provider-config-storage.md)) |
|---|---|---|
| `auth.json` (built-in credentials) | Removed; rows in `provider_credentials` | — |
| `!cmd` / env in **AuthStorage** path | Cut | (already cut) |
| `setRuntimeApiKey` / `runtimeOverrides` | Removed (dead code) | — |
| `models.json` (custom-provider definitions) | Untouched | Moved to `provider_config` table |
| `!cmd` / env in **ModelRegistry** path | Untouched | Cut; `resolve-config-value.ts` deleted |
| `ProviderConfigSchema.apiKey` field | Untouched | Removed |
| `providers-custom.ts` | Untouched | Writes the store instead of `models.json` |

A **transient inconsistency** is intentional: between this PR and the follow-up, `!cmd`/env still
work for keys stored in `models.json`'s custom-provider `apiKey` field. Call it out in the
release notes.

## Schema

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider   TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('api_key','oauth')),
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

- `payload` = full `AuthCredential` JSON (api_key form or OAuthCredentials).
- `kind` mirrors `payload.type` — denormalised so `swarm-debug` can inspect row kinds without
  JSON-parsing.
- No `version` column (see OAuth-refresh decision below).
- No `tenant_id` — single-daemon model on `main`; tenancy stays out of scope.
- Migration step 9 (`CURRENT_SCHEMA_VERSION` 8 → 9). Pure additive; the existing v8 DBs on disk
  pick up the table via the migration step (not via `schema.sql` alone).

## Architectural decisions

### Promote `@swarm/store` to a runtime dependency of `@swarm/agent`

`@swarm/store` is currently a devDep of `@swarm/agent` (tests use it). It depends only on
`@swarm/types` — promoting to a runtime dep introduces no cycle. The new `SqliteAuthStorageBackend`
lives in `packages/agent/src/credentials/` and imports the store directly. PR2's
`ModelRegistry.create(authStorage, store)` will also need this. Doing the promotion now avoids a
late-game callback indirection.

### `SqliteAuthStorageBackend` slots into the existing seam

`AuthStorage` already has `interface AuthStorageBackend { withLock / withLockAsync }` plus an
`AuthStorage.fromStorage(backend)` factory. The backend takes a whole-blob JSON
(`AuthStorageData = Record<provider, AuthCredential>`); the SQLite impl rebuilds that blob from the
rows on read and applies the returned `next` blob by full-replace (upsert each provider in `next`;
delete any row absent from `next`). Full-replace is correct at <20 rows and avoids diff logic.

`AuthStorage.fromStore(store)` becomes the canonical factory.

### OAuth refresh: last-writer-wins, no `version` column

`BEGIN IMMEDIATE` cannot be held across the network `await` in `refreshOAuthTokenWithLock`.
`withLockAsync` reads outside any txn, `await`s the refresh, then writes in a short `writeTxn`.
Races are benign: every racer refreshes the *same* refresh token and gets equivalent credentials;
last write wins, all readers get a valid key. The file lock mattered mainly because a torn
whole-file JSON write corrupts every provider at once — per-row SQLite writes are atomic.

**Assumption documented in code:** refresh tokens are reusable across racers. True for current
pi-ai providers; revisit if a provider lands with single-use refresh.

## AuthStorage simplification

`getApiKey(providerId)` collapses to:

```
api_key  → cred.key                       # verbatim, no resolveConfigValue
oauth    → locked refresh (kept)
fallback → fallbackResolver?.(providerId)  # custom-provider models.json path; PR2 removes
```

Steps removed:
- Runtime override (`setRuntimeApiKey` / `runtimeOverrides`) — dead code, zero callers.
- Env-var fallback (`getEnvApiKey`) — "no ENV".
- `resolveConfigValue(cred.key)` for api_key — "no !cmd".

`hasAuth` drops the `getEnvApiKey` check. `describeAuthSource` labels become `"stored api_key"` /
`"stored oauth"` / `"models.json custom provider"` (PR2 removes the last) / `null`.

`FileAuthStorageBackend` and the `proper-lockfile` import are removed. `InMemoryAuthStorageBackend`
stays (tests). `AuthStorage.create(authPath?)` is removed; callers use
`AuthStorage.fromStore(store)`.

## Server / preflight

- `POST /providers/:name/credentials` (`packages/server/src/routes/providers.ts`): body becomes
  `{ key: string }`, stored verbatim. Drops `kind: "shell"` and `kind: "env"`, drops the
  `!`-prefix normalisation. The route still calls
  `authStorage.set(name, { type: "api_key", key })`, which now persists to the DB transparently.
- `envProviderPreflight` + `PROVIDER_ENV_KEYS` (`packages/server/src/store/routes.ts:83-110`) — dead
  code, deleted along with the export in `packages/server/src/index.ts`.
- `registryPreflight` is unchanged — it already runs through `AuthStorage`/`ModelRegistry`; only
  its `detail` string drops the "auth.json" mention.

## CLI

- New `openGlobalStore()` helper: `new SqliteStore({ path: join(getSwarmHome(), "swarm.db") })`.
  Credentials are global per `paths.ts`'s long-standing policy; the providers CLI always targets
  `~/.swarm/swarm.db`, not the project-local store.
- `daemon.ts` and `serve.ts` swap `AuthStorage.create()` for `AuthStorage.fromStore(store)` — `store`
  is already in scope at both call sites.
- `providers.ts` has six `AuthStorage.create()` sites; each opens the global store, builds the
  store-backed `AuthStorage`, and `store.close()`s. The interactive `add` flow restricts the input
  shape to a literal key (drops the `literal | env | shell` selector if present), matching the HTTP
  route. User-facing strings drop `~/.swarm/auth.json` references.

## Deletions summary

- `FileAuthStorageBackend` class.
- `proper-lockfile` + `@types/proper-lockfile` (`packages/agent/package.json`).
- Auth half of `paths.ts`: `getAuthPath`, `getPiFallbackAuthPath`, `resolveAuthPath`, the auth
  branch of `bootstrapFromPi` / `bootstrapSwarmHomeFromPi`. The models half stays for PR2.
- `envProviderPreflight` + `PROVIDER_ENV_KEYS` (+ the `index.ts` export).
- `setRuntimeApiKey` / `removeRuntimeApiKey` / `runtimeOverrides` field on `AuthStorage`.
- The env-var step + the `resolveConfigValue` call inside `AuthStorage.getApiKey`.

## Out of scope (deferred to [provider-config-storage](./provider-config-storage.md))

- `model-registry.ts` `apiKey` field, `resolveCustomProviderApiKey`, `setFallbackResolver` wire,
  `resolveConfigValueOrThrow` / `resolveHeadersOrThrow` consumers, `clearApiKeyCache`.
- `providers-custom.ts` (the `swarm providers add --custom` flow).
- `resolve-config-value.ts` (kept while ModelRegistry consumes it).
- Models half of `paths.ts` + `~/.pi/agent/models.json` bootstrap.
- `models.json` itself.

## Risks

- **Full-replace apply in the backend** — the seam doesn't express per-row deletes naturally;
  full-replace is correct at <20 rows.
- **CLI opens the global `~/.swarm/swarm.db` while the daemon also has it open** — relies on SQLite
  WAL + short txns. The existing harness model already does multi-process writes; this isn't new,
  but it's a behaviour change from the old `proper-lockfile` coordination. Call out in the PR.
- **First-ever `swarm providers add` creates + migrates the global DB** — heavier first-run side
  effect than the old file write, intended.
- **OAuth last-writer-wins** assumes reusable refresh tokens. True for current pi-ai providers.
- **No migration** — `auth.json` is dropped outright (ground rule 11: pre-release, no
  backwards-compat). Users re-run `swarm providers add` / `login`.

## Tests + docs

- New `packages/store/test/provider-credentials.test.ts`: upsert/get/list/delete; `ON CONFLICT`
  preserves `created_at`; CHECK rejects bad `kind`; migration test (v8 DB → v9, table exists).
- New `packages/agent/test/auth-storage-sqlite.test.ts`: api_key + oauth round-trip; full-replace
  apply with delete-missing; OAuth refresh-across-`await` with a fake `getOAuthApiKey`;
  concurrent-writer last-writer-wins.
- Rewrite any test calling `AuthStorage.create(tmpPath)` or asserting on `auth.json` file state.
- `auth-fallback.test.ts` stays (`fallbackResolver` survives this PR).
- Same-PR doc obligations per CLAUDE.md: `ARCHITECTURE.md` §2 (new table), §7 (credential storage
  description); `README.md` (drop `~/.swarm/auth.json` mentions, call out the transient `!cmd`/env
  inconsistency in the custom-provider corner); `STATUS.md` if user-visible;
  `.agents/skills/swarm-debug/SKILL.md` (post-mortems read `provider_credentials`);
  `.agents/skills/swarm-run/SKILL.md` (pre-flight section).

## Verification (manual, end-to-end)

1. `rm ~/.swarm/swarm.db ~/.swarm/auth.json` (dev only).
   `swarm providers add anthropic` — paste a literal key. Expect "stored credentials".
   `sqlite3 ~/.swarm/swarm.db 'select provider, kind from provider_credentials'` → row present; no
   `auth.json` on disk.
2. `swarm providers ls` shows `✓ anthropic` with the new source label.
   `swarm providers test anthropic` does a 1-token call successfully.
3. Restart the daemon (`swarm harness`). `swarm run <workflow>` enqueues; the codergen node gets the
   key from the same DB (no env var set).
4. OAuth: `swarm providers login <provider>`, force-expire the token, trigger a run. Refresh
   happens; `payload` / `updated_at` change.
5. Custom-provider regression: a pre-existing `~/.swarm/models.json` entry with
   `apiKey: "!cmd …"` still resolves at request time (this PR deliberately leaves that path
   alone — to be removed in the follow-up).
6. `swarm providers rm anthropic` deletes the row; `swarm providers ls` reflects it.
