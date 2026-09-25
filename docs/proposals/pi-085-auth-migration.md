---
title: Migrating fragua off the pi-ai OAuth registry (pi-ai ≥ 0.85)
summary: "pi-ai 0.80.8 removed the global OAuth registry (getOAuthProvider / getOAuthApiKey / registerOAuthProvider / resetOAuthProviders / OAuthProviderInterface) that fragua's credential layer is built on; by 0.85.1 the `/oauth` subpath is type-only. The registry is replaced by per-provider `ProviderAuth { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }` attached to each `Provider`, a `CredentialStore` port, and `Models.getAuth(model)` as the single request-auth resolver. This sketches how fragua's four call sites move to that architecture, in small PRs, once we bump past 0.80.7."
status: implemented
maturity: sketch
last-reviewed: 2026-07-29
---

> Status: implemented. The pin was bumped straight to **0.87.1** (pi-ai +
> pi-agent-core, lockstep) and the auth layer migrated to the per-provider
> `ProviderAuth` architecture sketched below. The migration was smaller than
> the 6-PR plan in §5 — the four call sites moved in one change:
>
> - `AuthStorage` (`packages/agent/src/credentials/auth-storage.ts`) resolves
>   the login-capable providers from `builtinProviders()` (`Provider.auth.oauth`)
>   instead of the removed global registry, and keeps its own per-row store lock
>   rather than routing through `Models.getAuth()`: login calls
>   `oauth.login(interaction)`, refresh calls `oauth.refresh(cred, signal)`, and
>   the access token comes from `oauth.toAuth(cred).apiKey`.
> - `ModelRegistry` dropped the `modifyModels` post-login model rewrite (its
>   **Open** successor question): 0.87.1 models are static per provider and OAuth
>   only changes request auth, so no model-list mutation is needed. The unused
>   programmatic `ProviderConfigInput.oauth` registration field was dropped with
>   it (nothing in fragua wired a custom OAuth provider).
> - The CLI login (`packages/cli/src/commands/providers.ts`) moved from the
>   legacy `OAuthLoginCallbacks` to the new `AuthInteraction` (`prompt`/`notify`).
> - `mcp/oauth.ts` is a separate MCP-client subsystem and was left untouched.
>
> The authorize-URL health (issue #74) is pinned by
> `packages/agent/test/oauth-authorize-url.test.ts`.

## 1. Why this exists

fragua's credential layer resolves per-request auth (API keys and OAuth access
tokens) through pi-ai's **global OAuth registry**: a process-wide table of
login-capable providers, populated by `registerOAuthProvider` and read by
`getOAuthProvider` / `getOAuthProviders` / `getOAuthApiKey`.

pi-ai **0.80.8** removed that registry. **0.80.7** is the last version that
still ships it (on the `/oauth` subpath), so that is where fragua is currently
pinned (see the 0.79.1 → 0.80.7 bump). The catalogue/streaming functions
(`getModels`, `getProviders`, `streamSimple`, `registerApiProvider`,
`registerFauxProvider`, …) also moved out of the main entry point at 0.80.x,
but pi-ai preserves them on a `@earendil-works/pi-ai/compat` shim — the
0.80.7 bump switched fragua's value imports to `/compat` and is unaffected by
this proposal. The OAuth registry has **no** compat shim; it is genuinely gone.

By **0.85.1**:

- `@earendil-works/pi-ai/oauth` is **type-only** — it re-exports
  `OAuthLoginCallbacks`, `OAuthCredentials`, and a few prompt/info types from a
  `compat/extension-oauth-types` module, and nothing else. `utils/oauth/` (the
  runtime registry) no longer exists in the package.
- `OAuthProviderId` and `OAuthProviderInterface` — two types fragua imports —
  are **no longer exported** at all. Provider identity is now a plain
  `string` (`Provider.id`).
- `@earendil-works/pi-ai/compat` still bridges the catalogue/streaming
  functions, but its own header says it "is deleted with the coding-agent
  ModelManager migration" — a runway, not a home.

So the migration is scoped precisely to **auth**: the catalogue reads can stay
on `/compat` for now; the OAuth registry calls must move to the new
architecture before we can bump past 0.80.7.

## 2. What replaced the registry

pi-ai ≥ 0.80.8 models auth **per provider**, not in a global table. The moving
parts (from `dist/models.d.ts` and `dist/auth/*.d.ts` at 0.85.1):

