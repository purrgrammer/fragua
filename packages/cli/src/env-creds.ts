// env → store credential bridge. `fragua ci` runs against an ephemeral store
// with no `fragua providers add` history, so it seeds the store's
// `provider_credentials` rows from the conventional credential env vars before
// the executor assembly reads them. Store-backed resolution then runs
// unchanged — this is a one-time seed, not a new resolution path on
// AuthStorage.
//
// We seed *every* provider pi-ai knows an env var for (`getProviders()` is the
// full registry), not a curated subset — anything pi-ai can route to, CI can
// authenticate. The env→var map and provider list are pi-ai's own, so CI and
// the rest of the ecosystem agree on which variable feeds which provider.
//
// One credential type covers everything. `getEnvApiKey` returns whatever the
// provider needs as a bare string: a raw API key, or an OAuth access token
// (e.g. `ANTHROPIC_OAUTH_TOKEN`, which pi-ai prefers over `ANTHROPIC_API_KEY`).
// The provider decides the wire auth scheme from the value — the anthropic
// provider switches to Bearer + Claude-Code identity headers when it sees the
// `sk-ant-oat` OAuth prefix — so a single `api_key` row carries both. Env can
// only supply a bare access token (no refresh material), so `oauth`-typed
// rows, which exist to drive token refresh, are never the right shape here.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { AuthStorage } from "@fragua/agent";
import { type IProviderCredentialStore, SqliteStore } from "@fragua/store";
import { findEnvKeys, getEnvApiKey, getProviders } from "@mariozechner/pi-ai";

// pi-ai's github-copilot env fallback includes the generic GH_TOKEN /
// GITHUB_TOKEN, which are set in virtually every GitHub Actions job for the
// `gh` CLI and have nothing to do with Copilot. Seeding copilot from one of
// those would register a bogus provider, so we only honor copilot when its
// dedicated COPILOT_GITHUB_TOKEN is what resolved.
const COPILOT_AMBIENT_ENV = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

/**
 * Seed `store`'s `provider_credentials` rows from the conventional credential
 * env vars. Returns the providers that were seeded (had a usable token in
 * env), so the caller can surface "running against anthropic (from env)" or
 * warn when nothing resolved.
 */
export function seedCredsFromEnv(store: IProviderCredentialStore): string[] {
  const auth = AuthStorage.fromStore(store);
  const seeded: string[] = [];
  for (const provider of getProviders()) {
    const key = getEnvApiKey(provider);
    // `<authenticated>` is the ambient-credential sentinel (Bedrock AWS
    // profile / Vertex ADC) — not a literal token, so it can't be stored as
    // an api_key row. Those need their own bridge if CI ever targets them.
    if (!key || key === "<authenticated>") continue;
    if (provider === "github-copilot") {
      const sources = findEnvKeys(provider) ?? [];
      if (sources.every((s) => COPILOT_AMBIENT_ENV.has(s))) continue;
    }
    auth.set(provider, { type: "api_key", key });
    seeded.push(provider);
  }
  return seeded;
}

/**
 * Seed `target` from the GLOBAL store's configured providers — what `fragua
 * providers add` wrote into `~/.fragua/fragua.db`. This is what makes local
 * `fragua ci` "just work": without it, ci sees only env vars and ignores the
 * creds you already configured.
 *
 * It RESOLVES each provider's token against the global store and seeds `target`
 * with the bare token as an `api_key` — it does NOT copy raw credential rows.
 * That distinction is load-bearing for OAuth: refreshing an OAuth token ROTATES
 * the refresh token. If we copied the OAuth row into the ephemeral ci store and
 * it refreshed there, the rotated token would land in the ephemeral store (and
 * vanish with the temp dir) while the global store kept the now-dead one —
 * silently breaking the daemon's creds. Resolving here means any refresh happens
 * IN the global store (rotation persists where the daemon reads it), under the
 * same per-row lock the daemon uses; the ephemeral store only ever holds an
 * immutable bare token that can't rotate anything. Custom-provider definitions
 * (`provider_config`) are copied as-is — they carry no rotating secret.
 *
 * A no-op when there's no global store (a fresh CI machine), so ci falls back to
 * env-only there. Layer `seedCredsFromEnv` AFTER this so an env/CI secret
 * overrides a configured provider (env wins). Returns the providers seeded.
 */
export async function seedCredsFromGlobalStore(
  target: SqliteStore,
  targetPath: string,
  globalPath: string = resolve(homedir(), ".fragua/fragua.db"),
): Promise<string[]> {
  // No global store (CI), or ci was pointed AT the global store (--db) so the
  // creds are already present — nothing to copy.
  if (!existsSync(globalPath) || resolve(targetPath) === resolve(globalPath)) return [];
  const source = new SqliteStore({ path: globalPath, migrate: false });
  try {
    const from = AuthStorage.fromStore(source);
    const to = AuthStorage.fromStore(target);
    const seeded: string[] = [];
    for (const provider of from.list()) {
      // Resolves an api_key verbatim, or an OAuth access token (refreshing in
      // the GLOBAL store when expired — see the rotation note above).
      const key = await from.getApiKey(provider);
      if (!key || key === "<authenticated>") continue;
      to.set(provider, { type: "api_key", key });
      seeded.push(provider);
    }
    // Custom-provider definitions (Ollama / vLLM / proxies) live in
    // provider_config, separate from the credential rows. listProviderConfigs
    // returns parsed JSON; upsert wants a serialised string (I1 — the
    // stringify happens here, outside any write txn), so re-encode.
    for (const row of source.listProviderConfigs()) {
      target.upsertProviderConfig({ provider: row.provider, config: JSON.stringify(row.config) });
    }
    return seeded;
  } finally {
    source.close();
  }
}
