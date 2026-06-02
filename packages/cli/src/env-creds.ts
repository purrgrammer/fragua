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

// ---------------------------------------------------------------------------
// CI env secret capture
// ---------------------------------------------------------------------------

/** Name suffixes that mark an env var as a likely secret (default-deny list).
 * Only names matching one of these suffixes (or in the known-provider-var set)
 * are captured as needles. Everything else is NOT a needle.
 *
 * Matching is case-insensitive (checked via name.toUpperCase()). Do NOT add
 * broad suffixes like _URL — DATABASE_URL is covered by the conn_string_userinfo
 * pattern; a blanket _URL would over-strip non-secret variables. */
const CI_ENV_SECRET_SUFFIXES = [
  "_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
  "_CREDENTIAL",
  "_PASS",
  "_AUTH",
  "_PASSPHRASE",
] as const;

/** Build the set of known provider env-var names from pi-ai's registry.
 * Memoised: called once at capture time, not on every check. */
function knownProviderVarNames(): Set<string> {
  const names = new Set<string>();
  for (const provider of getProviders()) {
    for (const name of findEnvKeys(provider) ?? []) {
      // Apply the same COPILOT_AMBIENT_ENV denial as seedCredsFromEnv so we
      // don't accidentally admit GH_TOKEN / GITHUB_TOKEN as needles when the
      // caller hasn't set COPILOT_GITHUB_TOKEN.
      if (!COPILOT_AMBIENT_ENV.has(name)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** Returns true when an env var NAME indicates it is secret, regardless
 * of the value. Shared predicate for both `captureCiEnvSecrets` (which
 * also checks the value is non-empty) and `ciEnvDenyNames` (strip by
 * name unconditionally — an attacker could set the var later). */
function isSecretEnvName(name: string, providerVars: Set<string>): boolean {
  const upper = name.toUpperCase();
  const isSecretSuffix = CI_ENV_SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix));
  const isProviderVar = providerVars.has(name);
  return isSecretSuffix || isProviderVar;
}

/**
 * Capture env entries whose NAME indicates a secret (default-deny by name).
 * Returns `{ name, value }` pairs; empty values are excluded. The registry's
 * own value-length floor (8 chars + no whitespace) handles very-short values.
 *
 * Rules (applied in order):
 *  1. Name suffix matches one of `CI_ENV_SECRET_SUFFIXES`.
 *  2. Name appears in the pi-ai known-provider-var set (minus COPILOT_AMBIENT_ENV).
 * Default-DENY: names that match neither rule are NOT captured regardless of
 * their value (GITHUB_REPOSITORY, NODE_ENV, PATH, etc.).
 *
 * @param env - defaults to `process.env`; injectable for tests.
 */
export function captureCiEnvSecrets(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; value: string }> {
  const providerVars = knownProviderVarNames();
  const result: Array<{ name: string; value: string }> = [];
  let skipped = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (!isSecretEnvName(name, providerVars)) continue;
    if (value.length < 8 || /\s/.test(value)) {
      skipped++;
      continue;
    }
    result.push({ name, value });
  }
  if (skipped > 0) {
    console.error(`fragua: ${skipped} secret env var(s) skipped (value below scrub floor — will NOT be scrubbed)`);
  }
  return result;
}

/**
 * Build the set of env var NAMES that should be stripped from bash-tool
 * subprocesses in `fragua ci` (proposal §6 unit 9b — perimeter env-strip).
 *
 * Uses the same predicate as `captureCiEnvSecrets` so the strip set ≡ the
 * scrub-needle name set ("one list, two consumers"). Unlike `captureCiEnvSecrets`,
 * empty-value vars ARE included — the strip is name-based, unconditional,
 * because an attacker could later assign a value to a secret-named var.
 *
 * `allow` names (from `fragua ci --allow-env`) are exempted from the strip so a
 * workflow's deterministic tool steps can reach them (e.g. `gh` needs GH_TOKEN).
 * This affects ONLY the strip — an allowed var is NOT removed from the tool
 * subprocess env, but it is STILL captured as a scrub needle (`captureCiEnvSecrets`
 * is deliberately unaffected), so its value is redacted from the exported bundle.
 * Allow ≠ declassify. Provider-credential names must NEVER be allowed through —
 * guard with {@link unsafeAllowEnvNames} at the call site before passing them here.
 *
 * @param env - defaults to `process.env`; injectable for tests.
 * @param allow - names kept OUT of the deny set so they reach tool steps; still
 *   scrubbed from the exported bundle. Default: none.
 */
export function ciEnvDenyNames(
  env: NodeJS.ProcessEnv = process.env,
  allow: ReadonlySet<string> = NO_ALLOW,
): Set<string> {
  const providerVars = knownProviderVarNames();
  const result = new Set<string>();
  for (const name of Object.keys(env)) {
    if (allow.has(name)) continue;
    if (isSecretEnvName(name, providerVars)) result.add(name);
  }
  return result;
}

/**
 * Returns a PREDICATE `(name: string) => boolean` that returns `true` when an
 * env var name should be stripped from a bash subprocess. Uses the same rule
 * as `ciEnvDenyNames` / `captureCiEnvSecrets` (`isSecretEnvName`) so strip
 * and needle-set share one definition.
 *
 * Unlike `ciEnvDenyNames` (a Set captured at call time), this predicate is
 * applied at SPAWN TIME against the live env, catching any secret-named var
 * set AFTER the Set was built. The provider-var set is memoised in the closure
 * so the predicate is cheap to call on every spawn.
 *
 * @param allow - names kept OUT of the strip so they reach tool steps; still
 *   scrubbed from the exported bundle (allow ≠ declassify). Default: none. See
 *   {@link ciEnvDenyNames} — provider creds must never be allowed through.
 */
export function ciEnvDenyPredicate(allow: ReadonlySet<string> = NO_ALLOW): (name: string) => boolean {
  const providerVars = knownProviderVarNames();
  return (name: string) => !allow.has(name) && isSecretEnvName(name, providerVars);
}

/** Shared empty allow-set so the default path allocates nothing. */
const NO_ALLOW: ReadonlySet<string> = new Set();

/**
 * Validate a `--allow-env` request: return the names that must NOT be exempted
 * from the CI env-strip. A provider-credential var (e.g. `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_OAUTH_TOKEN`) must never reach a tool subprocess — fragua reads it
 * directly for the provider, and a public/team-readable bundle is an
 * exfiltration target. Generic `*_TOKEN` / `*_KEY` secrets (GH_TOKEN, …) ARE
 * allowed through — that's the flag's purpose. The caller refuses the run when
 * this returns a non-empty list.
 */
/**
 * Provider-credential env names refused regardless of whether pi-ai's provider
 * registry is loaded. `knownProviderVarNames()` is registration-gated — empty
 * early in `fragua ci` and in unit tests — so the rail can't rely on it alone.
 * These are the LLM-provider creds fragua reads directly; they must never reach
 * a tool subprocess. (`_API_KEY` covers the shape virtually every provider key
 * follows; the explicit names cover non-`_API_KEY` creds like the OAuth token.)
 */
const ALWAYS_PROVIDER_CRED: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]);

export function unsafeAllowEnvNames(allow: Iterable<string>): string[] {
  const providerVars = knownProviderVarNames();
  const bad: string[] = [];
  for (const name of allow) {
    const upper = name.toUpperCase();
    // dynamic registry (prod) ∪ static critical set ∪ the `*_API_KEY` shape. The
    // legitimate allow case is CI platform tokens (GH_TOKEN, …) which end in
    // _TOKEN, never _API_KEY, so they pass.
    if (providerVars.has(name) || ALWAYS_PROVIDER_CRED.has(upper) || upper.endsWith("_API_KEY")) {
      bad.push(name);
    }
  }
  return bad;
}

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