### 2.1 `ProviderAuth` on every `Provider`

```ts
interface ProviderAuth {
  apiKey?: ApiKeyAuth;   // stored key + ambient (env vars, AWS profiles, ADC)
  oauth?: OAuthAuth;     // subscription / device-code login
}
interface Provider<TApi> {
  readonly id: string;
  readonly auth: ProviderAuth;   // required — at least one of apiKey/oauth
  getModels(): readonly Model<TApi>[];
  streamSimple(model, context, options?): AssistantMessageEventStream;
  // …
}
```

`OAuthAuth` carries the login/refresh behaviour that `OAuthProviderInterface`
used to, but scoped to one provider and split so `Models` owns the locked
refresh:

```ts
interface OAuthAuth {
  name: string;
  isSubscription?: boolean;
  loginLabel?: string;
  login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
  toAuth(credential: OAuthCredential): Promise<ModelAuth>;   // credential → { apiKey?, headers?, baseUrl? }
}
```

### 2.2 `CredentialStore` — the app-owned persistence port

```ts
interface CredentialStore {
  read(providerId, options?): Promise<Credential | undefined>;
  list(options?): Promise<readonly CredentialInfo[]>;
  modify(providerId, fn: (current) => Promise<Credential | undefined>, options?): Promise<Credential | undefined>;
  delete(providerId, options?): Promise<void>;
}
type Credential = ApiKeyCredential | OAuthCredential;  // type-tagged, one per provider
```

`modify` is the **only** write path — a serialized read-modify-write per
provider id. This is exactly the invariant fragua's `AuthStorage` already
enforces with its `withLock` / `withLockAsync` backend; the port is a close
structural match to what fragua built by hand.

### 2.3 `Models` — the collection + auth resolver

```ts
function createModels(options?: { credentials?: CredentialStore; authContext?: AuthContext }): MutableModels;
interface Models {
  getProviders(): readonly Provider[];
  getProvider(id): Provider | undefined;
  getModels(provider?): readonly Model<Api>[];
  getModel(provider, id): Model<Api> | undefined;
  getAuth(model): Promise<AuthResult | undefined>;   // resolves key/headers, runs locked OAuth refresh
  streamSimple(model, context, options?): AssistantMessageEventStream;
  // …
}
interface MutableModels extends Models { setProvider(p): void; deleteProvider(id): void; clearProviders(): void; }
```

`Models.getAuth(model)` is the single replacement for
`getOAuthApiKey(...)` + `provider.getApiKey(cred)` + the per-request header
merge. It runs the OAuth refresh **inside** `CredentialStore.modify`, so two
concurrent requests can't double-refresh a rotated token — the property
fragua's `refreshOAuthTokenWithLock` implements today.

Login is **app-owned**: pi-ai no longer runs the flow through a registry.
The app calls `providerAuth.oauth.login(interaction)` (or `.apiKey.login`),
then persists the returned credential with
`credentials.modify(provider.id, async () => credential)`. Interaction is a
single `AuthInteraction { prompt(AuthPrompt), notify(AuthEvent) }` callback
surface, replacing the old `OAuthLoginCallbacks` bag of `onAuth` / `onDeviceCode`
/ `onSelect` / `onPrompt` / `onProgress` / `onManualCodeInput`.

## 3. fragua's four call sites

### 3.1 `packages/agent/src/credentials/auth-storage.ts`

Today: `AuthStorage` wraps a `SqliteAuthStorageBackend` (the
`provider_credentials` table) and imports from `/oauth`:
`getOAuthProvider`, `getOAuthApiKey`, `getOAuthProviders`, plus types
`OAuthProviderId`, `OAuthLoginCallbacks`, `OAuthCredentials`.

- **`login(providerId, callbacks)`** → resolve the provider's `OAuthAuth`
  (`models.getProvider(id)?.auth.oauth`), call `.login(interaction)`, persist via
  the credential store. `OAuthLoginCallbacks` → the new `AuthInteraction`.
- **`getApiKey(providerId)` / `refreshOAuthTokenWithLock`** → collapse into a
  path backed by `Models.getAuth(model)`, or reimplement the locked refresh
  with `OAuthAuth.refresh` + `toAuth` inside our own `modify`. Note the auth
  resolver is now **model-scoped** (`getAuth(model)`), not provider-scoped —
  see open question (a).
