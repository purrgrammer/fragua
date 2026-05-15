---
title: Custom-provider config in the store — follow-up to provider-credentials-storage
summary: "Move ~/.swarm/models.json into a provider_config table (per-provider JSON blob, Ajv-validated on read). Deletes resolve-config-value.ts and the !cmd/env credential machinery in its last corner. Closes the transient inconsistency from the credentials PR."
status: shipped
maturity: designed
last-reviewed: 2026-05-15
---

> **Note (implementation).** Migration landed as step 12 (v11 → v12). `ProviderConfigSchema` is exported from `@swarm/agent` for CLI writers; `ModelRegistry.create(authStorage, store)` takes a required store. `AuthStorage.getApiKey` no longer accepts `includeFallback`; the `"models.json custom provider"` describeAuthSource label is gone. `resolve-config-value.ts` is deleted.

# Custom-provider config in the store — follow-up to provider-credentials-storage

> Sequel to [provider-credentials-storage](./provider-credentials-storage.md). The credentials PR
> moves built-in provider credentials into the SQLite store and cuts `!cmd`/env resolution from the
> main `AuthStorage.getApiKey` path. Two things still live on disk after that PR lands:
>
> - `~/.swarm/models.json` — custom-provider *definitions* (Ollama, vLLM, LM Studio, proxies) and
>   built-in model/provider overrides.
> - `resolve-config-value.ts` — `!cmd` / env-var resolution, kept alive in `model-registry.ts`'s
>   custom-provider `apiKey` field and header values.
>
> This proposal closes both. After it lands, the store is the **only** persistence surface for
> credentials and provider config; `!cmd`/env resolution is gone repo-wide.

## Why

- Closes the second filesystem coordination surface. Nothing locks `models.json` today; a
  `swarm providers add --custom` write can race the daemon's read.
- Finishes the `!cmd`/env cut started in the credentials PR. The current transient inconsistency
  ("env/!cmd still work for custom-provider keys") goes away.
- Single source of truth: all provider metadata (auth + definition) is in one place; `swarm-debug`
  can inspect it via SQL.
- Per-row Ajv validation on read becomes a strictly better failure mode than today's all-or-nothing
  file load — one corrupt provider gets skipped (logged via `loadError`) instead of torching the
  entire registry.

## Schema