- **`getOAuthProviders()`** → `models.getProviders().filter(p => p.auth.oauth)`.
- **`OAuthProviderId` → `string`**; **`OAuthProviderInterface` → `OAuthAuth`**
  (both former types are gone at 0.85.1). `OAuthLoginCallbacks` /
  `OAuthCredentials` still exist as compat types but the canonical stored
  shape is now `OAuthCredential` (`{ type: "oauth", access, refresh, expires }`).

The cleanest end state: make `AuthStorage`'s backend **implement pi-ai's
`CredentialStore`** (its `modify`/`read`/`list`/`delete` map 1:1 onto our
`provider_credentials` transactions), hand it to `createModels({ credentials })`,
and delete fragua's hand-rolled refresh in favour of `Models.getAuth`.

### 3.2 `packages/agent/src/credentials/model-registry.ts`

Today: builds the catalogue from `getProviders()` + `getModels()` (now via
`/compat`), applies `provider_config` overrides, and in `applyProviderConfig`
registers custom providers with `registerApiProvider` and custom OAuth with
`registerOAuthProvider` / `resetOAuthProviders` (from `/oauth`). It also holds
`OAuthProviderInterface` in `ProviderConfigInput.oauth`.

- The global registration model (`registerApiProvider` / `registerOAuthProvider`
  / `resetApiProviders` / `resetOAuthProviders`) is replaced by building
  `Provider` objects (`createProvider({ id, auth, models, api })`) and
  registering them on a `MutableModels` via `setProvider` / `deleteProvider` /
  `clearProviders`. `ModelRegistry` grows a `MutableModels` instead of mutating
  process-global state, which also removes the `resetApiProviders()` /
  `resetOAuthProviders()` global-reset hazard on `refresh()`.
- `ProviderConfigInput.oauth: Omit<OAuthProviderInterface, "id">` →
  `Omit<OAuthAuth, never>` (an `OAuthAuth` sans the identity, since identity is
  now `Provider.id`). `modifyModels` (the old registry hook fragua calls in
  `loadModels`) has no direct successor — see open question (c).
- `streamSimple`/`SimpleStreamOptions` continue to work via the provider's own
  `streamSimple`, or stay on `/compat` for the transition.

This is the largest site — it owns the whole custom-provider surface — and
should be split across at least two PRs (see §5).

### 3.3 `packages/cli/src/commands/providers.ts`

Today: `providersLoginCommand` builds an `OAuthLoginCallbacks` object with six
`on*` handlers and calls `auth.login(provider, callbacks)`;
`auth.getOAuthProviders()` drives the provider picker; `streamSimple` (now
`/compat`) runs the test probe.

- The six `on*` callbacks collapse into one `AuthInteraction`:
  `prompt(AuthPrompt)` (covers `text` / `secret` / `select` / `manual_code`)
  and `notify(AuthEvent)` (covers `info` / `auth_url` / `device_code` /
  `progress`). Mechanical but user-visible — every prompt/notify string moves.
- `auth.getOAuthProviders()` still works if §3.1 keeps that helper (now a
  filter over `models.getProviders()`).

### 3.4 `packages/server/src/routes/providers.ts`

Today: `rebuildOauthIds()` calls `authStorage.getOAuthProviders()` to compute
`oauth_available` per provider; everything else is structural (`RegisteredModel`
derived from `ModelRegistry["find"]`). No value import of pi-ai.

- Smallest site. As long as §3.1 keeps a `getOAuthProviders()`-shaped helper
  (or exposes "does this provider have OAuth login" some other way), this route
  needs no change beyond whatever the helper's return type becomes. Keep the
  `oauth_available` field and the "never return the stored key" rule intact.

## 4. The store-backed MCP OAuth provider (`packages/workspace/src/mcp/oauth.ts`)

**Not affected.** `StoredOAuthProvider` implements
`@modelcontextprotocol/sdk`'s `OAuthClientProvider` for remote MCP servers —
it is the OAuth *client* for MCP transports, keyed by server URL, persisting an
opaque blob through the `McpOAuthStore` port. It has no dependency on pi-ai's
provider/OAuth types and is untouched by this migration. It is called out here
only to record that the two OAuth subsystems are independent: the pi-ai auth
change touches **LLM provider credentials**, not **MCP server credentials**.

## 5. Migration plan (small PRs)

Each PR is independently green (`bun run ci`), spec-first, and does not bump the
pin until the last one.

1. **PR 1 — `CredentialStore` adapter (no version bump).** Add a thin adapter
   that implements pi-ai 0.85's `CredentialStore` over the existing
   `provider_credentials` transactions, with property tests for the
   `modify` read-modify-write and per-provider serialization. Pure addition;
   nothing consumes it yet. (Can land while still on 0.80.7 by targeting the
   structural shape.)
2. **PR 2 — `Models`-backed catalogue behind a flag.** Introduce a
   `createModels()` + `setProvider` path inside `ModelRegistry` alongside the
   current `/compat` catalogue reads, gated so behaviour is identical.
   Custom-provider registration moves to `createProvider` + `setProvider`.
3. **PR 3 — auth resolution through `Models.getAuth`.** Rewire
   `AuthStorage.getApiKey` / `getApiKeyAndHeaders` to `Models.getAuth(model)`,
   deleting `refreshOAuthTokenWithLock`. Reconcile the provider-scoped →
   model-scoped resolution shift (open question a).
4. **PR 4 — login flow → `AuthInteraction`.** Convert
   `providersLoginCommand`'s `OAuthLoginCallbacks` to the single
   `AuthInteraction` surface; update the server `oauth_available` helper.
5. **PR 5 — bump `@earendil-works/pi-ai` + `pi-agent-core` to ≥ 0.85, drop the
   `/oauth` imports, keep catalogue reads on `/compat`.** This is the PR that
   removes the last `@earendil-works/pi-ai/oauth` import; the four call sites
   are already on the new API, so it is a pin change plus deletions.
6. **PR 6 (later) — leave `/compat`.** Move the catalogue/streaming reads off
   `/compat` onto `providers/all` + `Models`, so a future compat removal can't
   strand fragua. Not blocking the auth migration.

## 6. Open questions

a. **Provider-scoped vs model-scoped auth.** fragua resolves auth **per
   provider** (`getApiKey(provider)`); pi-ai 0.85 resolves **per model**
   (`getAuth(model)`). For api-key and today's OAuth providers the resolution is
   provider-uniform, so a representative model per provider suffices — but
   confirm no built-in provider's `toAuth` is genuinely model-dependent before
   assuming provider-scope, and decide whether fragua's provider-scoped API
   surface (CLI `providers test <provider>`, server routes) keeps its shape.

b. **`describeAuthSource` / status UI.** `AuthResult.source` ("ANTHROPIC_API_KEY",
   "OAuth", "~/.aws/credentials") and `ApiKeyAuth.check` supersede fragua's
   `describeAuthSource`. Decide whether to surface pi-ai's richer `source`
   string in the CLI/`/providers` response or keep the current two-value
   ("stored api_key" / "stored oauth") vocabulary.

c. **`modifyModels` successor.** `ModelRegistry.loadModels` calls the old
   registry hook `oauthProvider.modifyModels(models, cred)` to let an OAuth
   provider adjust the visible model list post-login (e.g. subscription tiers).
   `OAuthAuth` has no `modifyModels`. Determine whether this is now the
   provider's `refreshModels()` responsibility, or whether the built-in
   providers fold it in, and what fragua loses if we drop it.

d. **Ambient credentials.** `ApiKeyAuth.resolve` merges stored key **and**
   ambient sources (env vars, AWS profiles, ADC files) — fragua deliberately
   cut `!cmd`/env-var indirection and stores keys verbatim. Decide whether to
   let pi-ai's ambient resolution back in (it changes where a key can come
   from) or supply an `AuthContext` that reports no ambient sources to preserve
   "the store is the only credential surface".

e. **`pi-agent-core` coupling.** Confirm whether the `Agent` / steering-queue
   surface in `pi-agent-core` moves in lockstep with these pi-ai versions, and
   whether ≥ 0.85 forces any change in `@fragua/agent`'s backend beyond auth.

f. **Custom-provider `provider_config` schema.** `ProviderConfigInput.oauth`
   and the TypeBox `ProviderConfigSchema` mirror pi-ai's compat shapes. Decide
   the persisted-schema migration story for any `provider_config` row that
   encodes an OAuth block in the old `OAuthProviderInterface` shape.