```sql
CREATE TABLE IF NOT EXISTS provider_config (
  provider   TEXT PRIMARY KEY,
  config     TEXT NOT NULL,        -- ProviderConfigSchema body (minus apiKey)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

- Per-provider JSON blob. `config` = the existing TypeBox `ProviderConfigSchema` body, **minus the
  `apiKey` field** (credentials always come from `provider_credentials`).
- Ajv-validated **on read** by `ModelRegistry.loadCustomModels`, **and on write** by the CLI as
  defence in depth.
- Migration step `[10, MIGRATION_010_PROVIDER_CONFIG()]` (or whatever the next free number is after
  the credentials PR's step 9).
- No `version` column. No `tenant_id`. The blob keeps all of pi-ai's flexibility (nested compat
  objects, routing config, header maps) without normalising into 30+ columns.

## `ModelRegistry` rewrite

Signature change: `ModelRegistry.create(authStorage, store: IEventStore)` replaces the
`modelsJsonPath?` parameter. The `inMemory(authStorage)` factory keeps a no-op loader for tests.

`loadCustomModels()` swaps the file read for `store.listProviderConfigs()`. For each row:

1. `JSON.parse(row.config)`.
2. Wrap in `{ providers: { [row.provider]: parsed } }`.
3. Ajv-validate the per-provider config against `ProviderConfigSchema`.
4. On success, run the existing merge/override/parse pipeline (`storeProviderRequestConfig`,
   `loadBuiltInModels`, `mergeCustomModels`, OAuth `modifyModels`, etc.) unchanged.
5. On validation failure, append the error to `loadError` and skip that row. Other providers still
   load. (Today's all-or-nothing file parse is replaced by per-provider isolation.)

`refresh()` re-reads from the store — same shape, no file involved.

## Schema field cut: `apiKey`

The `apiKey` field is removed from `ProviderConfigSchema` (`model-registry.ts:191`) and
`ProviderConfigInput` (~line 702). Custom-provider credentials always come from
`provider_credentials` like everyone else's. Concretely:

- `getApiKeyAndHeaders` (568-597): collapses to `apiKey = await authStorage.getApiKey(provider)` +
  verbatim header merge of `model.headers` / `providerConfig.headers` / `modelHeaders`. The
  `providerConfig?.apiKey` branch + `resolveConfigValueOrThrow` + `resolveHeadersOrThrow` go away.
  The `authHeader: true` path keeps working (key comes from the DB, header gets set).
- `getApiKeyForProvider` (599-604) → `authStorage.getApiKey(provider)`.
- `hasConfiguredAuth` (535-539) → `authStorage.hasAuth(model.provider)`. Keyless custom providers
  (local Ollama) behave exactly as today — already excluded from `getAvailable()`; unchanged here.
- `validateConfig` — drop the "`apiKey` is required when defining custom models" rule (454-456).
- `validateProviderConfig` — drop the `!config.apiKey && !config.oauth` requirement (635-636).
- `storeProviderRequestConfig` — drop the `apiKey` field (only `headers` + `authHeader` remain).

`setFallbackResolver` / `resolveCustomProviderApiKey` / the AuthStorage `fallbackResolver` field
all disappear. `AuthStorage.getApiKey` reduces to: api_key cred → verbatim, oauth cred → locked
refresh, else undefined.

## `providers-custom.ts` rewrite

The `swarm providers add --custom` flow today prompts for an `apiKey` field (literal / env / shell),
`!`-prefixes the shell form, and writes the entry into `~/.swarm/models.json`. After this PR:

- Drops the apiKey prompt and the `!`-prefix logic entirely.
- Writes the per-provider config blob to the DB via `store.putProviderConfig(name, configJson, now)`.
- `swarm providers rm <custom>` deletes both the `provider_config` and `provider_credentials` rows
  (atomic — same txn).
- `swarm providers ls --custom` reads from the store.
- The Ajv schema is validated client-side before the write hits the DB (defence in depth; the
  registry also validates on read).

Custom-provider *credentials* go through the normal `swarm providers add <name>` flow into
`provider_credentials`. A custom provider with no key (Ollama) simply doesn't have a row in
`provider_credentials` — behaviour identical to today.

## Deletions

- `packages/agent/src/credentials/resolve-config-value.ts` — the whole file.
- `~/.swarm/models.json` file path; the models half of `paths.ts` (`getModelsPath`,
  `getPiFallbackModelsPath`, `resolveModelsPath`); the entire `bootstrapSwarmHomeFromPi` (both
  halves already gone after the credentials PR + this one). `paths.ts` collapses to
  `getSwarmHome()` only.
- `clearApiKeyCache` / `clearConfigValueCache` / `invalidateCommandCache` / `resolveHeaders` /
  `resolveHeadersOrThrow` / `resolveConfigValue*` exports from `packages/agent/src/credentials/`
  barrel.
- `apiKey` field on `ProviderConfigInput`.
- `setFallbackResolver` / `fallbackResolver` field on `AuthStorage`; `{ includeFallback }` option
  param on `getApiKey`; the "models.json custom provider" label in `describeAuthSource`.

After this PR, grep `packages/` for `resolveConfigValue`, `proper-lockfile`, `auth.json`,
`models.json`, `resolveModelsPath`, `bootstrapSwarmHome`, `fallbackResolver`, `clearApiKeyCache`,
`!cmd` — all should be empty.

## Reference: pi-ai schemas

Captured from `node_modules/@mariozechner/pi-ai/dist/` so the implementer doesn't re-discover.

### `Model<Api>` (`types.d.ts:378-397`)
Required: `id`, `name`, `api: Api`, `provider: Provider`, `baseUrl`, `reasoning: boolean`,
`input: ("text"|"image")[]`, `cost: { input, output, cacheRead, cacheWrite }`,
`contextWindow: number`, `maxTokens: number`.
Optional: `headers?: Record<string,string>`, `compat?` (provider-conditional union).

### `Api` literal union (`types.d.ts:3`)
Closed set: `openai-completions | mistral-conversations | openai-responses |
azure-openai-responses | openai-codex-responses | anthropic-messages | bedrock-converse-stream |
google-generative-ai | google-vertex`, plus open `(string & {})` for `registerApiProvider`
extensions. **Do not `CHECK` in SQL** — extensible.

### `KnownProvider` (`types.d.ts:5`) — 27 built-ins
- Direct API: anthropic, openai, google, google-vertex, mistral, groq, cerebras, xai, deepseek,
  huggingface, fireworks, openrouter, zai.
- OpenAI-compatible: openai-codex, azure-openai-responses, minimax, minimax-cn, moonshotai,
  moonshotai-cn, opencode, opencode-go.
- Other: amazon-bedrock, github-copilot, kimi-coding, cloudflare-workers-ai,
  cloudflare-ai-gateway, vercel-ai-gateway.

### Compat objects (`types.d.ts:241-298`)
Keep as JSON blob — too many nested optional fields to normalise. Named enums worth validating at
the app layer (Ajv handles this for the `provider_config` blob):

- `OpenAICompletionsCompat`: `maxTokensField ∈ {max_completion_tokens, max_tokens}`,
  `cacheControlFormat ∈ {anthropic}`,
  `thinkingFormat ∈ {openai, openrouter, deepseek, zai, qwen, qwen-chat-template}`, plus a long
  list of boolean flags (`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`,
  `supportsUsageInStreaming`, `supportsStrictMode`, `supportsLongCacheRetention`,
  `sendSessionAffinityHeaders`, `requiresToolResultName`, `requiresAssistantAfterToolResult`,
  `requiresThinkingAsText`, `requiresReasoningContentOnAssistantMessages`, `zaiToolStream`), plus
  `reasoningEffortMap: Partial<Record<ThinkingLevel, string>>`, and the nested
  `openRouterRouting` / `vercelGatewayRouting` objects.
- `OpenAIResponsesCompat`: `sendSessionIdHeader`, `supportsLongCacheRetention`.
- `AnthropicMessagesCompat`: `supportsEagerToolInputStreaming`, `supportsLongCacheRetention`.

`OpenRouterRouting` (closed enum `data_collection ∈ {deny, allow}`) and `VercelGatewayRouting` are
nested objects under compat — keep nested.

`ThinkingLevel ∈ {minimal, low, medium, high, xhigh}` is request-time, not provider config.

### `registerApiProvider` (`api-registry.d.ts:4-14`)
Programmatic-only: takes `{ api, stream, streamSimple }` where `stream` / `streamSimple` are
functions, not persistable. `provider_config` rows persist only the **declarative** fields
(`baseUrl`, `headers`, `compat`, `models`, `modelOverrides`); programmatic registration via swarm
extensions is a separate axis and remains code-level.

### `OAuthProviderInterface` (`utils/oauth/types.d.ts:27-40`)
`{ id, name, login, refreshToken, getApiKey, modifyModels?, usesCallbackServer? }` — entirely
programmatic, never persisted by pi-ai. Only the *credentials* persist (in
`provider_credentials` from the credentials PR); the provider definition is code.

### pi-ai credential handling (`env-api-keys.js:79-164`)
No central store. Callers pass `apiKey?` via `StreamOptions` per request. `getEnvApiKey(provider)`
maps to env vars (anthropic → `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`; openai →
`OPENAI_API_KEY`; bedrock → AWS chain; google-vertex → `GOOGLE_CLOUD_API_KEY` or ADC; etc.).
Swarm replaces this entirely with `AuthStorage.getApiKey` reading from `provider_credentials`.

### `SimpleStreamOptions` (`types.d.ts:84-88`)
Extends `StreamOptions` with `reasoning?: ThinkingLevel`, `thinkingBudgets?`. Request-time, not
config-time.

## Risks / open questions

- **`api` and `provider` strings are extensible** — no SQL `CHECK` on either. Validation lives at
  the app layer (Ajv).
- **Per-row Ajv validation** is strictly better than today's file-level all-or-nothing parse.
- **Keyless custom providers** (Ollama) — unchanged behaviour: already excluded from
  `getAvailable()` today; this PR doesn't address that.
- **One-time `models.json` importer?** Recommendation: **no**. Pre-release, ground rule 11
  (no backwards-compat). Users re-run `swarm providers add --custom`. Acceptable, simpler PR.
- **Programmatic `registerProvider` callers** in tests / extensions — `ProviderConfigInput.apiKey`
  goes away; the `apiKey || oauth` validation rule relaxes (the key now comes from the DB,
  independent of provider registration).
- **Headers become verbatim literals** — `resolveHeadersOrThrow` is gone, so any header value with
  `!cmd` or `$ENV` in `models.json` stops resolving. Affected users get explicit literals or move
  the secret to `provider_credentials` + `authHeader: true`. Document in release notes.

## Tests + docs

- New `packages/store/test/provider-config.test.ts`: upsert/get/list/delete; migration test
  (previous-version DB → new version, table exists).
- `packages/agent/test/model-registry.test.ts` (or equivalent) — store-backed `loadCustomModels`:
  seed `provider_config` rows, build the registry, assert custom models surface; per-row Ajv
  validation errors land in `loadError` without poisoning sibling rows.
- Rewrite `packages/agent/test/auth-fallback.test.ts` (the `fallbackResolver` path is gone) and
  `packages/cli/test/providers-custom.test.ts` (replaces `models.json` write assertions with
  `provider_config` row assertions).
- Same-PR doc obligations per CLAUDE.md: `ARCHITECTURE.md` §2 (new table) + §7 (custom-provider
  storage description); `README.md` (drop `models.json` mentions; explain custom providers now
  live in the store); `STATUS.md` if user-visible;
  `.agents/skills/swarm-debug/SKILL.md` (post-mortems read `provider_config`);
  `.agents/skills/swarm-run/SKILL.md` (pre-flight).

## Verification (manual)

1. After landing the credentials PR, the legacy `~/.swarm/models.json` is still on disk and still
   read. Confirm `swarm providers ls --custom` shows the file-backed entries.
2. Land this PR. `swarm providers add --custom` no longer prompts for an `apiKey` field; on
   completion, `sqlite3 ~/.swarm/swarm.db 'select provider, length(config) from provider_config'`
   shows a new row; `~/.swarm/models.json` is not touched.
3. Add a credential separately: `swarm providers add my-ollama` (or skip if keyless).
4. Run a workflow targeting a custom model. Codergen authenticates with the DB-stored key (if any)
   + verbatim header merge from the `provider_config` blob.
5. Manually corrupt one provider's `config` (`UPDATE provider_config SET config='{"oops":true}'
   WHERE provider='broken'`). Restart daemon → only the broken provider is missing from the
   registry; the others load. `loadError` surfaces the broken one.
6. Grep `packages/` for `resolveConfigValue`, `proper-lockfile`, `auth.json`, `models.json`,
   `resolveModelsPath`, `bootstrapSwarmHome`, `fallbackResolver`, `clearApiKeyCache` — all empty.
